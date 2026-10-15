'use strict';
/**
 * A small stand-in for Azure DevOps, used by the tests in place of the real service. It lives in the test process and
 * answers `fetch(url, init)` calls, so no network is involved.
 *
 * It follows Microsoft's published REST pages for the calls AI Delivery Insights makes (create and update work item, WIQL, read by
 * ids, expand relations). Where the real service is not documented (the status for a failed revision test, the reply for a
 * field the organisation does not have) the stand-in can be switched between plausible behaviours with `opts`, so the
 * client is tested against each. That means a pass here proves the client handles those cases, not that Azure DevOps
 * behaves that way: the first real run in a throwaway project (docs/ai-delivery-insights/human-checklist.md) is the check.
 */

const ORG_HOST = 'https://dev.azure.com';

function createStub(options) {
  const opts = {
    org: 'contoso',
    bearer: 'bearer-token-1',
    pat: 'pat-token-1',
    revFailureStatus: 412,     // status used when a `test /rev` operation fails
    unknownFieldStatus: 0,     // 0 = unknown fields are ignored; otherwise the status to send when `fields` has one the org lacks
    unknownFields: ['Microsoft.VSTS.Scheduling.Size'],
    signInPageStatus: 0,       // 203 or 200 = answer API calls with an HTML sign-in page instead of data
    projectListStatus: 0,      // 401 or 403 = refuse the project list only (a token without "Project and Team: Read"), as if its scope were too narrow
    teamListStatus: 0,         // 401 or 403 = refuse the team list only, for the same reason
    teamFieldName: 'System.AreaPath', // the field a team's board is set up by; anything else means the board cannot be matched to stories
    ...(options || {}),
  };
  const projects = [
    { id: '11111111-1111-1111-1111-111111111111', name: 'Shop', state: 'wellFormed' },
    { id: '22222222-2222-2222-2222-222222222222', name: 'Throwaway', state: 'wellFormed' },
  ];
  // Each team has a board; a board is the work under the team's area paths.
  const CHECKOUT = 'aaaaaaaa-0000-0000-0000-000000000001';
  const PLATFORM = 'aaaaaaaa-0000-0000-0000-000000000002';
  const teams = [
    { id: PLATFORM, name: 'Platform Team', url: 'x', projectName: 'Shop', projectId: projects[0].id },
    { id: CHECKOUT, name: 'Checkout Team', url: 'x', projectName: 'Shop', projectId: projects[0].id },
  ];
  const teamAreas = {
    [CHECKOUT]: { defaultValue: 'Shop\\Checkout', values: [{ value: 'Shop\\Checkout', includeChildren: true }] },
    [PLATFORM]: { defaultValue: 'Shop\\Platform', values: [{ value: 'Shop\\Platform', includeChildren: false }, { value: 'Shop\\Shared', includeChildren: true }] },
  };
  const items = new Map();
  let nextId = 100;
  const requests = [];
  const state = { chaos: null, beforePatch: null };

  const iso = () => new Date(0).toISOString();
  function addItem(spec) {
    const id = spec.id || nextId++;
    const it = {
      id, rev: 1, url: `${ORG_HOST}/${opts.org}/_apis/wit/workItems/${id}`,
      fields: {
        'System.Id': id, 'System.Title': 'Untitled', 'System.WorkItemType': 'User Story', 'System.State': 'Active',
        'System.TeamProject': 'Shop', 'System.AreaPath': 'Shop', 'System.IterationPath': 'Shop\\Sprint 1', 'System.Tags': '',
        'System.ChangedDate': iso(), ...(spec.fields || {}),
      },
      relations: spec.relations || [],
    };
    items.set(id, it);
    if (typeof spec.id === 'number' && spec.id >= nextId) { nextId = spec.id + 1; }
    return it;
  }
  const story = (id, title, extra) => addItem({ id, fields: { 'System.Title': title, 'Microsoft.VSTS.Scheduling.StoryPoints': 5, ...(extra || {}) } });

  const json = (status, body, headers) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(headers || {}) } });
  const view = (it, withRelations, fieldList) => {
    const out = { id: it.id, rev: it.rev, url: it.url, fields: {} };
    const wanted = fieldList && fieldList.length ? fieldList : Object.keys(it.fields);
    for (const k of wanted) { if (Object.prototype.hasOwnProperty.call(it.fields, k)) { out.fields[k] = it.fields[k]; } }
    if (withRelations) { out.relations = it.relations.map((r) => ({ ...r })); }
    return out;
  };

  function checkAuth(headers) {
    const h = headers.Authorization || headers.authorization || '';
    if (/^Bearer /.test(h)) { return h.slice(7) === opts.bearer; }
    if (/^Basic /.test(h)) { return Buffer.from(h.slice(6), 'base64').toString('utf8') === ':' + opts.pat; }
    return false;
  }

  function applyPatch(it, ops) {
    // Applied to a copy, committed only if every operation succeeds (as the service does).
    const copy = JSON.parse(JSON.stringify(it));
    for (const op of ops) {
      if (op.op === 'test') {
        if (op.path === '/rev' && copy.rev !== op.value) { return { status: opts.revFailureStatus, message: `VS403000: test failed: expected rev ${op.value} but it is ${copy.rev}` }; }
      } else if (op.op === 'add' || op.op === 'replace') {
        const m = /^\/fields\/(.+)$/.exec(op.path);
        if (m) { copy.fields[m[1]] = op.value; continue; }
        if (op.path === '/relations/-') {
          const target = /\/workItems\/(\d+)$/i.exec(op.value.url);
          if (!target || !items.has(Number(target[1]))) { return { status: 400, message: 'VS402000: the related work item does not exist' }; }
          copy.relations.push({ rel: op.value.rel, url: op.value.url, attributes: op.value.attributes || {} });
          continue;
        }
        return { status: 400, message: `unsupported path ${op.path}` };
      } else { return { status: 400, message: `unsupported operation ${op.op}` }; }
    }
    return { copy };
  }

  async function fetchStub(urlText, init) {
    const url = new URL(urlText);
    const i = init || {};
    const headers = i.headers || {};
    const body = i.body === undefined ? undefined : JSON.parse(i.body);
    const rec = { method: i.method || 'GET', url: url.toString(), host: url.origin, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: { ...headers }, redirect: i.redirect, body };
    requests.push(rec);

    if (state.chaos) { const r = state.chaos(rec, requests.length); if (r) { return r; } }
    if (url.origin !== ORG_HOST) { return json(404, { message: 'not an Azure DevOps address' }); }
    const m = new RegExp(`^/${opts.org}(/(?!_apis)[^/]+)?(/(?!_apis)[^/]+)?(/_apis/.*)$`, 'i').exec(decodeURIComponent(url.pathname));
    if (!m) { return json(404, { message: 'VS800075: The project or organisation does not exist' }); }
    if (!checkAuth(headers)) { return opts.signInPageStatus ? new Response('<html>Sign in</html>', { status: opts.signInPageStatus, headers: { 'content-type': 'text/html' } }) : json(401, { message: 'TF400813: not authorized' }); }
    if (opts.signInPageStatus) { return new Response('<html>Sign in</html>', { status: opts.signInPageStatus, headers: { 'content-type': 'text/html' } }); }
    const project = m[1] ? m[1].slice(1) : null;
    const team = m[2] ? m[2].slice(1) : null;
    const api = m[3];

    if (project && !projects.some((p) => p.name === project)) { return json(404, { message: `TF200016: The following project does not exist: ${project}.` }); }

    if (rec.method === 'GET' && api === '/_apis/connectionData') { return json(200, { authenticatedUser: { id: 'aaaaaaaa-0000-0000-0000-000000000001', providerDisplayName: 'Test Person' } }); }
    if (rec.method === 'GET' && api === '/_apis/projects' && opts.projectListStatus) { return json(opts.projectListStatus, { message: 'TF400813: The user is not authorized to access this resource.' }); }
    if (rec.method === 'GET' && api === '/_apis/projects') { return json(200, { count: projects.length, value: projects.map((p) => ({ ...p })) }); }

    let tm = /^\/_apis\/projects\/([^/]+)\/teams$/i.exec(api);
    if (tm && rec.method === 'GET') {
      if (opts.teamListStatus) { return json(opts.teamListStatus, { message: 'TF400813: The user is not authorized to access this resource.' }); }
      if (!projects.some((p) => p.name === tm[1])) { return json(404, { message: `TF200016: The following project does not exist: ${tm[1]}.` }); }
      return json(200, { count: teams.length, value: teams.map((t) => ({ ...t })) });
    }
    if (rec.method === 'GET' && team && api === '/_apis/work/teamsettings/teamfieldvalues') {
      if (!teamAreas[team]) { return json(404, { message: 'VS402484: The team does not exist.' }); }
      return json(200, { field: { referenceName: opts.teamFieldName, url: 'x' }, ...teamAreas[team] });
    }

    if (rec.method === 'POST' && api === '/_apis/wit/wiql') {
      const q = String(body && body.query || '');
      const types = [...(/\[System\.WorkItemType\] IN \(([^)]*)\)/.exec(q) || ['', ''])[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
      const areas = [...q.matchAll(/\[System\.AreaPath\] (UNDER|=) '((?:[^']|'')*)'/g)].map((x) => ({ under: x[1] === 'UNDER', path: x[2].replace(/''/g, "'") }));
      const inArea = (it) => !areas.length || areas.some((a) => { const p = it.fields['System.AreaPath']; return p === a.path || (a.under && p.startsWith(a.path + '\\')); });
      const top = Number(rec.query.$top) || 200;
      const list = [...items.values()].filter((it) => it.fields['System.TeamProject'] === project && types.includes(it.fields['System.WorkItemType']) && inArea(it)).sort((a, b) => b.id - a.id).slice(0, top);
      return json(200, { queryType: 'flat', workItems: list.map((it) => ({ id: it.id, url: it.url })) });
    }

    if (rec.method === 'GET' && api === '/_apis/wit/workitems') {
      const ids = String(rec.query.ids || '').split(',').filter(Boolean).map(Number);
      if (ids.length > 200) { return json(400, { message: 'VS402337: too many ids' }); }
      const fieldList = rec.query.fields ? rec.query.fields.split(',') : null;
      if (fieldList && opts.unknownFieldStatus && fieldList.some((f) => opts.unknownFields.includes(f))) { return json(opts.unknownFieldStatus, { message: 'TF51535: Cannot find field Microsoft.VSTS.Scheduling.Size.' }); }
      const value = ids.map((id) => (items.has(id) ? view(items.get(id), false, fieldList) : null));
      return json(200, { count: value.length, value: rec.query.errorPolicy === 'omit' ? value : value.filter(Boolean) });
    }

    let mm = /^\/_apis\/wit\/workitems\/(\d+)$/i.exec(api);
    if (mm && rec.method === 'GET') {
      const it = items.get(Number(mm[1]));
      return it ? json(200, view(it, rec.query.$expand === 'relations')) : json(404, { message: `TF401232: Work item ${mm[1]} does not exist, or you do not have permissions to read it.` });
    }
    if (mm && rec.method === 'PATCH') {
      const it = items.get(Number(mm[1]));
      if (!it) { return json(404, { message: 'TF401232: no such work item' }); }
      if (String(headers['Content-Type'] || '').toLowerCase() !== 'application/json-patch+json') { return json(415, { message: 'unsupported media type' }); }
      if (state.beforePatch) { state.beforePatch(it); }
      const r = applyPatch(it, body);
      if (!r.copy) { return json(r.status, { message: r.message }); }
      r.copy.rev = it.rev + 1;
      items.set(it.id, r.copy);
      return json(200, view(r.copy, false));
    }
    mm = /^\/_apis\/wit\/workitems\/\$(.+)$/i.exec(api);
    if (mm && rec.method === 'POST') {
      if (String(headers['Content-Type'] || '').toLowerCase() !== 'application/json-patch+json') { return json(415, { message: 'unsupported media type' }); }
      const it = addItem({ fields: { 'System.WorkItemType': mm[1], 'System.TeamProject': project, 'System.AreaPath': project, 'System.IterationPath': project } });
      const r = applyPatch(it, body);
      if (!r.copy) { items.delete(it.id); return json(r.status, { message: r.message }); }
      items.set(it.id, r.copy);
      // a parent link also appears on the parent as a child link
      for (const rel of r.copy.relations) {
        if (rel.rel === 'System.LinkTypes.Hierarchy-Reverse') {
          const parent = items.get(Number(/\/workItems\/(\d+)$/i.exec(rel.url)[1]));
          parent.relations.push({ rel: 'System.LinkTypes.Hierarchy-Forward', url: it.url, attributes: {} });
          parent.rev += 1;
        }
      }
      return json(200, view(items.get(it.id), false));
    }
    return json(404, { message: `unhandled ${rec.method} ${api}` });
  }

  return {
    opts, requests, state, items, projects, teams, TEAM_CHECKOUT: CHECKOUT, TEAM_PLATFORM: PLATFORM,
    fetch: fetchStub,
    addStory: story,
    addItem,
    /** A change made by someone else: bumps the revision and optionally sets fields. */
    touch(id, fields) { const it = items.get(id); Object.assign(it.fields, fields || {}); it.rev += 1; return it; },
    reset() { requests.length = 0; },
    count(method, pathPart) { return requests.filter((r) => (!method || r.method === method) && (!pathPart || r.path.includes(pathPart))).length; },
  };
}

module.exports = { createStub };
