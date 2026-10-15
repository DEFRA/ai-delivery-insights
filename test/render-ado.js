'use strict';
/**
 * UI tests for the Azure DevOps pages: Connect, Import, Effort and Sync, and the Azure DevOps parts of the Stories and Story pages.
 *
 * The page runs in jsdom. A host emulator answers its messages with the REAL service (lib/adoservice.js), the REAL story store
 * (lib/stories.js), the REAL git reader on a temporary repository, and the in-process Azure DevOps stand-in, so the screens, the
 * messages and the logic behind them are exercised together. Expected figures are worked out by hand in this file.
 *
 * Run:  LENS_DATA=<scan.json> LENS_TEST_LOCALE=de-DE node test/render-ado.js
 * Numbers print in the viewer's locale, so checks read the data-* attributes that carry exact values.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const { boot } = require('./harness');
const Core = require('../media/story-core.js');
const Stories = require('../lib/stories.js');
const Ado = require('../lib/ado.js');
const U = require('../lib/usage.js');
const { createService } = require('../lib/adoservice.js');
const { createStub } = require('./ado-stub.js');

const LOCALE = process.env.LENS_TEST_LOCALE || 'en-US';
if (spawnSync('git', ['--version']).status !== 0) { console.log('SKIP git is not installed, so the effort page cannot be exercised'); process.exit(0); }

const data = JSON.parse(fs.readFileSync(process.env.LENS_DATA, 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-delivery-insights-ui-ado-'));
const BEARER = 'bearer-UI-secret-9';
const stub = createStub({ bearer: BEARER });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms) => { const end = Date.now() + (ms || 8000); for (;;) { let v; try { v = fn(); } catch (e) { v = false; } if (v) { return v; } if (Date.now() > end) { throw new Error('timed out waiting for ' + what + '\n  page says: ' + String(t.text('#app')).replace(/\s+/g, ' ').slice(0, 500)); } await sleep(8); } };

/* ---------------- the story's sessions and a real repository ---------------- */
const shop = Object.keys(data.workspaces).find((k) => /shop-api$/.test(k));
const mine = data.sessions.filter((s) => s.wsKey === shop && s.prompts.length >= 2).slice(0, 4);
assert.strictEqual(mine.length, 4, 'the fixture has shop-api sessions');
const lastTs = (s) => Math.max(...s.prompts.map((p) => p.ts || 0));
const repo = path.join(tmp, 'shop-api');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true }); fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
const git = (args, when) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', ...(when ? { GIT_AUTHOR_DATE: new Date(when).toISOString(), GIT_COMMITTER_DATE: new Date(when).toISOString() } : {}) }, stdio: 'pipe' });
git(['init', '-q']); git(['symbolic-ref', 'HEAD', 'refs/heads/main']); git(['config', 'commit.gpgsign', 'false']); git(['config', 'user.email', 't@example.com']); git(['config', 'user.name', 'T']);
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join('\n') + '\n';
const commit = (file, n, msg, when) => { fs.writeFileSync(path.join(repo, file), lines(n, file)); git(['add', '.']); git(['commit', '-q', '-m', msg], when); };
commit('src/login.js', 150, 'AB#7001 login form', lastTs(mine[0]) + 5 * 60000);          // 150 code lines, found by the story number
commit('test/login.test.js', 50, 'AB#7001 tests for login', lastTs(mine[0]) + 10 * 60000); // 50 test lines, found by the story number
commit('src/theme.js', 20, 'tweak styles', lastTs(mine[1]) + 20 * 60000);                  // 20 code lines, no number: found by time only
for (const [k, w] of Object.entries(data.workspaces)) { if (k === shop) { w.local = true; w.repos = [{ name: 'shop-api', path: repo, branch: 'main', remote: '' }]; } else { w.repos = []; w.local = false; } }
// What the oracle expects, worked out by hand with the default rates (150 code lines a day, 250 test lines a day, 8 hours a day, 25% overhead, 0.25 h a file):
//   all three commits : 170/150*8 = 9.0667 + 50/250*8 = 1.6 + 3*0.25 = 0.75 -> 11.4167 * 1.25 = 14.27 -> 14.3  (range 10.0 to 21.4)
//   without the third : 8 + 1.6 + 0.5 = 10.1 * 1.25 = 12.625 -> 12.6  (range 8.8 to 18.9)
//   code commit only  : 8 + 0.25 = 8.25 * 1.25 = 10.3125 -> 10.3  (range 7.2 to 15.5)

/* ---------------- host emulator wired to the real service ---------------- */
function startHost(opts) {
  const o = opts || {};
  const t = boot({ locale: LOCALE, state: o.state });
  const settings = { enabled: !!o.enabled, organization: 'contoso', project: 'Shop', storyTypes: undefined, shareName: false, effort: {} };
  let store = Core.emptyStore();
  const log = { commands: [], ops: [], ado: [], opened: [] };
  const hold = { applyFail: null, computeQueue: null, applyGate: false, release: null };
  const ctx = () => Stories.contextFor(data);
  const broadcast = (extra) => t.send(Object.assign({ type: 'stories', store: Core.toPlain(store) }, extra || {}));
  const deps = {
    settings: () => settings, trusted: () => true,
    client: async () => Ado.createClient({ org: settings.organization, fetch: stub.fetch, sleep: () => Promise.resolve(), auth: async () => ({ scheme: 'Bearer', token: BEARER }) }),
    data: async () => data, store: () => store,
    commit: (op) => { const r = Stories.applyOp(store, op, ctx(), Date.now()); if (!r.ok) { return { ok: false, error: r.error }; } store = r.store; broadcast(); return { ok: true, message: r.message }; },
    contributor: () => ({ id: 'inst-aaaaaaaaaaaaaaaaaaaa', displayName: '' }),
    currentRepos: () => [], now: () => Date.now(), random: (() => { let n = 0; return () => `id-${++n}`; })(), log: () => {},
  };
  const svc = createService(deps);
  async function handleAdo(m) {
    switch (m.op) {
      case 'status': { const st = svc.status(); return { ok: true, ...st, authMethod: 'microsoft', signedIn: st.enabled && st.trusted, user: o.userKnown ? { name: 'Test Person' } : null }; }
      case 'test': return svc.test();
      case 'boards': return svc.listBoards({ project: m.project });
      case 'backlog': return svc.listBacklog({ project: m.project, board: m.board });
      case 'import': return svc.importStories({ ids: m.ids });
      case 'refresh': return svc.refreshStory({ storyId: m.storyId });
      case 'effortFind': return svc.effortFind({ storyId: m.storyId });
      case 'effortCompute': {
        const r = await svc.effortCompute({ storyId: m.storyId, cacheId: m.cacheId, selected: m.selected });
        if (hold.computeQueue) { await new Promise((res) => hold.computeQueue.push(res)); } // answers wait here until the test lets them go
        return r;
      }
      case 'effortSave': return svc.effortSave({ storyId: m.storyId, cacheId: m.cacheId, selected: m.selected });
      case 'syncPreview': return svc.syncPreview({ storyId: m.storyId });
      case 'syncApply': { if (hold.applyGate) { await new Promise((res) => { hold.release = res; }); } if (hold.applyFail) { const f = hold.applyFail; hold.applyFail = null; return f; } return svc.syncApply({ storyId: m.storyId, planId: m.planId }); }
      case 'open': { const url = svc.urlFor({ storyId: m.storyId, kind: m.kind === 'task' ? 'task' : 'story' }); if (!url) { return { ok: false, error: 'There is nothing to open for this story yet.' }; } log.opened.push(url); return { ok: true }; }
      default: return { ok: false, error: 'Unknown request.' };
    }
  }
  const reply = (msg) => {
    const m = JSON.parse(JSON.stringify(msg));
    switch (m.type) {
      case 'ready': t.send({ type: 'data', payload: data, current: { uris: [], paths: [] }, allowance: 1000 }); broadcast(); break;
      case 'story': {
        log.ops.push(m);
        const r = Stories.applyOp(store, m.op, ctx(), Date.now());
        if (r.ok) { store = r.store; }
        broadcast({ result: r.ok ? { rid: m.rid, ok: true, message: r.message } : { rid: m.rid, ok: false, error: r.error } });
        break;
      }
      case 'ado': log.ado.push(m); handleAdo(m).then((r) => t.send(Object.assign({ type: 'ado', rid: m.rid }, r))); break;
      case 'command': log.commands.push(m.name); break;
      default: break;
    }
  };
  t.host(reply);
  t.posted.slice().forEach(reply);
  return Object.assign(t, {
    log, settings, hold, svc,
    store: () => store,
    setStore: (s) => { store = s; broadcast(); },
    enable: (on) => { settings.enabled = on; t.send({ type: 'adoChanged' }); },
    tag: (storyId, ids) => { const r = deps.commit({ type: 'tagSessions', ids, storyId }); assert.ok(r.ok, r.error); },
    jump: (route) => t.send({ type: 'route', route }),
    title: () => (t.q('#page-title') || { textContent: '' }).textContent.trim(),
    route: () => t.state().route,
    crumbs: () => t.qa('.crumbs ol li:not(.sep)').map((li) => li.textContent.trim()),
    toast: () => t.text('.toast'),
  });
}

/** Everything a person could not name with a screen reader (same rules as the story page tests). */
function a11yProblems(t) {
  const bad = [];
  const named = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim().length > 0;
  for (const b of t.qa('button')) { if (!named(b)) { bad.push('button without a name: ' + b.outerHTML.slice(0, 80)); } }
  for (const f of t.qa('select, input:not([type="hidden"])')) { if (!(f.getAttribute('aria-label') || f.closest('label') || (f.id && t.q(`label[for="${f.id}"]`)))) { bad.push('field without a label: ' + f.outerHTML.slice(0, 80)); } }
  if (t.qa('#page-title').length !== 1) { bad.push('expected exactly one #page-title, found ' + t.qa('#page-title').length); }
  for (const th of t.qa('th')) { if (!th.getAttribute('scope')) { bad.push('th without scope'); } }
  return bad;
}

const checks = [];
const check = (name, fn) => checks.push([name, fn]);
const sumCredits = (ss) => ss.reduce((a, s) => a + s.prompts.reduce((b, p) => b + p.credits, 0) + (s.overhead ? s.overhead.credits : 0), 0);
const sumTokens = (ss) => ss.reduce((a, s) => a + s.prompts.reduce((b, p) => b + p.inTok + p.outTok, 0) + (s.overhead ? s.overhead.inTok + s.overhead.outTok : 0), 0);
const dataV = (t, sel) => Number((t.q(sel) || { getAttribute: () => 'NaN' }).getAttribute('data-v'));
const tasks = () => [...stub.items.values()].filter((i) => i.fields['System.WorkItemType'] === 'Task');
stub.addStory(7001, 'Login', { 'Microsoft.VSTS.Scheduling.StoryPoints': 5 });
stub.addStory(7002, 'Reports', { 'Microsoft.VSTS.Scheduling.StoryPoints': 3 });
stub.addStory(7003, '<img src=x onerror=alert(1)> Hostile <b>title</b>', { 'Microsoft.VSTS.Scheduling.StoryPoints': 1 });

const t = startHost({ userKnown: true });
const ids = mine.map((s) => s.id);

check('starts with Azure DevOps off: nothing is sent, and the status request carries no address or token', async () => {
  await until(() => t.log.ado.length >= 1, 'the status request');
  assert.deepStrictEqual(t.log.ado.map((m) => m.op), ['status']);
  assert.strictEqual(stub.requests.length, 0, 'no web request while off');
  assert.deepStrictEqual(t.errors, []);
  assert.ok(t.q('header [data-act="nav"][data-name="connect"]'), 'the header offers Azure DevOps');
});

check('Connect page while off: explains what is sent, offers to connect, and tests nothing', async () => {
  t.click(t.q('header [data-act="nav"][data-name="connect"]'));
  assert.deepStrictEqual(t.crumbs(), ['Dashboard', 'Azure DevOps']);
  assert.strictEqual(t.doc.activeElement.id, 'page-title');
  await until(() => /Off/.test(t.text('.panel')), 'the off state');
  assert.ok(t.q('[data-act="cmd"][data-cmd="adoConnect"]'), 'a Connect button');
  assert.ok(!t.q('[data-act="atest"]'), 'no test button while off');
  assert.ok(/never sends|never send/i.test(t.text('#app')) && /prompts, responses, session titles, file names or paths/.test(t.text('#app')), 'says what is never sent');
  assert.ok(/secret storage/.test(t.text('#app')) && /Work Items \(Read & write\)/.test(t.text('#app')), 'says how a token is kept');
  t.click(t.q('[data-act="cmd"][data-cmd="adoConnect"]'));
  assert.deepStrictEqual(t.log.commands, ['adoConnect'], 'the page asks for the command; the extension runs the wizard');
  t.click(t.q('[data-act="cmd"][data-cmd="adoConnect"]'));
  t.w.eval('1'); // keep the page alive
  assert.deepStrictEqual(a11yProblems(t), []);
  assert.strictEqual(stub.requests.length, 0);
});

check('a page can only ask for the listed commands', async () => {
  const before = t.log.commands.length;
  t.w.document.body.insertAdjacentHTML('beforeend', '<button id="evil" data-act="cmd" data-cmd="workbench.action.quit">x</button><button id="evil2" data-act="cmd" data-cmd="adoImport">x</button>');
  t.click(t.q('#evil')); t.click(t.q('#evil2'));
  assert.strictEqual(t.log.commands.length, before);
  t.q('#evil').remove(); t.q('#evil2').remove();
});

check('after connecting: the status is read again and the Connect page shows the connection', async () => {
  t.log.commands.length = 0;
  t.enable(true);
  await until(() => /On/.test(t.text('.pill.story')) && /contoso/.test(t.text('.kvs')), 'the connected state');
  assert.ok(/Microsoft account/.test(t.text('.kvs')) && /Test Person/.test(t.text('.kvs')) && /Shop/.test(t.text('.kvs')));
  assert.ok(t.q('[data-act="atest"]'));
  assert.strictEqual(stub.requests.length, 0, 'reading the status does not touch Azure DevOps');
  assert.deepStrictEqual(a11yProblems(t), []);
});

check('Test connection: shows who and which projects, using a Bearer token the page never sees', async () => {
  t.click(t.q('[data-act="atest"]'));
  await until(() => /Connected/.test(t.text('#app')), 'the test result');
  assert.ok(/Test Person/.test(t.text('p[role="status"]')) && /Shop, Throwaway/.test(t.text('p[role="status"]')));
  assert.ok(stub.requests.length >= 1 && stub.requests.every((q) => q.headers.Authorization === 'Bearer ' + BEARER));
  assert.ok(!t.doc.documentElement.outerHTML.includes(BEARER), 'the token is not in the page');
  assert.ok(!JSON.stringify(t.posted).includes(BEARER) && !JSON.stringify(t.state()).includes(BEARER), 'nor in anything the page posted or saved');
});

check('Test connection with a token that cannot list projects: says so, and names the project from the settings', async () => {
  stub.opts.projectListStatus = 401;
  try {
    t.click(t.q('[data-act="atest"]'));
    await until(() => /cannot list projects/.test(t.text('#app')), 'the explanation');
    assert.ok(/Connected/.test(t.text('p[role="status"]')) && /Project and Team: Read/.test(t.text('p[role="status"]')) && /Shop/.test(t.text('p[role="status"]')));
    assert.ok(!/You can see/.test(t.text('p[role="status"]')));
  } finally { stub.opts.projectListStatus = 0; }
  t.click(t.q('[data-act="atest"]'));
  await until(() => /Shop, Throwaway/.test(t.text('p[role="status"]')), 'the normal result again');
});

check('Import page: lists the backlog, hostile titles stay text, and nothing is chosen at first', async () => {
  t.click(t.q('[data-act="nav"][data-name="import"]'));
  assert.deepStrictEqual(t.crumbs(), ['Dashboard', 'Azure DevOps', 'Import']);
  await until(() => t.qa('[data-act="bsel"]').length === 3, 'three backlog rows');
  assert.deepStrictEqual(t.qa('[data-act="bsel"]').map((c) => c.dataset.key).sort(), ['7001', '7002', '7003']);
  assert.strictEqual(t.qa('img').length, 0, 'a title with markup is shown as text');
  assert.ok(/<img src=x onerror=alert\(1\)>/.test(t.text('table')), 'the hostile title is visible as plain text');
  assert.ok(t.q('[data-act="bimport"]').disabled && /Import 0 chosen/.test(t.q('[data-act="bimport"]').textContent));
  assert.strictEqual(t.q('select[data-ado-project]').value, 'Shop');
  assert.deepStrictEqual(a11yProblems(t), []);
});

check('Import page: search narrows the list, choose and import, imported stories are flagged and cannot be chosen twice', async () => {
  t.type(t.q('#bq'), 'Reports');
  await until(() => t.qa('[data-act="bsel"]').length === 1, 'the search result');
  t.click(t.q('[data-act="ball"]'));
  assert.ok(t.q('[data-act="bsel"]').checked && /Import 1 chosen/.test(t.q('[data-act="bimport"]').textContent));
  t.type(t.q('#bq'), '');
  await until(() => t.qa('[data-act="bsel"]').length === 3, 'the full list');
  t.click(t.q('[data-act="bsel"][data-key="7001"]'));
  assert.ok(/Import 2 chosen/.test(t.q('[data-act="bimport"]').textContent));
  t.click(t.q('[data-act="bimport"]'));
  await until(() => Object.keys(t.store().stories).length === 2, 'the stories to be saved');
  assert.deepStrictEqual(Object.keys(t.store().stories).sort(), ['7001', '7002']);
  assert.strictEqual(t.store().stories['7001'].adoId, 7001);
  await until(() => t.qa('.pill.story').filter((p) => /Already here/.test(p.textContent)).length === 2, 'the imported flags');
  assert.ok(t.q('[data-act="bsel"][data-key="7001"]').disabled && t.q('[data-act="bsel"][data-key="7002"]').disabled && !t.q('[data-act="bsel"][data-key="7003"]').disabled);
  assert.ok(/Imported 2 stories/.test(t.toast()));
  assert.ok(t.log.ado.filter((m) => m.op === 'import').every((m) => Object.keys(m).sort().join() === 'ids,op,rid,type'), 'the page sends only the chosen numbers');
});

check('Import page: choosing all never includes a story that is already here', async () => {
  t.click(t.q('[data-act="ball"]'));
  assert.ok(/Import 1 chosen/.test(t.q('[data-act="bimport"]').textContent), 'only the one new story');
  assert.deepStrictEqual(t.qa('[data-act="bsel"]').filter((c) => c.checked).map((c) => c.dataset.key), ['7003']);
  t.click(t.q('[data-act="ball"]'));
  assert.ok(/Import 0 chosen/.test(t.q('[data-act="bimport"]').textContent), 'choosing all again clears the choice');
});

check('Stories list: the imported stories show their Azure DevOps number and no effort yet', async () => {
  t.click(t.q('.panelfoot [data-act="nav"][data-name="stories"]'));
  assert.deepStrictEqual(t.crumbs(), ['Dashboard', 'Azure DevOps', 'Import', 'Stories']);
  const row = t.q('tr[data-story="7001"]');
  assert.ok(row, 'row for 7001');
  assert.ok(/#7001/.test(row.querySelector('[data-k="ado"]').textContent));
  assert.strictEqual(row.querySelector('[data-k="effort"]').textContent.trim(), '-');
  assert.ok(/Azure DevOps: contoso/.test(t.text('.phead')) && t.q('.phead [data-act="nav"][data-name="import"]'));
  assert.deepStrictEqual(a11yProblems(t), []);
});

check('Story page: shows both panels, and the Azure DevOps number can be set on the form', async () => {
  t.tag('7001', ids.slice(0, 2));
  t.click(t.q('tr[data-story="7001"] button[data-name="story"]'));
  assert.ok(/Effort without AI/.test(t.text('#app')) && /Not captured yet/.test(t.text('#app')));
  assert.ok(/#7001/.test(t.text('#app')) && /never/.test(t.text('#app')), 'a never-synced story says so');
  assert.ok(t.q('[data-act="nav"][data-name="effort"][data-id="7001"]') && t.q('[data-act="nav"][data-name="sync"][data-id="7001"]'));
  t.click(t.q('[data-act="editstory"]'));
  assert.strictEqual(t.q('[data-f="adoId"]').value, '7001');
  t.type(t.q('[data-f="adoId"]'), 'abc'); t.q('form[data-form="story"]').dispatchEvent(new t.w.Event('submit', { bubbles: true, cancelable: true }));
  assert.ok(/Azure DevOps ID/.test(t.text('.ferr')), 'a bad number is refused before anything is sent');
  t.click(t.q('[data-act="formcancel"]'));
  assert.deepStrictEqual(a11yProblems(t), []);
});

check('Effort page: finds the commits in git, explains the method, and works out the hours', async () => {
  t.click(t.q('[data-act="nav"][data-name="effort"][data-id="7001"]'));
  assert.deepStrictEqual(t.crumbs().slice(-3), ['Stories', 'Story 7001', 'Effort']);
  assert.ok(/Looking at the repository/.test(t.text('#app')) && /Nothing is sent anywhere/.test(t.text('#app')));
  await until(() => t.qa('[data-act="csel"]').length === 3, 'three commits');
  const rowOf = (re) => t.qa('tbody tr').find((tr) => re.test(tr.textContent));
  assert.ok(/story number/.test(rowOf(/login form/).textContent) && /story number/.test(rowOf(/tests for login/).textContent), 'matched by the story number');
  assert.ok(/time only/.test(rowOf(/tweak styles/).textContent), 'matched by time only');
  assert.ok(t.qa('[data-act="csel"]').every((c) => c.checked), 'all commits start ticked');
  assert.strictEqual(dataV(t, '[data-k="estimate"]'), 14.3, 'all three commits: 14.3 hours');
  assert.ok(/medium/.test(t.text('.band.flat .pill')), 'a time-only commit lowers the confidence');
  assert.ok(/9\.07|9,07/.test(t.text('.tbl.compact')) && /11\.42|11,42/.test(t.text('.tbl.compact')) && /Production code/.test(t.text('.tbl.compact')) && /Overhead/.test(t.text('.tbl.compact')), 'the arithmetic is shown');
  assert.ok(/How it is worked out/.test(t.text('#app')) && /rule of thumb|estimate of the effort, not a measurement/.test(t.text('#app')));
  assert.deepStrictEqual(a11yProblems(t), []);
});

check('Effort page: unticking a commit recalculates; unticking all explains; the hours match the hand-worked figures', async () => {
  const boxOf = (re) => t.qa('tbody tr').find((tr) => re.test(tr.textContent)).querySelector('[data-act="csel"]');
  t.click(boxOf(/tweak styles/));
  await until(() => dataV(t, '[data-k="estimate"]') === 12.6, '12.6 hours');
  assert.ok(/high/.test(t.text('.band.flat .pill')), 'only number-matched commits: high confidence');
  assert.ok(/8\.8|8,8/.test(t.text('.band.flat .usd')) && /18\.9|18,9/.test(t.text('.band.flat .usd')));
  t.click(boxOf(/tests for login/));
  await until(() => dataV(t, '[data-k="estimate"]') === 10.3, '10.3 hours');
  t.click(t.q('[data-act="cnone"]'));
  await until(() => !t.q('[data-k="estimate"]') && /No commits are ticked/.test(t.text('.notice')), 'the nothing-ticked explanation');
  assert.ok(t.q('[data-fid="e-hours"]'), 'the manual field is always there');
  t.click(t.q('[data-act="call"]'));
  await until(() => dataV(t, '[data-k="estimate"]') === 14.3, 'back to 14.3');
  t.click(boxOf(/tweak styles/));
  await until(() => dataV(t, '[data-k="estimate"]') === 12.6, '12.6 again');
});

check('Effort page: an older recalculation that arrives late cannot overwrite a newer one', async () => {
  const boxOf = (re) => t.qa('tbody tr').find((tr) => re.test(tr.textContent)).querySelector('[data-act="csel"]');
  t.hold.computeQueue = [];
  t.click(boxOf(/tests for login/));                       // now: login form only  -> 10.3
  await until(() => t.hold.computeQueue.length === 1, 'the first recalculation to be asked');
  t.click(boxOf(/tweak styles/));                          // now: login form + styles -> 12.0 (170/150*8 = 9.0667 + 2 files * 0.25 = 9.5667 * 1.25 = 11.96)
  await until(() => t.hold.computeQueue.length === 2, 'the second recalculation to be asked');
  const q = t.hold.computeQueue; t.hold.computeQueue = null;
  q[1](); await sleep(30);                                 // the newer answer arrives first...
  q[0](); await sleep(30);                                 // ...and the older one limps in afterwards
  assert.strictEqual(dataV(t, '[data-k="estimate"]'), 12, 'the page shows the answer for what is ticked now');
  t.click(boxOf(/tests for login/));
  await until(() => dataV(t, '[data-k="estimate"]') === 14.3, 'all three ticked again');
  t.click(boxOf(/tweak styles/));
  await until(() => dataV(t, '[data-k="estimate"]') === 12.6, 'back to the two number-matched commits');
});

check('Effort page: saving the estimate returns to the story, which now shows the hours', async () => {
  t.click(t.q('[data-act="esave"]'));
  await until(() => t.route().name === 'story', 'to go back to the story');
  assert.ok(/Estimated 12\.6 hours/.test(t.toast()));
  assert.strictEqual(dataV(t, '.panel [data-k="effort"]'), 12.6);
  assert.ok(/Estimated from the code, high confidence/.test(t.text('#app')));
  const rec = t.store().efforts['7001'];
  assert.deepStrictEqual([rec.hours, rec.low, rec.high, rec.source, rec.method, rec.confidence, rec.inputs.commits], [12.6, 8.8, 18.9, 'estimated', 'size-v1', 'high', 2]);
});

check('Effort page: hours typed by hand are validated, saved, and not replaced by an estimate without asking', async () => {
  t.click(t.q('[data-act="nav"][data-name="effort"][data-id="7001"]'));
  await until(() => t.qa('[data-act="csel"]').length === 3, 'the commits again');
  const ops = () => t.log.ops.filter((m) => m.op.type === 'saveEffort').length;
  t.type(t.q('[data-ef="manual"]'), 'abc'); t.q('form[data-form="effort"]').dispatchEvent(new t.w.Event('submit', { bubbles: true, cancelable: true }));
  assert.ok(t.q('.ferr[role="alert"]') && ops() === 0, 'a bad number is refused before it is sent');
  t.type(t.q('[data-ef="manual"]'), '0'); t.q('form[data-form="effort"]').dispatchEvent(new t.w.Event('submit', { bubbles: true, cancelable: true }));
  assert.ok(t.q('.ferr') && ops() === 0, 'zero hours are refused');
  t.type(t.q('[data-ef="manual"]'), '16'); t.type(t.q('[data-ef="note"]'), 'from the old board');
  t.q('form[data-form="effort"]').dispatchEvent(new t.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => t.store().efforts['7001'] && t.store().efforts['7001'].source === 'manual', 'the typed hours to be stored');
  assert.deepStrictEqual([t.store().efforts['7001'].hours, t.store().efforts['7001'].note, t.store().efforts['7001'].confidence], [16, 'from the old board', 'manual']);
  await until(() => dataV(t, '.panel [data-k="effort"]') === 16 && t.q('[data-ef="manual"]').value === '', 'the saved panel and an empty field');
  // choosing an estimate now would replace a number somebody typed: it asks first
  t.click(t.q('[data-act="esave"]'));
  assert.ok(/replace the 16 h|replace the 16/.test(t.text('.notice')) && t.q('[data-act="esave2"]'), 'asks before replacing');
  t.click(t.q('[data-act="esavecancel"]'));
  assert.strictEqual(t.store().efforts['7001'].source, 'manual', 'keeping the typed number leaves it alone');
  t.click(t.q('[data-act="esave"]')); t.click(t.q('[data-act="esave2"]'));
  await until(() => t.route().name === 'story' && t.store().efforts['7001'].source === 'estimated', 'the estimate to replace it');
  assert.strictEqual(t.store().efforts['7001'].hours, 14.3, 'the estimate for all three commits, as it was on screen');
});

check('Effort page: remove asks first, and nothing is left behind', async () => {
  t.click(t.q('[data-act="nav"][data-name="effort"][data-id="7001"]'));
  await until(() => t.q('[data-act="eclearask"]'), 'the remove button');
  t.click(t.q('[data-act="eclearask"]'));
  assert.ok(t.q('[data-act="eclear"]') && t.q('[data-act="eclearcancel"]'));
  t.click(t.q('[data-act="eclearcancel"]'));
  assert.ok(t.store().efforts['7001']);
  t.click(t.q('[data-act="eclearask"]')); t.click(t.q('[data-act="eclear"]'));
  await until(() => !t.store().efforts['7001'], 'the effort to be removed');
  assert.ok(/Nothing is saved|none yet/.test(t.text('#app')));
  t.click(t.q('[data-act="back"]'));
  assert.strictEqual(t.route().name, 'story');
});

check('Effort page for a story that does not exist reads nothing', async () => {
  const n = t.log.ado.length;
  t.jump({ name: 'effort', id: 'nope' });
  assert.ok(/was not found/.test(t.text('#app')));
  assert.strictEqual(t.log.ado.length, n, 'no request for a story that is not there');
  t.click(t.q('[data-act="back"]'));
});

check('Sync page: previews exactly what will be written and writes nothing yet', async () => {
  // put a typed effort back so the report carries it
  let r = Stories.applyOp(t.store(), { type: 'saveEffort', storyId: '7001', hours: 12.5, note: '' }, Stories.contextFor(data), Date.now()); assert.ok(r.ok, r.error); t.setStore(r.store);
  if (t.route().name !== 'story') { t.jump({ name: 'story', id: '7001' }); }
  t.click(t.q('[data-act="nav"][data-name="sync"][data-id="7001"]'));
  assert.ok(/Checking Azure DevOps/.test(t.text('#app')));
  await until(() => t.q('[data-act="sapply"]'), 'the preview');
  assert.strictEqual(tasks().length, 0, 'previewing created nothing');
  assert.strictEqual(stub.count('POST', 'workitems/$Task'), 0);
  assert.deepStrictEqual(t.crumbs().slice(-2), ['Story 7001', 'Sync']);
  const want = ids.slice(0, 2).map((id) => data.sessions.find((s) => s.id === id));
  assert.ok(Math.abs(dataV(t, '[data-k="credits"]') - sumCredits(want)) < 2e-3, 'credits match a plain sum over the two sessions');
  assert.strictEqual(dataV(t, '[data-k="sessions"]'), 2);
  assert.strictEqual(Number(t.text('[data-k="new"]')), 2); assert.strictEqual(Number(t.text('[data-k="updated"]')), 0); assert.strictEqual(Number(t.text('[data-k="removed"]')), 0);
  assert.ok(/Create the task/.test(t.q('[data-act="sapply"]').textContent) && /new task will be created/.test(t.text('#app')));
  assert.ok(/12\.5|12,5/.test(t.text('.band.flat')) && /entered by hand/.test(t.text('.band.flat')), 'the effort is in the report');
  const json = t.text('pre.json');
  assert.ok(/"schema": "copilot-lens\/story-usage"/.test(json) && /"traditional_effort"/.test(json));
  for (const s of want) { assert.ok(!json.includes(s.title) && !json.includes(s.prompts[0].text.slice(0, 20)), 'no session title or prompt text in what will be sent'); }
  assert.deepStrictEqual(a11yProblems(t), []);
});

check('Sync page: confirming creates one Task; the story then shows it', async () => {
  const before = t.log.ado.length;
  t.hold.applyGate = true;
  t.click(t.q('[data-act="sapply"]'));
  await until(() => t.log.ado.slice(before).some((m) => m.op === 'syncApply') && t.q('[data-act="sapply"]').disabled, 'the sync to be running');
  t.doc.body.insertAdjacentHTML('beforeend', '<span id="again" data-act="sapply">again</span>'); t.click(t.q('#again')); t.q('#again').remove();
  assert.strictEqual(t.log.ado.slice(before).filter((m) => m.op === 'syncApply').length, 1, 'a second click while it runs sends nothing');
  t.hold.applyGate = false; t.hold.release();
  await until(() => /Done/.test(t.text('#app')) && tasks().length === 1, 'the task to be created');
  assert.ok(/Created the AI Delivery Insights task/.test(t.text('#app')));
  assert.ok(!t.q('[data-k="new"]') && !/will be created/.test(t.text('#app')) && !t.q('[data-act="sapply"]'), 'after the write the preview is gone, so the page does not contradict itself');
  const body = t.log.ado.slice(before).find((m) => m.op === 'syncApply');
  assert.deepStrictEqual(Object.keys(body).sort(), ['op', 'planId', 'rid', 'storyId', 'type'], 'the page confirms by plan ID only; it cannot send the content');
  const rep = U.parseDescription(tasks()[0].fields['System.Description']);
  assert.strictEqual(rep.state, 'ok');
  assert.deepStrictEqual(rep.report.contributors[0].sessions.map((s) => s.session_id).sort(), ids.slice(0, 2).slice().sort());
  assert.strictEqual(rep.report.traditional_effort.hours, 12.5);
  assert.ok(stub.requests.every((q) => q.host === 'https://dev.azure.com' && q.method !== 'DELETE'));
  t.click(t.q('[data-act="back"]'));
  assert.strictEqual(t.route().name, 'story');
  assert.ok(new RegExp('#' + tasks()[0].id).test(t.text('#app')), 'the story shows its tracking task');
  assert.ok(/synced|just now|min ago/.test(t.text('#app')) || /2 sessions/.test(t.text('#app')));
});

check('Sync again: nothing new means nothing is written, and no session is counted twice', async () => {
  const patches = stub.count('PATCH'), posts = stub.count('POST', 'workitems/$Task');
  t.click(t.q('[data-act="nav"][data-name="sync"][data-id="7001"]'));
  await until(() => t.q('[data-act="sapply"]'), 'the second preview');
  assert.strictEqual(Number(t.text('[data-k="new"]')), 0); assert.strictEqual(Number(t.text('[data-k="unchanged"]')), 2);
  assert.ok(t.q('[data-act="sapply"]').disabled && /Already up to date/.test(t.q('[data-act="sapply"]').textContent));
  assert.ok(/existing task will be updated/.test(t.text('#app')));
  assert.strictEqual(stub.count('PATCH'), patches); assert.strictEqual(stub.count('POST', 'workitems/$Task'), posts);
});

check('Sync after more work: the third session is added to the same Task, and an untagged one is removed', async () => {
  t.click(t.q('[data-act="back"]'));
  t.tag('7001', [ids[2]]);
  t.click(t.q('[data-act="nav"][data-name="sync"][data-id="7001"]'));
  await until(() => t.q('[data-act="sapply"]') && Number(t.text('[data-k="new"]')) === 1, 'the preview with one new session');
  assert.strictEqual(Number(t.text('[data-k="unchanged"]')), 2);
  assert.ok(/Update the task/.test(t.q('[data-act="sapply"]').textContent));
  t.click(t.q('[data-act="sapply"]'));
  await until(() => /Done/.test(t.text('#app')), 'the update');
  assert.strictEqual(tasks().length, 1, 'still one Task');
  assert.deepStrictEqual(U.parseDescription(tasks()[0].fields['System.Description']).report.contributors[0].sessions.map((s) => s.session_id).sort(), ids.slice(0, 3).slice().sort());
  t.click(t.q('[data-act="back"]'));
  const r = Stories.applyOp(t.store(), { type: 'tagSessions', ids: [ids[0]], storyId: null }, Stories.contextFor(data), Date.now()); assert.ok(r.ok, r.error); t.setStore(r.store);
  t.click(t.q('[data-act="nav"][data-name="sync"][data-id="7001"]'));
  await until(() => t.q('[data-act="sapply"]') && Number(t.text('[data-k="removed"]')) === 1, 'the preview with one removal');
  t.click(t.q('[data-act="sapply"]'));
  await until(() => /Done/.test(t.text('#app')), 'the removal');
  assert.deepStrictEqual(U.parseDescription(tasks()[0].fields['System.Description']).report.contributors[0].sessions.map((s) => s.session_id).sort(), ids.slice(1, 3).slice().sort());
  assert.strictEqual(tasks().length, 1);
});

check('Sync page: a failed or expired confirmation writes nothing, says so, and offers to review again', async () => {
  t.click(t.q('[data-act="back"]'));
  t.tag('7001', [ids[3]]);
  t.click(t.q('[data-act="nav"][data-name="sync"][data-id="7001"]'));
  await until(() => t.q('[data-act="sapply"]') && !t.q('[data-act="sapply"]').disabled, 'a preview with something to write');
  t.hold.applyFail = { ok: false, error: 'This preview has expired. Open the sync page again.', expired: true };
  t.click(t.q('[data-act="sapply"]'));
  await until(() => /Not synced/.test(t.text('#app')), 'the failure');
  assert.ok(/nothing was written/.test(t.text('#app')) && /expired/.test(t.text('.ferr')) && !t.q('[data-act="sapply"]'));
  t.click(t.q('[data-act="sagain"]'));
  await until(() => t.q('[data-act="sapply"]'), 'a fresh preview');
  t.click(t.q('[data-act="sapply"]'));
  await until(() => /Done/.test(t.text('#app')), 'the sync after reviewing again');
  assert.strictEqual(tasks().length, 1);
});

check('Story page: open and refresh are requested by story, never by address', async () => {
  t.click(t.q('[data-act="back"]'));
  t.click(t.q('[data-act="aopen"][data-kind="story"]'));
  await until(() => t.log.opened.length === 1, 'the open request');
  t.click(t.q('[data-act="aopen"][data-kind="task"]'));
  await until(() => t.log.opened.length === 2, 'the task open request');
  assert.deepStrictEqual(t.log.opened, ['https://dev.azure.com/contoso/_workitems/edit/7001', `https://dev.azure.com/contoso/_workitems/edit/${tasks()[0].id}`]);
  for (const m of t.log.ado.filter((x) => x.op === 'open')) { assert.deepStrictEqual(Object.keys(m).sort(), ['kind', 'op', 'rid', 'storyId', 'type']); }
  stub.touch(7001, { 'System.State': 'Resolved' });
  t.click(t.q('[data-act="arefresh"]'));
  await until(() => /is Resolved/.test(t.toast()), 'the refresh');
  await until(() => /Resolved/.test(t.text('#app')), 'the new state on the page');
});

check('Import page: a Board filter narrows the list to one team\'s board, remembers the choice, and degrades when boards cannot be listed', async () => {
  stub.addStory(7101, 'Cart', { 'System.AreaPath': 'Shop\\Checkout\\Cart' });
  stub.addStory(7102, 'Pipeline', { 'System.AreaPath': 'Shop\\Platform' });
  stub.addStory(7103, 'Pipeline sub-area', { 'System.AreaPath': 'Shop\\Platform\\Sub' });
  stub.addStory(7104, 'Shared tools', { 'System.AreaPath': 'Shop\\Shared\\Tools' });
  const keys = (h) => h.qa('[data-act="bsel"]').map((c) => c.dataset.key).sort();
  const t3 = startHost({ enabled: true });
  t3.jump({ name: 'import' });
  await until(() => t3.qa('select[data-ado-board]').length === 1 && t3.qa('[data-act="bsel"]').length === 7, 'the boards and the whole backlog');
  assert.deepStrictEqual(t3.qa('select[data-ado-board] option').map((o) => o.textContent), ['All boards', 'Checkout Team', 'Platform Team']);
  assert.strictEqual(t3.q('select[data-ado-board]').value, '', 'no board chosen at first');
  assert.deepStrictEqual(a11yProblems(t3), []);
  t3.change(t3.q('select[data-ado-board]'), stub.TEAM_CHECKOUT);
  await until(() => t3.qa('[data-act="bsel"]').length === 1, 'only the Checkout board');
  assert.deepStrictEqual(keys(t3), ['7101']);
  assert.ok(/on Checkout Team/.test(t3.text('.panel h2')));
  t3.change(t3.q('select[data-ado-board]'), stub.TEAM_PLATFORM);
  await until(() => keys(t3).join() === '7102,7104', 'the Platform board: its own area without sub-areas, plus the shared area with them');
  assert.strictEqual(t3.state().adoBoards.Shop, stub.TEAM_PLATFORM, 'the choice is saved for next time');
  assert.ok(t3.log.ado.filter((m) => m.op === 'backlog').every((m) => Object.keys(m).sort().join() === 'board,op,project,rid,type'), 'the page sends only a board ID');
  // the next window opens on the board used last time
  const t4 = startHost({ enabled: true, state: { adoBoards: { Shop: stub.TEAM_PLATFORM } } });
  t4.jump({ name: 'import' });
  await until(() => keys(t4).join() === '7102,7104', 'the remembered board');
  assert.strictEqual(t4.q('select[data-ado-board]').value, stub.TEAM_PLATFORM);
  t4.change(t4.q('select[data-ado-board]'), '');
  await until(() => t4.qa('[data-act="bsel"]').length === 7, 'all boards again');
  assert.strictEqual(t4.state().adoBoards.Shop, '');
  // a remembered board that no longer exists, or junk in the saved state, is ignored
  for (const junk of ['bbbbbbbb-0000-0000-0000-000000000009', '../x', 5, null]) {
    const t5 = startHost({ enabled: true, state: { adoBoards: { Shop: junk } } });
    t5.jump({ name: 'import' });
    await until(() => t5.qa('[data-act="bsel"]').length === 7, 'the whole backlog');
    assert.strictEqual(t5.q('select[data-ado-board]').value, '');
    assert.strictEqual(t5.log.ado.filter((m) => m.op === 'backlog')[0].board, '');
  }
  const t6 = startHost({ enabled: true, state: { adoBoards: [1, 2] } });
  t6.jump({ name: 'import' });
  await until(() => t6.qa('[data-act="bsel"]').length === 7, 'a list in place of the saved map is ignored');
  // a token that cannot list teams: the filter is hidden, the backlog still works
  stub.opts.teamListStatus = 403;
  try {
    const t7 = startHost({ enabled: true });
    t7.jump({ name: 'import' });
    await until(() => t7.qa('[data-act="bsel"]').length === 7, 'the backlog without boards');
    assert.ok(!t7.q('select[data-ado-board]'));
    assert.ok(/Boards unavailable/.test(t7.text('.toolbar')));
    assert.deepStrictEqual(t7.errors, []);
  } finally { stub.opts.teamListStatus = 0; }
  for (const h of [t3, t4, t6]) { assert.deepStrictEqual(h.errors, []); }
});

check('Turned off again: pages explain, and no further request is made', async () => {
  t.enable(false);
  await until(() => !/On/.test(t.text('#app')) || t.qa('.pill').some((p) => /Azure DevOps: off/.test(p.textContent)) || true, 'status');
  const n = stub.requests.length, asked = t.log.ado.length;
  t.jump({ name: 'import' });
  await until(() => /turned off/.test(t.text('#app')), 'the off message on Import');
  t.jump({ name: 'sync', id: '7001' });
  await until(() => /turned off/.test(t.text('#app')), 'the off message on Sync');
  assert.ok(t.q('[data-act="nav"][data-name="connect"]'), 'a way to connect');
  assert.strictEqual(stub.requests.length, n, 'no web request while off');
  assert.deepStrictEqual(t.log.ado.slice(asked).map((m) => m.op).filter((o) => o !== 'status'), [], 'the pages did not even ask the extension to read Azure DevOps');
  t.jump({ name: 'story', id: '7001' });
  assert.ok(!t.q('[data-act="aopen"]') && !t.q('[data-act="arefresh"]') && /Azure DevOps is off/.test(t.text('#app')));
  t.jump({ name: 'effort', id: '7001' });
  await until(() => t.qa('[data-act="csel"]').length === 3, 'effort works without Azure DevOps (git only)');
});

check('A restored window never starts reading Azure DevOps or git by itself', async () => {
  for (const saved of [{ name: 'sync', id: '7001' }, { name: 'import' }, { name: 'effort', id: '7001' }]) {
    // the back list is restored too: it must not lead straight back to one of these pages either
    const t2 = startHost({ enabled: true, state: { route: saved, hist: [{ name: 'dash' }, { name: 'stories' }, { name: 'sync', id: '7001' }, { name: 'import' }, { name: 'effort', id: '7001' }] } });
    await sleep(300);
    const reads = t2.log.ado.map((m) => m.op).filter((o) => o !== 'status');
    assert.deepStrictEqual(reads, [], `restoring ${saved.name} read nothing`);
    assert.strictEqual(t2.q('.crumbs li[aria-current="page"]').textContent, saved.name === 'import' ? 'Stories' : 'Story 7001', 'it falls back to a page that needs no request');
    // Back goes through the restored history: none of those pages is in it, so no walk back can start a read either
    for (let i = 0; i < 6 && t2.q('[data-act="back"]'); i++) {
      t2.click(t2.q('[data-act="back"]'));
      await sleep(60);
      assert.ok(!['sync', 'import', 'effort'].includes(t2.route().name), `going back landed on ${t2.route().name}`);
    }
    assert.deepStrictEqual(t2.log.ado.map((m) => m.op).filter((o) => o !== 'status'), [], 'still nothing read after going back through the history');
    assert.deepStrictEqual(t2.errors, []);
  }
});

check('the page script raised no errors and kept no token', async () => {
  assert.deepStrictEqual(t.errors, []);
  assert.ok(!JSON.stringify(t.posted).includes(BEARER) && !t.doc.documentElement.outerHTML.includes(BEARER));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of checks) {
    try { await fn(); console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '\n    ', (e && e.stack || e).toString().split('\n').slice(0, 6).join('\n     ')); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} of ${checks.length} Azure DevOps page checks failed [${LOCALE}]` : `\nAll ${checks.length} Azure DevOps page checks passed [${LOCALE}].`);
  process.exit(failed ? 1 : 0);
})();
