'use strict';
/**
 * Azure DevOps client.
 *
 * THIS IS THE ONLY MODULE IN THE EXTENSION THAT USES THE NETWORK. scripts/verify-package.sh allows `fetch(` here and
 * nowhere else, and the extension never calls it unless the person has turned Azure DevOps on (aiDeliveryInsights.ado.enabled).
 *
 * Rules this file keeps, each covered by a test:
 *   - Requests go to https://dev.azure.com/<organisation>/... and nowhere else. The organisation is validated and the final
 *     URL's origin is checked, so a setting or a response can never point a request (or the token) at another host.
 *   - Redirects are never followed (a redirect is how a sign-in page appears; the token would travel with it).
 *   - The token is obtained fresh for each request from `auth()`, goes only into the Authorization header, is never stored
 *     here, and is removed from any error text.
 *   - Everything that comes back is untrusted data: sizes are capped, JSON must parse, and values are cleaned before use.
 *   - Only the calls listed in the README's "Azure DevOps" section are made: read projects, read work items, and create or
 *     update one Task per story (the tracking task). Nothing is ever deleted.
 *
 * Plain Node (global fetch), so it can be tested with a stand-in Azure DevOps and no VS Code.
 */

const { cleanText, decodeEntities } = require('./text.js');

const HOST = 'https://dev.azure.com';
const API = '7.1';
const TRACKING_TAG = 'copilot-lens';
const TRACKING_TITLE = 'Copilot Lens usage';
const TRACKING_TYPE = 'Task';
// Long text fields are not asked for: a story's description and acceptance criteria are not used, and only the tracking Task's own
// description is read (in a second, one-item request), because that is where the report is.
const STORY_FIELDS = [
  'System.Id', 'System.Title', 'System.WorkItemType', 'System.State', 'System.TeamProject', 'System.AreaPath', 'System.IterationPath',
  'System.Tags', 'Microsoft.VSTS.Scheduling.StoryPoints', 'Microsoft.VSTS.Scheduling.Effort', 'Microsoft.VSTS.Scheduling.Size',
];
const TASK_FIELDS = [...STORY_FIELDS, 'System.Description'];
const DEFAULT_STORY_TYPES = ['User Story', 'Product Backlog Item', 'Requirement', 'Issue'];
const LIMITS = { bytes: 5 * 1024 * 1024, ids: 200, stories: 500, retries: 2, retryWaitMs: 10000, timeoutMs: 20000, text: 4000, description: 900000 };

class AdoError extends Error {
  /** kind: invalid | auth | forbidden | notfound | conflict | rate | server | network | timeout | too_large | disabled */
  constructor(kind, message, extra) {
    super(message);
    this.name = 'AdoError';
    this.kind = kind;
    if (extra) { Object.assign(this, extra); }
  }
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

const ORG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;

/**
 * Turn what a person typed into an organisation name: "contoso", "https://dev.azure.com/contoso/",
 * "dev.azure.com/contoso/Project", or "https://contoso.visualstudio.com". Anything else is refused.
 * @returns {{ok:true, org:string} | {ok:false, error:string}}
 */
function parseOrganization(input) {
  const bad = { ok: false, error: 'Enter the name of your Azure DevOps organisation, for example "contoso" or https://dev.azure.com/contoso.' };
  if (typeof input !== 'string') { return bad; }
  let s = input.trim();
  if (!s || s.length > 200 || /[\s\\%@:?#]/.test(s.replace(/^https:\/\//i, ''))) { return bad; }
  s = s.replace(/^https:\/\//i, '');
  let name;
  let m = /^dev\.azure\.com\/([^/]+)(?:\/.*)?$/i.exec(s);
  if (m) { name = m[1]; } else if ((m = /^([A-Za-z0-9-]+)\.visualstudio\.com(?:\/.*)?$/i.exec(s))) { name = m[1]; } else if (!s.includes('/') && !s.includes('.')) { name = s; }
  return name && ORG_RE.test(name) ? { ok: true, org: name } : bad;
}

/** Azure DevOps project names: up to 64 characters, none of \ / : * ? " < > | ; # $ { } , + = [ ], no leading or trailing space or dot. */
function validProject(name) {
  return typeof name === 'string' && name.length >= 1 && name.length <= 64 && name === name.trim() && !/^[._]|\.$/.test(name) && !/[\\/:*?"<>|;#${},+=[\]\u0000-\u001f\u007f]/.test(name);
}

/** A work item type name that is safe to put inside a WIQL string. */
const validTypeName = (t) => typeof t === 'string' && t.length >= 1 && t.length <= 60 && t === t.trim() && !/[\u0000-\u001f\u007f]/.test(t);

const wiqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** A team (board) is addressed by its ID, which is always a GUID, so no name can ever reach a request path. */
const validTeamId = (t) => typeof t === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t);

/** An area path as it goes into a WIQL string: backslash-separated names, no control characters. */
const validAreaPath = (p) => typeof p === 'string' && p.length >= 1 && p.length <= 400 && p === p.trim() && !/[\u0000-\u001f\u007f]/.test(p);

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const posInt = (v) => (Number.isInteger(v) && v >= 1 && v <= 2147483647 ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const tagList = (s) => String(s || '').split(';').map((t) => t.trim()).filter(Boolean);
const lastSegment = (path) => String(path || '').split('\\').pop();

/** The work item number at the end of a link such as https://dev.azure.com/org/_apis/wit/workItems/123. */
function idFromUrl(url) {
  const m = /\/workitems\/(\d{1,10})(?:[/?#]|$)/i.exec(String(url || ''));
  return m ? posInt(Number(m[1])) : null;
}

/** Story points live in a different field in each process template. */
function pointsOf(fields) {
  for (const k of ['Microsoft.VSTS.Scheduling.StoryPoints', 'Microsoft.VSTS.Scheduling.Effort', 'Microsoft.VSTS.Scheduling.Size']) {
    const v = num(fields[k]);
    if (v != null && v > 0) { return v; }
  }
  return null;
}

function normalizeItem(w, keepDescription) {
  if (!w || typeof w !== 'object' || posInt(w.id) == null || !w.fields || typeof w.fields !== 'object') { return null; }
  const f = w.fields;
  return {
    id: w.id, rev: posInt(w.rev) || 0,
    title: cleanText(f['System.Title'], 200), type: cleanText(f['System.WorkItemType'], 60), state: cleanText(f['System.State'], 60),
    project: cleanText(f['System.TeamProject'], 64), areaPath: cleanText(f['System.AreaPath'], 400), iterationPath: cleanText(f['System.IterationPath'], 400),
    iteration: cleanText(lastSegment(f['System.IterationPath']), 100),
    tags: tagList(f['System.Tags']).map((t) => cleanText(t, 60)),
    points: pointsOf(f),
    description: keepDescription && typeof f['System.Description'] === 'string' ? f['System.Description'] : '',
    children: Array.isArray(w.relations) ? w.relations.filter((r) => r && r.rel === 'System.LinkTypes.Hierarchy-Forward').map((r) => idFromUrl(r.url)).filter((x) => x != null) : [],
    parent: Array.isArray(w.relations) ? (w.relations.filter((r) => r && r.rel === 'System.LinkTypes.Hierarchy-Reverse').map((r) => idFromUrl(r.url)).filter((x) => x != null)[0] || null) : null,
  };
}

async function readLimited(res, max) {
  const len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) { throw new AdoError('too_large', 'Azure DevOps sent back more data than AI Delivery Insights will read.'); }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (text.length > max) { throw new AdoError('too_large', 'Azure DevOps sent back more data than AI Delivery Insights will read.'); }
    return text;
  }
  const reader = res.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) { break; }
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch { /* already closed */ } throw new AdoError('too_large', 'Azure DevOps sent back more data than AI Delivery Insights will read.'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {object} opts
 * @param {string} opts.org                      organisation name (validated here)
 * @param {() => Promise<{scheme:'Bearer'|'Basic', token:string}>} opts.auth  returns a token for ONE request; Basic means a personal access token
 * @param {typeof fetch} [opts.fetch]            for tests
 * @param {(line:string) => void} [opts.log]     one line per request: method, path, status, milliseconds. Never headers, bodies or tokens.
 * @param {(ms:number) => Promise<void>} [opts.sleep]  for tests
 */
function createClient(opts) {
  const o = opts || {};
  const parsed = parseOrganization(o.org);
  if (!parsed.ok) { throw new AdoError('invalid', parsed.error); }
  const org = parsed.org;
  const doFetch = o.fetch || globalThis.fetch;
  if (typeof doFetch !== 'function') { throw new AdoError('network', 'This version of VS Code cannot make web requests.'); }
  if (typeof o.auth !== 'function') { throw new AdoError('invalid', 'No sign-in was provided.'); }
  const log = typeof o.log === 'function' ? o.log : () => {};
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : LIMITS.timeoutMs;

  // Text that came back from the server is shown to the person and written to the log, so whatever of the token it echoes is
  // removed first: after HTML entities are decoded and invisible characters dropped (so the token cannot be hidden by either),
  // in the plain, URL-encoded, base64 and base64url forms. Callers redact BEFORE they cut the text short, so a token that
  // straddles the cut cannot leave a readable piece behind.
  const redactor = (secret) => (text) => {
    let t = String(text == null ? '' : text);
    if (secret) {
      t = decodeEntities(t).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, '');
      const b64 = (x) => Buffer.from(x).toString('base64');
      const url64 = (x) => b64(x).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      for (const v of new Set([secret, encodeURIComponent(secret), b64(':' + secret), b64(secret), url64(':' + secret), url64(secret), b64(':' + secret).replace(/=+$/, ''), b64(secret).replace(/=+$/, '')])) { if (v) { t = t.split(v).join('***'); } }
    }
    return t;
  };

  function urlFor(project, pathname, query) {
    if (project != null && !validProject(project)) { throw new AdoError('invalid', 'That project name is not valid.'); }
    const url = new URL(`${HOST}/${encodeURIComponent(org)}${project ? '/' + encodeURIComponent(project) : ''}${pathname}`);
    for (const [k, v] of Object.entries(query || {})) { if (v != null) { url.searchParams.set(k, String(v)); } }
    if (!url.searchParams.has('api-version')) { url.searchParams.set('api-version', API); }
    if (url.origin !== HOST || url.username || url.password || !url.pathname.toLowerCase().startsWith(`/${org.toLowerCase()}/`)) {
      throw new AdoError('invalid', 'Refusing to send a request outside Azure DevOps.');
    }
    return url;
  }

  async function headersFor(extra) {
    const a = await o.auth();
    const token = a && typeof a.token === 'string' ? a.token : '';
    if (!token || token.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(token) || !a || (a.scheme !== 'Bearer' && a.scheme !== 'Basic')) {
      throw new AdoError('auth', 'There is no valid sign-in for Azure DevOps. Connect again.');
    }
    const value = a.scheme === 'Bearer' ? `Bearer ${token}` : `Basic ${Buffer.from(':' + token).toString('base64')}`;
    return { secret: token, headers: { Authorization: value, Accept: 'application/json', 'X-TFS-FedAuthRedirect': 'Suppress', 'User-Agent': 'ai-delivery-insights', ...extra } };
  }

  /** One HTTP call with timeout, no redirects, bounded retries for "slow down" replies, and an error that never contains the token. */
  async function call(method, project, pathname, req) {
    const r = req || {};
    const url = urlFor(project, pathname, r.query);
    const idempotent = method === 'GET' || r.safeToRetry === true;
    let attempt = 0;
    for (;;) {
      const { secret, headers } = await headersFor(r.body !== undefined ? { 'Content-Type': r.contentType || 'application/json' } : {});
      const hide = redactor(secret);
      const started = Date.now();
      let res;
      try {
        res = await doFetch(url.toString(), { method, headers, body: r.body !== undefined ? JSON.stringify(r.body) : undefined, redirect: 'manual', signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined });
      } catch (e) {
        const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
        log(`${method} ${url.pathname} -> ${timedOut ? 'timeout' : 'network error'} (${Date.now() - started} ms)`);
        if (!timedOut && idempotent && attempt < LIMITS.retries) { attempt++; await sleep(500 * attempt); continue; }
        throw new AdoError(timedOut ? 'timeout' : 'network', timedOut ? 'Azure DevOps did not answer in time.' : 'Could not reach Azure DevOps. Check your network connection.');
      }
      log(`${method} ${url.pathname} -> ${res.status} (${Date.now() - started} ms)`);
      if ((res.status === 429 || (res.status === 503 && idempotent)) && attempt < LIMITS.retries) {
        const wait = Math.min(LIMITS.retryWaitMs, Math.max(0, Number(res.headers.get('retry-after')) * 1000) || 1000 * (attempt + 1));
        try { await res.text(); } catch { /* ignore */ }
        attempt++; await sleep(wait); continue;
      }
      return interpret(res, hide);
    }
  }

  async function interpret(res, hide) {
    const status = res.status;
    if (status >= 300 && status < 400) { throw new AdoError('auth', 'Azure DevOps asked to sign in again (it redirected the request). Connect again, or check that your token has not expired.', { status }); }
    let text = '';
    try { text = await readLimited(res, LIMITS.bytes); } catch (e) { if (e instanceof AdoError) { throw e; } throw new AdoError('network', 'The reply from Azure DevOps was cut off.'); }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    const server = json && typeof json === 'object' && typeof json.message === 'string' ? cleanText(hide(json.message), 300) : '';
    if (status === 203 || (status === 200 && json === null && text.trim() !== '')) { throw new AdoError('auth', 'Azure DevOps did not accept the sign-in (it sent a sign-in page). Connect again, or check that your token has not expired.', { status }); }
    if (status === 401) { throw new AdoError('auth', 'Azure DevOps did not accept the sign-in (401). Connect again, or check that your token has not expired.', { status }); }
    if (status === 403) { throw new AdoError('forbidden', `You do not have permission to do that in Azure DevOps (403).${server ? ' ' + server : ''}`, { status }); }
    if (status === 404) { throw new AdoError('notfound', `Azure DevOps could not find that (404). Check the organisation and project names.${server ? ' ' + server : ''}`, { status }); }
    if (status === 409 || status === 412) { throw new AdoError('conflict', `Someone changed it at the same time (${status}).${server ? ' ' + server : ''}`, { status }); }
    if (status === 429) { throw new AdoError('rate', 'Azure DevOps is asking AI Delivery Insights to slow down (429). Try again in a minute.', { status }); }
    if (status >= 500) { throw new AdoError('server', `Azure DevOps had a problem (${status}). Try again later.`, { status }); }
    if (status >= 400) { throw new AdoError('invalid', `Azure DevOps refused the request (${status}).${server ? ' ' + server : ''}`, { status, detail: server }); }
    return json;
  }

  const patch = (ops) => ({ body: ops, contentType: 'application/json-patch+json' });

  const api = {
    org,

    /** Who is signed in, best effort (this call is not in Microsoft's reference pages, so any failure is ignored). */
    async whoAmI() {
      try {
        const j = await call('GET', null, '/_apis/connectionData', { query: { 'api-version': '7.1-preview' } });
        const u = j && j.authenticatedUser;
        const id = u && typeof u.id === 'string' && /^[0-9a-f-]{8,40}$/i.test(u.id) ? u.id.toLowerCase() : '';
        const name = u ? cleanText(u.customDisplayName || u.providerDisplayName, 100) : '';
        return id || name ? { id, name } : null;
      } catch (e) { if (e instanceof AdoError && (e.kind === 'auth' || e.kind === 'network' || e.kind === 'timeout')) { return null; } return null; }
    },

    /** The teams of a project. Each team has its own board, so this is the list of boards a person can choose from. */
    async listTeams(project) {
      if (!validProject(project)) { throw new AdoError('invalid', 'Choose a project first.'); }
      const j = await call('GET', null, `/_apis/projects/${encodeURIComponent(project)}/teams`, { query: { $top: 200 } });
      const list = j && Array.isArray(j.value) ? j.value : [];
      return list.map((t) => ({ id: cleanText(t && t.id, 50).toLowerCase(), name: cleanText(t && t.name, 100) })).filter((t) => t.name && validTeamId(t.id)).sort((a, b) => a.name.localeCompare(b.name));
    },

    /** The area paths a team's board covers, and whether each includes its sub-areas. */
    async getTeamAreaPaths(project, teamId) {
      if (!validProject(project)) { throw new AdoError('invalid', 'Choose a project first.'); }
      if (!validTeamId(teamId)) { throw new AdoError('invalid', 'That is not a board.'); }
      const j = await call('GET', project, `/${teamId}/_apis/work/teamsettings/teamfieldvalues`);
      const field = j && j.field && typeof j.field.referenceName === 'string' ? j.field.referenceName : 'System.AreaPath';
      if (field !== 'System.AreaPath') { throw new AdoError('invalid', 'This board is not set up by area path, so AI Delivery Insights cannot tell which stories belong to it.'); }
      const out = [];
      for (const v of (j && Array.isArray(j.values) ? j.values : [])) {
        const path = cleanText(v && v.value, 400);
        if (validAreaPath(path)) { out.push({ path, includeChildren: !!(v && v.includeChildren) }); }
      }
      if (!out.length && j && validAreaPath(cleanText(j.defaultValue, 400))) { out.push({ path: cleanText(j.defaultValue, 400), includeChildren: true }); }
      return out;
    },

    /** Projects the signed-in person can see. Also the connection test. */
    async listProjects() {
      const j = await call('GET', null, '/_apis/projects', { query: { $top: 200 } });
      const list = j && Array.isArray(j.value) ? j.value : [];
      return list.map((p) => ({ id: cleanText(p && p.id, 50), name: cleanText(p && p.name, 64), state: cleanText(p && p.state, 20) })).filter((p) => p.name && validProject(p.name));
    },

    /**
     * Stories on the backlog of a project, newest change first. Two calls: a WIQL query for the numbers, then one batch read.
     * `areaPaths` ([{path, includeChildren}]) narrows the query to one board's work: a board belongs to a team, and a team owns area paths.
     * @returns {Promise<Array>} normalised work items (without long text)
     */
    async listStories(args) {
      const a = args || {};
      if (!validProject(a.project)) { throw new AdoError('invalid', 'Choose a project first.'); }
      const types = (Array.isArray(a.types) && a.types.length ? a.types : DEFAULT_STORY_TYPES).filter(validTypeName).slice(0, 10);
      if (!types.length) { throw new AdoError('invalid', 'No valid story types are set.'); }
      const top = Math.max(1, Math.min(LIMITS.stories, Number.isFinite(a.top) ? a.top : 200));
      let area = '';
      if (a.areaPaths != null) {
        const paths = (Array.isArray(a.areaPaths) ? a.areaPaths : []).filter((x) => x && validAreaPath(x.path)).slice(0, 50);
        if (!paths.length) { throw new AdoError('invalid', 'This board has no area path to filter by.'); }
        area = ` AND (${paths.map((x) => `[System.AreaPath] ${x.includeChildren === false ? '=' : 'UNDER'} ${wiqlString(x.path)}`).join(' OR ')})`;
      }
      const q = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN (${types.map(wiqlString).join(', ')}) AND [System.State] <> 'Removed'${area} ORDER BY [System.ChangedDate] DESC`;
      const r = await call('POST', a.project, '/_apis/wit/wiql', { query: { $top: top }, body: { query: q }, safeToRetry: true });
      const ids = (r && Array.isArray(r.workItems) ? r.workItems : []).map((w) => posInt(w && w.id)).filter((x) => x != null).slice(0, top);
      return api.getItems(ids, { project: a.project });
    },

    /** Read work items by number (200 per call). Fields a process does not have are simply absent. `withDescription` also reads the description (the tracking Task's report). */
    async getItems(ids, args) {
      const list = (Array.isArray(ids) ? ids : []).map(posInt).filter((x) => x != null);
      const project = args && args.project ? args.project : null;
      const withDescription = !!(args && args.withDescription);
      const fieldList = (withDescription ? TASK_FIELDS : STORY_FIELDS).join(',');
      const out = [];
      for (let i = 0; i < list.length; i += LIMITS.ids) {
        const chunk = list.slice(i, i + LIMITS.ids);
        let j;
        try {
          j = await call('GET', project, '/_apis/wit/workitems', { query: { ids: chunk.join(','), fields: fieldList, errorPolicy: 'omit' } });
        } catch (e) {
          // A field name this organisation does not know can make the request fail; ask again without a field list.
          if (e instanceof AdoError && e.kind === 'invalid' && /field/i.test(`${e.detail || ''} ${e.message}`)) { j = await call('GET', project, '/_apis/wit/workitems', { query: { ids: chunk.join(','), errorPolicy: 'omit' } }); } else { throw e; }
        }
        for (const w of (j && Array.isArray(j.value) ? j.value : [])) { const n = normalizeItem(w, withDescription); if (n) { out.push(n); } }
      }
      return out;
    },

    /** One work item with its links (so its children are known). Null when it does not exist. */
    async getStory(id) {
      const n = posInt(id);
      if (n == null) { throw new AdoError('invalid', 'That is not a work item number.'); }
      try {
        return normalizeItem(await call('GET', null, `/_apis/wit/workitems/${n}`, { query: { $expand: 'relations' } }));
      } catch (e) { if (e instanceof AdoError && e.kind === 'notfound') { return null; } throw e; }
    },

    /**
     * The AI Delivery Insights tracking Task under a story: a Task child tagged "copilot-lens" whose title starts "Copilot Lens usage".
     * If there is more than one, the lowest number is used and the others are reported, never touched.
     */
    async findTrackingTask(story) {
      const kids = story && Array.isArray(story.children) ? story.children : [];
      if (!kids.length) { return { task: null, duplicates: [] }; }
      const items = await api.getItems(kids, { project: story.project });
      const mine = items.filter((t) => t.type === TRACKING_TYPE && t.title.startsWith(TRACKING_TITLE) && t.tags.some((x) => x.toLowerCase() === TRACKING_TAG)).sort((a, b) => a.id - b.id);
      if (!mine.length) { return { task: null, duplicates: [] }; }
      // Only the chosen Task's description is read, in a request of its own, so the other children's text is never downloaded.
      const full = await api.getItems([mine[0].id], { project: story.project, withDescription: true });
      return { task: full[0] || null, duplicates: mine.slice(1).map((t) => t.id) };
    },

    /** Create the tracking Task as a child of the story. The one call that adds something to Azure DevOps. */
    async createTrackingTask(args) {
      const a = args || {};
      const st = a.story;
      if (!st || posInt(st.id) == null || !validProject(st.project)) { throw new AdoError('invalid', 'The story is not known to Azure DevOps.'); }
      if (typeof a.descriptionHtml !== 'string') { throw new AdoError('invalid', 'There is no usage summary to send.'); }
      if (a.descriptionHtml.length > LIMITS.description) { throw new AdoError('too_large', 'The usage summary is too large for one work item.'); }
      const ops = [
        { op: 'add', path: '/fields/System.Title', value: `${TRACKING_TITLE} for #${st.id}` },
        { op: 'add', path: '/fields/System.Description', value: a.descriptionHtml },
        { op: 'add', path: '/fields/System.Tags', value: TRACKING_TAG },
        { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${HOST}/${encodeURIComponent(org)}/_apis/wit/workItems/${st.id}`, attributes: { comment: 'Copilot Lens usage summary' } } },
      ];
      if (st.areaPath) { ops.push({ op: 'add', path: '/fields/System.AreaPath', value: st.areaPath }); }
      if (st.iterationPath) { ops.push({ op: 'add', path: '/fields/System.IterationPath', value: st.iterationPath }); }
      const j = await call('POST', st.project, `/_apis/wit/workitems/$${TRACKING_TYPE}`, patch(ops));
      const n = normalizeItem(j);
      if (!n) { throw new AdoError('invalid', 'Azure DevOps created the task but sent back something unexpected.'); }
      return n;
    },

    /**
     * Replace the tracking Task's description. The first operation tests the revision we read, so if anyone changed the
     * task in the meantime Azure DevOps refuses and nothing is overwritten.
     */
    async updateTrackingTask(args) {
      const a = args || {};
      const t = a.task;
      if (!t || posInt(t.id) == null || !Number.isInteger(t.rev) || t.rev < 1) { throw new AdoError('invalid', 'The task is not known to Azure DevOps.'); }
      if (typeof a.descriptionHtml !== 'string') { throw new AdoError('invalid', 'There is no usage summary to send.'); }
      if (a.descriptionHtml.length > LIMITS.description) { throw new AdoError('too_large', 'The usage summary is too large for one work item.'); }
      const j = await call('PATCH', null, `/_apis/wit/workitems/${t.id}`, patch([
        { op: 'test', path: '/rev', value: t.rev },
        { op: 'replace', path: '/fields/System.Description', value: a.descriptionHtml },
      ]));
      const n = normalizeItem(j);
      if (!n) { throw new AdoError('invalid', 'Azure DevOps updated the task but sent back something unexpected.'); }
      return n;
    },
  };
  return api;
}

module.exports = {
  HOST, API, TRACKING_TAG, TRACKING_TITLE, TRACKING_TYPE, STORY_FIELDS, DEFAULT_STORY_TYPES, LIMITS, AdoError,
  parseOrganization, validProject, validTypeName, validTeamId, createClient, idFromUrl, pointsOf,
};
