'use strict';
/**
 * End-to-end tests of lib/adoservice.js: two developers' machines sync to one stand-in Azure DevOps, the sync is previewed
 * and confirmed, conflicts are handled, and effort is estimated from real temporary git repositories. No VS Code, no network.
 * Run: node test/test-adoservice.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const Core = require('../media/story-core.js');
const Stories = require('../lib/stories.js');
const Ado = require('../lib/ado.js');
const U = require('../lib/usage.js');
const { createService } = require('../lib/adoservice.js');
const { createStub } = require('./ado-stub.js');

const HAVE_GIT = spawnSync('git', ['--version']).status === 0;
let failed = 0;
const checks = [];
const check = (name, fn, opts) => checks.push([name, fn, opts || {}]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-delivery-insights-svc-'));
// an empty global git config: on Windows os.devNull is a device path that git refuses as a config file
const NO_CONFIG = path.join(tmp, 'empty.gitconfig'); fs.writeFileSync(NO_CONFIG, '');
const noSleep = () => Promise.resolve();
const T = (d, h, m) => Date.UTC(2026, 9, d, h || 0, m || 0);

/* ----------------------------- fixtures ----------------------------- */

function makeData(repoPath, extraPrompts) {
  const wsKey = 'file:///work/shop';
  const mk = (id, base, n) => ({
    id, wsKey, title: 'SECRET TITLE', created: base, last: base + n * 60000, overhead: null,
    prompts: Array.from({ length: n }, (_, i) => ({ i, ts: base + i * 60000, text: 'SECRET PROMPT', chars: 10, model: 'gpt-5', agent: 'Agent', tag: 'Feature', credits: 2.5, inTok: 1000, outTok: 100, cached: 0, calls: 1, quality: 'exact', files: [], edited: [], tools: [], toolCalls: 0, canceled: false })),
  });
  const data = {
    version: 1, generatedAt: 0, sources: [], diagnostics: {},
    workspaces: { [wsKey]: { key: wsKey, kind: 'folder', name: 'shop', path: '/work/shop', local: true, remote: '', repos: repoPath ? [{ name: 'shop', path: repoPath, branch: 'main', remote: '' }] : [] } },
    sessions: [mk('s-1', T(6, 9), 3), mk('s-2', T(7, 9), 2), mk('s-3', T(8, 9), 2)],
  };
  if (extraPrompts) { for (const [sid, n] of Object.entries(extraPrompts)) { const s = data.sessions.find((x) => x.id === sid); for (let k = 0; k < n; k++) { s.prompts.push({ ...s.prompts[0], i: s.prompts.length, ts: s.last + 60000 * (k + 1) }); } } }
  return data;
}

function makeEnv(o) {
  const opts = { enabled: true, trusted: true, contributor: 'inst-1111', ...(o || {}) };
  const stub = opts.stub || createStub();
  const logs = [];
  const st = { store: Core.emptyStore(), data: opts.data || makeData(opts.repo), clock: T(14, 6, 30), n: 0, token: null };
  const sets = { enabled: opts.enabled, organization: 'contoso', project: 'Shop', storyTypes: undefined, shareName: !!opts.shareName, effort: opts.effort || {} };
  const deps = {
    settings: () => sets, trusted: () => opts.trusted,
    client: async () => Ado.createClient({ org: sets.organization, fetch: stub.fetch, sleep: noSleep, auth: async () => ({ scheme: 'Bearer', token: st.token || stub.opts.bearer }) }),
    data: async () => st.data, store: () => st.store,
    commit: (op) => { const r = Stories.applyOp(st.store, op, Stories.contextFor(st.data), st.clock); if (r.ok) { st.store = r.store; return { ok: true, message: r.message }; } return { ok: false, error: r.error }; },
    contributor: () => ({ id: opts.contributor, displayName: 'Dev ' + opts.contributor }),
    currentRepos: opts.currentRepos, now: () => st.clock, random: () => `${opts.contributor}-id-${++st.n}`, log: (l) => logs.push(l),
  };
  const svc = createService(deps);
  const e = {
    svc, stub, logs, sets, st, deps,
    get store() { return st.store; },
    commit: (op) => deps.commit(op),
    addStory: (id, title, extra) => { const r = deps.commit({ type: 'saveStory', mode: 'new', story: { id, title: title || 'Story ' + id, ...(extra || {}) } }); assert.ok(r.ok, r.error); },
    tag: (storyId, ids) => { const r = deps.commit({ type: 'tagSessions', ids, storyId }); assert.ok(r.ok, r.error); },
    setData: (d) => { st.data = d; },
    tick: (ms) => { st.clock += ms; },
  };
  return e;
}
const ADO_STORIES = (stub) => { stub.addStory(5001, 'Login', { 'Microsoft.VSTS.Scheduling.StoryPoints': 5 }); stub.addStory(5002, 'Reports', { 'Microsoft.VSTS.Scheduling.StoryPoints': 3 }); };
const trackingTasks = (stub, storyId) => [...stub.items.values()].filter((i) => i.fields['System.WorkItemType'] === 'Task' && i.relations.some((r) => r.rel === 'System.LinkTypes.Hierarchy-Reverse' && r.url.endsWith('/' + storyId)));
const reportOf = (stub, taskId) => { const p = U.parseDescription(stub.items.get(taskId).fields['System.Description']); assert.strictEqual(p.state, 'ok', p.reason); return p.report; };
const ok = (r) => { assert.ok(r && r.ok, r && r.error); return r; };

/** A tagged, ready environment: story 5001 with sessions s-1 and s-2. */
function ready(o) {
  const e = makeEnv(o);
  ADO_STORIES(e.stub);
  e.addStory('5001', 'Login', { points: 5 });
  e.tag('5001', ['s-1', 's-2']);
  return e;
}

/* ----------------------------- tests ----------------------------- */

check('turned off, not trusted or no organisation: every Azure DevOps request is refused and none is made', async () => {
  const off = makeEnv({ enabled: false }); ADO_STORIES(off.stub); off.addStory('5001');
  const untrusted = makeEnv({ trusted: false }); ADO_STORIES(untrusted.stub); untrusted.addStory('5001');
  const noOrg = makeEnv(); noOrg.sets.organization = ''; ADO_STORIES(noOrg.stub); noOrg.addStory('5001');
  for (const [e, re] of [[off, /turned off/], [untrusted, /Restricted Mode/], [noOrg, /organisation/]]) {
    for (const r of [await e.svc.test(), await e.svc.listBacklog({ project: 'Shop' }), await e.svc.importStories({ ids: [5001] }), await e.svc.refreshStory({ storyId: '5001' }), await e.svc.syncPreview({ storyId: '5001' }), await e.svc.syncApply({ storyId: '5001', planId: 'x' })]) {
      assert.ok(!r.ok && re.test(r.error), JSON.stringify(r));
    }
    assert.strictEqual(e.stub.requests.length, 0, 'no request left the process');
  }
  for (const e of [off, untrusted, noOrg]) { assert.strictEqual(e.svc.urlFor({ storyId: '5001' }), null, 'no address is built while the feature cannot be used'); }
  const on = makeEnv(); ADO_STORIES(on.stub); on.addStory('5001');
  assert.strictEqual(on.svc.urlFor({ storyId: '5001' }), 'https://dev.azure.com/contoso/_workitems/edit/5001');
  assert.strictEqual(on.svc.urlFor({ storyId: 'nope' }), null); assert.strictEqual(on.svc.urlFor({ storyId: '5001', kind: 'task' }), null, 'no task yet');
});

check('test connection: the projects the person can see, who they are, and a failed sign-in says so without the token', async () => {
  const e = makeEnv();
  const r = ok(await e.svc.test());
  assert.deepStrictEqual([r.organization, r.projects, r.user], ['contoso', ['Shop', 'Throwaway'], { name: 'Test Person' }]);
  e.st.token = 'rotated-token';
  const bad = await e.svc.test();
  assert.ok(!bad.ok && bad.kind === 'auth' && /Connect again/.test(bad.error));
  assert.ok(!JSON.stringify([bad, e.logs]).includes('rotated-token'));
});

check('a token that cannot list projects still works when a project is set; with no project it is asked for; a bad token still fails', async () => {
  const stub = createStub({ projectListStatus: 401 }); ADO_STORIES(stub);
  // a project is set: the list is refused, so one story is read from that project instead, and nothing is written
  const e = makeEnv({ stub });
  const r = ok(await e.svc.test());
  assert.deepStrictEqual([r.organization, r.projects, r.projectsListed], ['contoso', ['Shop'], false]);
  assert.deepStrictEqual(stub.requests.map((q) => `${q.method} ${q.path}`).filter((x) => !/connectionData/.test(x)), ['GET /contoso/_apis/projects', 'POST /contoso/Shop/_apis/wit/wiql', 'GET /contoso/Shop/_apis/wit/workitems']);
  assert.ok(stub.requests.every((q) => ['GET', 'POST'].includes(q.method)) && stub.count('PATCH') === 0 && stub.count('POST', 'workitems/$') === 0);
  // no project set: it says what is missing, and how to fix it
  const none = makeEnv({ stub }); none.sets.project = '';
  const needs = await none.svc.test();
  assert.ok(!needs.ok && needs.needsProject === true && /Project and Team: Read/.test(needs.error) && /aiDeliveryInsights\.ado\.project/.test(needs.error), JSON.stringify(needs));
  // a token that is simply wrong is still a failure, not a success on a technicality
  const bad = makeEnv({ stub: createStub({ projectListStatus: 401 }) }); bad.st.token = 'wrong-token';
  const refused = await bad.svc.test();
  assert.ok(!refused.ok && refused.kind === 'auth', JSON.stringify(refused));
  // a project the token cannot read is reported as that, not as success
  const other = makeEnv({ stub }); other.sets.project = 'Throwaway';
  assert.ok((await other.svc.test()).ok, 'a project that exists and can be queried');
  other.sets.project = 'Nowhere';
  const missing = await other.svc.test();
  assert.ok(!missing.ok && missing.kind === 'notfound', JSON.stringify(missing));
  // a network failure is not mistaken for a narrow token, and is not given advice about token permissions
  const down = makeEnv({ stub: createStub({ projectListStatus: 401 }) }); down.stub.state.chaos = () => { throw new TypeError('fetch failed'); };
  assert.strictEqual((await down.svc.test()).kind, 'network');
  down.sets.project = '';
  const downNoProject = await down.svc.test();
  assert.ok(!downNoProject.ok && downNoProject.kind === 'network' && !downNoProject.needsProject && !/Project and Team/.test(downNoProject.error), JSON.stringify(downNoProject));
});

check('import from the backlog: only stories that were listed, marked when already here, numbers become IDs and links', async () => {
  const e = makeEnv(); ADO_STORIES(e.stub);
  e.stub.addItem({ id: 5003, fields: { 'System.Title': 'Zero points', 'System.WorkItemType': 'Product Backlog Item', 'Microsoft.VSTS.Scheduling.Effort': 0 } });
  e.stub.addItem({ id: 5004, fields: { 'System.Title': 'A bug', 'System.WorkItemType': 'Bug' } });
  assert.ok(!(await e.svc.importStories({ ids: [5001] })).ok, 'nothing was listed yet, so nothing can be imported');
  assert.ok(!(await e.svc.listBacklog({ project: '../x' })).ok);
  const list = ok(await e.svc.listBacklog({ project: 'Shop' }));
  assert.deepStrictEqual(list.items.map((i) => [i.id, i.title, i.type, i.points, i.imported]).sort((a, b) => a[0] - b[0]), [[5001, 'Login', 'User Story', 5, false], [5002, 'Reports', 'User Story', 3, false], [5003, 'Zero points', 'Product Backlog Item', null, false]]);
  const r = ok(await e.svc.importStories({ ids: [5001, 5003, 9999, 'x', 5004, 5001] }));
  assert.match(r.message, /Imported 2 stories/);
  assert.deepStrictEqual(Object.keys(e.store.stories).sort(), ['5001', '5003']);
  assert.strictEqual(e.store.stories['5001'].points, 5);
  assert.strictEqual(e.store.stories['5003'].points, null);
  assert.strictEqual(e.store.stories['5001'].adoId, 5001);
  assert.strictEqual(e.store.ado['5001'].project, 'Shop');
  assert.strictEqual(e.store.ado['5001'].state, 'Active');
  const again = ok(await e.svc.listBacklog({ project: 'Shop' }));
  assert.deepStrictEqual(again.items.filter((i) => i.imported).map((i) => i.id).sort(), [5001, 5003]);
  assert.match((await e.svc.importStories({ ids: [5001] })).message, /Imported 0 stories from Azure DevOps \(1 already here/);
});

check('boards: the import list can be narrowed to one board; a bad board is refused; with no board nothing changes', async () => {
  const e = makeEnv(); ADO_STORIES(e.stub);
  e.stub.addStory(5101, 'Cart', { 'System.AreaPath': 'Shop\\Checkout\\Cart' });
  e.stub.addStory(5102, 'Pipeline', { 'System.AreaPath': 'Shop\\Platform' });
  const boards = ok(await e.svc.listBoards({ project: 'Shop' }));
  assert.deepStrictEqual(boards.boards.map((b) => b.name), ['Checkout Team', 'Platform Team']);
  assert.ok(boards.boards.every((b) => Object.keys(b).sort().join() === 'id,name'));
  assert.ok(!(await e.svc.listBoards({ project: '../x' })).ok);
  const all = ok(await e.svc.listBacklog({ project: 'Shop' }));
  assert.deepStrictEqual(all.items.map((i) => i.id).sort(), [5001, 5002, 5101, 5102], 'no board: everything');
  assert.strictEqual(all.board, '');
  const checkout = ok(await e.svc.listBacklog({ project: 'Shop', board: e.stub.TEAM_CHECKOUT }));
  assert.deepStrictEqual(checkout.items.map((i) => i.id), [5101]);
  assert.strictEqual(checkout.board, e.stub.TEAM_CHECKOUT);
  const before = e.stub.requests.length;
  for (const bad of ['../x', 'Checkout Team', 5]) { assert.ok(!(await e.svc.listBacklog({ project: 'Shop', board: bad })).ok, String(bad)); }
  assert.strictEqual(e.stub.requests.length, before, 'a bad board sends nothing');
  const gone = await e.svc.listBacklog({ project: 'Shop', board: 'bbbbbbbb-0000-0000-0000-000000000009' });
  assert.ok(!gone.ok && gone.kind === 'notfound', JSON.stringify(gone));
  // only what the narrowed list showed can be imported
  assert.deepStrictEqual(ok(await e.svc.listBacklog({ project: 'Shop', board: e.stub.TEAM_PLATFORM })).items.map((i) => i.id), [5102]);
  assert.match((await e.svc.importStories({ ids: [5101] })).error || '', /Choose at least one story/);
  assert.match(ok(await e.svc.importStories({ ids: [5102] })).message, /Imported 1 story/);
});

check('boards: turned off or not trusted, the board list is refused and nothing is sent', async () => {
  const off = makeEnv({ enabled: false }); const untrusted = makeEnv({ trusted: false });
  for (const [e, re] of [[off, /turned off/], [untrusted, /Restricted Mode/]]) {
    const r = await e.svc.listBoards({ project: 'Shop' });
    assert.ok(!r.ok && re.test(r.error), JSON.stringify(r));
    assert.strictEqual(e.stub.requests.length, 0);
  }
});

check('refresh a story: state and iteration are remembered; unknown items and stories with no Azure DevOps ID say what to do', async () => {
  const e = ready();
  e.stub.touch(5001, { 'System.State': 'Resolved', 'System.IterationPath': 'Shop\\Sprint 9' });
  const r = ok(await e.svc.refreshStory({ storyId: '5001' }));
  assert.deepStrictEqual([r.item.state, r.item.iteration, r.item.title], ['Resolved', 'Sprint 9', 'Login']);
  assert.strictEqual(e.store.ado['5001'].state, 'Resolved');
  e.addStory('US-12', 'No number');
  assert.match((await e.svc.refreshStory({ storyId: 'US-12' })).error, /no Azure DevOps ID/);
  e.addStory('8888', 'Missing in ADO');
  assert.match((await e.svc.refreshStory({ storyId: '8888' })).error, /no work item 8888/);
  assert.match((await e.svc.refreshStory({ storyId: 'nope' })).error, /does not exist/);
  assert.match((await e.svc.refreshStory({})).error, /does not exist/);
});

check('first sync: the preview writes nothing; confirming creates ONE Task under the story with the numbers; the sync is remembered', async () => {
  const e = ready();
  const p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.strictEqual(e.stub.count('POST', 'workitems/$Task'), 0, 'previewing creates nothing');
  assert.strictEqual(e.stub.count('PATCH'), 0);
  assert.deepStrictEqual([p.changed, p.creating, p.replacesUnreadable], [true, true, false]);
  assert.deepStrictEqual(p.changes, { added: 2, updated: 0, unchanged: 0, removed: 0, others: 0 });
  assert.deepStrictEqual([p.totals.session_count, p.totals.user_initiated_interaction_count, p.totals.credits, p.totals.input_tokens, p.totals.output_tokens], [2, 5, 12.5, 5000, 500]); // (3 + 2 prompts) x 2.5 credits
  assert.deepStrictEqual([p.target.adoId, p.target.title, p.target.taskId], [5001, 'Login', null]);
  assert.ok(p.json.includes('"copilot-lens/story-usage"') && !p.jsonTruncated);
  const a = ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  assert.deepStrictEqual([a.created, a.noop, a.totals.credits], [true, false, 12.5]);
  assert.match(a.message, /Created the AI Delivery Insights task #\d+: 2 new, 0 updated, 0 unchanged/);
  const tasks = trackingTasks(e.stub, 5001);
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].fields['System.Tags'], 'copilot-lens');
  const rep = reportOf(e.stub, tasks[0].id);
  assert.deepStrictEqual([rep.totals.credits, rep.story.ado_id, rep.story.story_points, rep.contributors.length, rep.contributors[0].contributor_id, rep.contributors[0].display_name], [12.5, 5001, 5, 1, 'inst-1111', ''], 'a name is only sent when the person opts in');
  const link = e.store.ado['5001'];
  assert.deepStrictEqual([link.taskId, link.sessions.sort(), link.hash.length, link.syncedAt], [tasks[0].id, ['s-1', 's-2'], 64, e.st.clock]);
  const everything = JSON.stringify(rep) + tasks[0].fields['System.Description'];
  assert.ok(!/SECRET|work\/shop/.test(everything), 'no prompt text, title or path was sent');
  assert.strictEqual(e.stub.count('GET', 'connectionData'), 0);
});

check('syncing again with nothing new changes nothing in Azure DevOps and creates no duplicate', async () => {
  const e = ready();
  const first = ok(await e.svc.syncApply({ storyId: '5001', planId: ok(await e.svc.syncPreview({ storyId: '5001' })).planId }));
  const writes = () => e.stub.count('PATCH') + e.stub.count('POST', 'workitems/$Task');
  const before = writes();
  e.tick(3600000);
  const p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.deepStrictEqual([p.changed, p.creating, p.target.taskId, p.changes.unchanged], [false, false, first.taskId, 2]);
  const a = ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  assert.deepStrictEqual([a.noop, a.created], [true, false]);
  assert.match(a.message, /already has the latest/);
  assert.strictEqual(writes(), before, 'not a single write');
  assert.strictEqual(trackingTasks(e.stub, 5001).length, 1);
  assert.strictEqual(reportOf(e.stub, first.taskId).totals.credits, 12.5);
});

check('a session that grew is replaced in place: one update, totals follow, nothing is counted twice', async () => {
  const e = ready();
  const first = ok(await e.svc.syncApply({ storyId: '5001', planId: ok(await e.svc.syncPreview({ storyId: '5001' })).planId }));
  e.setData(makeData(null, { 's-1': 1 })); // s-1 gets a fourth prompt
  e.tick(60000);
  const p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.deepStrictEqual(p.changes, { added: 0, updated: 1, unchanged: 1, removed: 0, others: 0 });
  const a = ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  assert.match(a.message, /Updated the AI Delivery Insights task #\d+: 0 new, 1 updated, 1 unchanged/);
  assert.strictEqual(e.stub.count('PATCH'), 1);
  const patch = e.stub.requests.find((r) => r.method === 'PATCH');
  assert.deepStrictEqual(patch.body[0], { op: 'test', path: '/rev', value: 1 }, 'the update is guarded by the revision it read');
  const rep = reportOf(e.stub, first.taskId);
  assert.deepStrictEqual([rep.totals.credits, rep.totals.user_initiated_interaction_count, rep.totals.session_count], [15, 6, 2]); // (4 + 2 prompts) x 2.5, never 12.5 + 15
  assert.strictEqual(trackingTasks(e.stub, 5001).length, 1);
});

check('untagging a session removes it from the report on the next sync', async () => {
  const e = ready();
  const first = ok(await e.svc.syncApply({ storyId: '5001', planId: ok(await e.svc.syncPreview({ storyId: '5001' })).planId }));
  e.commit({ type: 'tagSessions', ids: ['s-2'], storyId: null });
  const p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.deepStrictEqual(p.changes, { added: 0, updated: 0, unchanged: 1, removed: 1, others: 0 });
  ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  const rep = reportOf(e.stub, first.taskId);
  assert.deepStrictEqual([rep.totals.session_count, rep.totals.credits, rep.contributors[0].sessions.map((s) => s.session_id)], [1, 7.5, ['s-1']]);
  assert.deepStrictEqual(e.store.ado['5001'].sessions, ['s-1']);
});

check('two developers on one story: each adds their own sessions, neither loses the other\'s, and repeated syncs stay put', async () => {
  const stub = createStub(); ADO_STORIES(stub);
  const a = makeEnv({ stub, contributor: 'inst-aaaa' }); a.addStory('5001', 'Login', { points: 5 }); a.tag('5001', ['s-1']);
  const b = makeEnv({ stub, contributor: 'inst-bbbb', data: (() => { const d = makeData(null); d.sessions = d.sessions.map((s) => ({ ...s, id: 'b-' + s.id })); return d; })() });
  b.addStory('5001', 'Login (mine)'); b.tag('5001', ['b-s-2', 'b-s-3']);
  const sync = async (env) => ok(await env.svc.syncApply({ storyId: '5001', planId: ok(await env.svc.syncPreview({ storyId: '5001' })).planId }));
  const first = await sync(a);
  const second = await sync(b);
  assert.strictEqual(second.created, false, 'the second developer updates the first one\'s task');
  assert.strictEqual(second.taskId, first.taskId);
  let rep = reportOf(stub, first.taskId);
  assert.deepStrictEqual(rep.contributors.map((c) => [c.contributor_id, c.sessions.length]), [['inst-aaaa', 1], ['inst-bbbb', 2]]);
  assert.deepStrictEqual([rep.totals.session_count, rep.totals.credits], [3, 17.5]); // 7.5 + 5 + 5
  const w = stub.count('PATCH');
  assert.strictEqual((await sync(a)).noop, true);
  assert.strictEqual((await sync(b)).noop, true);
  assert.strictEqual(stub.count('PATCH'), w);
  const preview = ok(await a.svc.syncPreview({ storyId: '5001' }));
  assert.strictEqual(preview.changes.others, 2, 'A sees B\'s two sessions as other people\'s');
  assert.deepStrictEqual(preview.contributors.map((c) => [c.mine, c.sessions]), [[true, 1], [false, 2]]);
  // B untags one of theirs; A's session and B's other one remain
  b.commit({ type: 'tagSessions', ids: ['b-s-3'], storyId: null });
  await sync(b);
  rep = reportOf(stub, first.taskId);
  assert.deepStrictEqual(rep.contributors.map((c) => [c.contributor_id, c.sessions.map((s) => s.session_id)]), [['inst-aaaa', ['s-1']], ['inst-bbbb', ['b-s-2']]]);
  assert.strictEqual(trackingTasks(stub, 5001).length, 1);
});

check('someone changes the task between preview and confirm: the sync is merged again and written, whichever status Azure DevOps uses', async () => {
  for (const status of [412, 409, 400]) {
    const stub = createStub({ revFailureStatus: status }); ADO_STORIES(stub);
    const a = makeEnv({ stub, contributor: 'inst-aaaa' }); a.addStory('5001', 'Login'); a.tag('5001', ['s-1']);
    const first = ok(await a.svc.syncApply({ storyId: '5001', planId: ok(await a.svc.syncPreview({ storyId: '5001' })).planId }));
    const b = makeEnv({ stub, contributor: 'inst-bbbb', data: (() => { const d = makeData(null); d.sessions = [{ ...d.sessions[1], id: 'b-1' }]; return d; })() });
    b.addStory('5001', 'Login'); b.tag('5001', ['b-1']);
    a.setData(makeData(null, { 's-1': 2 })); a.tick(1000);
    const p = ok(await a.svc.syncPreview({ storyId: '5001' }));
    // while A reads the preview, B syncs
    ok(await b.svc.syncApply({ storyId: '5001', planId: ok(await b.svc.syncPreview({ storyId: '5001' })).planId }));
    const r = ok(await a.svc.syncApply({ storyId: '5001', planId: p.planId }));
    assert.strictEqual(r.noop, false);
    const rep = reportOf(stub, first.taskId);
    assert.deepStrictEqual(rep.contributors.map((c) => [c.contributor_id, c.sessions.map((s) => s.session_id)]), [['inst-aaaa', ['s-1']], ['inst-bbbb', ['b-1']]], `status ${status}: both are there`);
    assert.strictEqual(rep.totals.credits, 17.5, `status ${status}: A's session now has 5 prompts (12.5) plus B's 2 (5)`);
    assert.ok(stub.count('PATCH') >= 3, `status ${status}: the refused write was tried again`);
    assert.strictEqual(trackingTasks(stub, 5001).length, 1);
  }
});

check('if what THIS machine contributes changed as well, nothing is written and the person is asked to review again', async () => {
  const stub = createStub(); ADO_STORIES(stub);
  const a = makeEnv({ stub, contributor: 'inst-aaaa' }); a.addStory('5001', 'Login'); a.tag('5001', ['s-1']);
  const first = ok(await a.svc.syncApply({ storyId: '5001', planId: ok(await a.svc.syncPreview({ storyId: '5001' })).planId }));
  a.setData(makeData(null, { 's-1': 1 })); a.tick(1000);
  const p = ok(await a.svc.syncPreview({ storyId: '5001' }));
  const before = stub.items.get(first.taskId).fields['System.Description'];
  stub.state.beforePatch = (it) => { it.rev += 1; a.tag('5001', ['s-3']); stub.state.beforePatch = null; };   // somebody edits the task, and I tag another session
  const r = await a.svc.syncApply({ storyId: '5001', planId: p.planId });
  assert.ok(!r.ok && r.replan, JSON.stringify(r));
  assert.match(r.error, /Nothing was written/);
  assert.strictEqual(stub.items.get(first.taskId).fields['System.Description'], before, 'the description was not touched');
  // reviewing again works
  const again = ok(await a.svc.syncPreview({ storyId: '5001' }));
  assert.strictEqual(again.changes.added, 1, 'the newly tagged session is in the new preview');
});

check('someone else created the tracking task after the preview: it is updated, never duplicated', async () => {
  const stub = createStub(); ADO_STORIES(stub);
  const a = makeEnv({ stub, contributor: 'inst-aaaa' }); a.addStory('5001', 'Login'); a.tag('5001', ['s-1']);
  const b = makeEnv({ stub, contributor: 'inst-bbbb', data: (() => { const d = makeData(null); d.sessions = [{ ...d.sessions[1], id: 'b-1' }]; return d; })() });
  b.addStory('5001', 'Login'); b.tag('5001', ['b-1']);
  const pa = ok(await a.svc.syncPreview({ storyId: '5001' }));
  assert.strictEqual(pa.creating, true);
  const made = ok(await b.svc.syncApply({ storyId: '5001', planId: ok(await b.svc.syncPreview({ storyId: '5001' })).planId }));
  const r = ok(await a.svc.syncApply({ storyId: '5001', planId: pa.planId }));
  assert.deepStrictEqual([r.created, r.taskId], [false, made.taskId]);
  assert.strictEqual(trackingTasks(stub, 5001).length, 1, 'still one task');
  assert.deepStrictEqual(reportOf(stub, made.taskId).contributors.map((c) => c.contributor_id), ['inst-aaaa', 'inst-bbbb']);
});

check('a plan cannot be forged, replayed or reused: the page confirms with an ID only, and what is sent is what was previewed', async () => {
  const e = ready();
  const p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  e.addStory('5002', 'Reports');
  assert.match((await e.svc.syncApply({ storyId: '5002', planId: p.planId })).error, /expired/, 'a plan for another story');
  assert.match((await e.svc.syncApply({ storyId: '5001', planId: 'made-up' })).error, /expired/);
  assert.match((await e.svc.syncApply({ storyId: '5001' })).error, /expired/);
  assert.match((await e.svc.syncApply({ storyId: '5001', planId: { toString: () => p.planId } })).error, /expired/);
  const a = ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId, html: '<script>alert(1)</script>', taskId: 1, json: '{}', description: 'x', sessions: ['evil'] }));
  const post = e.stub.requests.find((r) => r.method === 'POST' && r.path.includes('workitems/$Task'));
  const sent = post.body.find((o) => o.path === '/fields/System.Description').value;
  assert.ok(!/script|evil/.test(sent), 'extra fields from the page are ignored');
  assert.strictEqual(U.parseDescription(sent).report.totals.credits, 12.5);
  assert.match((await e.svc.syncApply({ storyId: '5001', planId: p.planId })).error, /expired/, 'a plan is used once');
  assert.ok(a.created);
  // old plans expire
  const p2 = ok(await e.svc.syncPreview({ storyId: '5001' }));
  e.tick(16 * 60 * 1000);
  assert.match((await e.svc.syncApply({ storyId: '5001', planId: p2.planId })).error, /expired/);
});

check('two clicks at once do not write twice', async () => {
  const e = ready();
  const p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  const [x, y] = await Promise.all([e.svc.syncApply({ storyId: '5001', planId: p.planId }), e.svc.syncApply({ storyId: '5001', planId: p.planId })]);
  assert.strictEqual([x, y].filter((r) => r.ok).length, 1);
  assert.strictEqual(trackingTasks(e.stub, 5001).length, 1);
  assert.strictEqual(e.stub.count('POST', 'workitems/$Task'), 1);
});

check('existing task text that is not ours is flagged and replaced; a newer-version report is never overwritten', async () => {
  const e = ready();
  const s = await (await e.deps.client()).getStory(5001);
  const task = await (await e.deps.client()).createTrackingTask({ story: s, descriptionHtml: '<p>Somebody wrote their own notes here</p>' });
  const p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.deepStrictEqual([p.creating, p.replacesUnreadable, p.target.taskId], [false, true, task.id]);
  ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  assert.strictEqual(reportOf(e.stub, task.id).totals.credits, 12.5);
  // a report written by a newer AI Delivery Insights
  e.stub.items.get(task.id).fields['System.Description'] = `<pre>${JSON.stringify({ schema: U.SCHEMA, schema_version: 9, contributors: [] })}</pre>`;
  e.stub.items.get(task.id).rev += 1;
  const refused = await e.svc.syncPreview({ storyId: '5001' });
  assert.ok(!refused.ok && /newer version/.test(refused.error));
  assert.ok(e.stub.items.get(task.id).fields['System.Description'].includes('"schema_version":9'));
});

check('duplicate tracking tasks are reported, the lowest-numbered is used, the others are left alone', async () => {
  const e = ready();
  const c = await e.deps.client();
  const s = await c.getStory(5001);
  const t1 = await c.createTrackingTask({ story: s, descriptionHtml: '<p>one</p>' });
  const t2 = await c.createTrackingTask({ story: await c.getStory(5001), descriptionHtml: '<p>two</p>' });
  const p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.deepStrictEqual([p.target.taskId, p.target.duplicates], [t1.id, [t2.id]]);
  ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  assert.strictEqual(e.stub.items.get(t2.id).fields['System.Description'], '<p>two</p>');
  assert.strictEqual(e.stub.items.get(t2.id).rev, 1);
});

check('nothing to sync, a story with no Azure DevOps ID, and an effort-only sync', async () => {
  const e = makeEnv(); ADO_STORIES(e.stub); e.addStory('5001', 'Login');
  const none = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.ok(none.nothing && /nothing to sync/.test(none.message));
  e.addStory('US-12', 'No number'); e.tag('US-12', ['s-1']);
  assert.match((await e.svc.syncPreview({ storyId: 'US-12' })).error, /no Azure DevOps ID/);
  e.commit({ type: 'saveStory', mode: 'edit', story: { id: 'US-12', title: 'No number', adoId: 5002 } });
  assert.ok(ok(await e.svc.syncPreview({ storyId: 'US-12' })).creating, 'typing the Azure DevOps ID makes it syncable');
  e.commit({ type: 'saveEffort', storyId: '5001', hours: 12, note: 'my note' });
  const p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.deepStrictEqual([p.totals.session_count, p.effort.hours, p.effort.source, p.effortChange], [0, 12, 'manual', 'added']);
  const a = ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  assert.strictEqual(reportOf(e.stub, a.taskId).traditional_effort.note, 'my note');
  assert.match((await e.svc.syncPreview({ storyId: 'nope' })).error, /does not exist/);
});

check('Azure DevOps errors reach the person as plain messages with a kind, never a stack or a token', async () => {
  const e = ready();
  e.stub.state.chaos = () => new Response(JSON.stringify({ message: 'TF401019: no access' }), { status: 403, headers: { 'content-type': 'application/json' } });
  const r = await e.svc.syncPreview({ storyId: '5001' });
  assert.ok(!r.ok && r.kind === 'forbidden' && /permission/.test(r.error));
  e.stub.state.chaos = null;
  const e2 = ready();
  e2.st.token = 'other-token';
  const bad = await e2.svc.syncPreview({ storyId: '5001' });
  assert.strictEqual(bad.kind, 'auth');
  const boom = createService({ ...e.deps, data: async () => { throw new Error('secret internal detail /home/x/y'); } });
  const r2 = await boom.syncPreview({ storyId: '5001' });
  assert.ok(!r2.ok && !/secret internal|\/home/.test(r2.error) && /unexpected/.test(r2.error));
  assert.ok(e.logs.length >= 0);
});

check('the link to open a story or its task in the browser is built here from the organisation, never from page input', async () => {
  const e = ready();
  assert.strictEqual(e.svc.urlFor({ storyId: '5001' }), 'https://dev.azure.com/contoso/_workitems/edit/5001');
  assert.strictEqual(e.svc.urlFor({ storyId: '5001', kind: 'task' }), null, 'no task yet');
  const a = ok(await e.svc.syncApply({ storyId: '5001', planId: ok(await e.svc.syncPreview({ storyId: '5001' })).planId }));
  assert.strictEqual(e.svc.urlFor({ storyId: '5001', kind: 'task' }), `https://dev.azure.com/contoso/_workitems/edit/${a.taskId}`);
  assert.strictEqual(e.svc.urlFor({ storyId: 'nope' }), null);
  assert.strictEqual(e.svc.urlFor({ storyId: '5001', kind: 'https://evil.example' }), 'https://dev.azure.com/contoso/_workitems/edit/5001');
  e.sets.organization = 'evil.com/x';
  assert.strictEqual(e.svc.urlFor({ storyId: '5001' }), null);
});

check('status reports the settings and trust, never a token', () => {
  const e = makeEnv({ enabled: false, trusted: false, effort: { prodLinesPerDay: 200, hoursPerPoint: -4 } });
  assert.deepStrictEqual(e.svc.status(), {
    enabled: false, trusted: false, organization: 'contoso', project: 'Shop', storyTypes: Ado.DEFAULT_STORY_TYPES, shareName: false,
    effort: { prodLinesPerDay: 200, testLinesPerDay: 250, hoursPerDay: 8, overheadPercent: 25, hoursPerPoint: 0 },
  });
});

/* ----------------------------- effort with real git ----------------------------- */

function sh(cwd, args, env) { return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: NO_CONFIG, GIT_CONFIG_NOSYSTEM: '1', ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] }); }
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';
function repoWith(commits) {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  sh(dir, ['init', '-q', '.']); sh(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']); sh(dir, ['config', 'user.name', 'Test']); sh(dir, ['config', 'user.email', 'me@example.com']); sh(dir, ['config', 'commit.gpgsign', 'false']);
  for (const c of commits) {
    for (const [f, content] of Object.entries(c.files)) { const p = path.join(dir, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-q', '-m', c.message], { GIT_AUTHOR_DATE: new Date(c.when).toISOString(), GIT_COMMITTER_DATE: new Date(c.when).toISOString() });
  }
  return dir;
}
const effortRepo = () => repoWith([
  { message: 'AB#5001 login', when: T(1, 10), files: { 'src/login.js': lines(100), 'test/login.test.js': lines(60) } },
  { message: 'AB#5001 fix', when: T(2, 10), files: { 'src/login.js': lines(110) } },
  { message: 'during the session, no number', when: T(6, 9, 30), files: { 'src/extra.js': lines(30) } },
  { message: 'unrelated', when: T(3, 10), files: { 'src/other.js': lines(500) } },
]);

check('effort: the story\'s commits are found, shown, counted for the ticked ones, and saved as an estimate that then syncs', async () => {
  const repo = effortRepo();
  const e = ready({ repo });
  const f = ok(await e.svc.effortFind({ storyId: '5001' }));
  assert.deepStrictEqual(f.commits.map((c) => [c.subject, c.match]).sort(), [['AB#5001 fix', 'id'], ['AB#5001 login', 'id'], ['during the session, no number', 'time']]);
  assert.ok(f.repos.every((r) => r.ok));
  assert.deepStrictEqual(f.selected.length, 3);
  const login = f.commits.find((c) => /login$/.test(c.subject));
  assert.deepStrictEqual([login.prodLines, login.testLines, login.files, login.repo, login.added], [100, 60, 2, 'shop', 160]);
  // all three: prod 100 + (10 added, 0 deleted... the file grows 100 -> 110 = +10) + 30 = 140; tests 60; files login.js, login.test.js, extra.js = 3
  assert.strictEqual(f.estimate.inputs.prodLines, 140);
  assert.strictEqual(f.estimate.confidence, 'medium');
  const idOnly = f.commits.filter((c) => c.match === 'id').map((c) => c.key);
  const c = ok(await e.svc.effortCompute({ storyId: '5001', cacheId: f.cacheId, selected: [...idOnly, 'not-a-key', 5, null] }));
  // prod 110 / 150 x 8 = 5.8667; tests 60 / 250 x 8 = 1.92; files 2 x 0.25 = 0.5; subtotal 8.2867 x 1.25 = 10.358 -> 10.4; low 7.2503 -> 7.3; high 15.537 -> 15.5
  assert.deepStrictEqual([c.estimate.ok, c.estimate.hours, c.estimate.low, c.estimate.high, c.estimate.confidence], [true, 10.4, 7.3, 15.5, 'high']);
  assert.ok(e.store.efforts['5001'] === undefined, 'computing saves nothing');
  const s = ok(await e.svc.effortSave({ storyId: '5001', cacheId: f.cacheId, selected: idOnly }));
  assert.match(s.message, /Estimated 10\.4 hours/);
  const eff = e.store.efforts['5001'];
  assert.deepStrictEqual([eff.hours, eff.source, eff.method, eff.confidence, eff.inputs.commits, eff.inputs.points, eff.note], [10.4, 'estimated', 'size-v1', 'high', 2, 5, 'Estimated from 2 commits.']);
  // and it goes to Azure DevOps with the sync
  const a = ok(await e.svc.syncApply({ storyId: '5001', planId: ok(await e.svc.syncPreview({ storyId: '5001' })).planId }));
  const te = reportOf(e.stub, a.taskId).traditional_effort;
  assert.deepStrictEqual([te.hours, te.low_hours, te.high_hours, te.method, te.source, te.inputs.prod_lines, te.inputs.story_points], [10.4, 7.3, 15.5, 'size-v1', 'estimated', 110, 5]);
}, { git: true });

check('effort: nothing ticked or nothing found says what to do; a typed number stays until the person replaces it', async () => {
  const repo = effortRepo();
  const e = ready({ repo });
  const f = ok(await e.svc.effortFind({ storyId: '5001' }));
  const none = ok(await e.svc.effortCompute({ storyId: '5001', cacheId: f.cacheId, selected: [] }));
  assert.ok(!none.estimate.ok && /No commits are ticked/.test(none.estimate.reason));
  assert.match((await e.svc.effortSave({ storyId: '5001', cacheId: f.cacheId, selected: [] })).error, /No commits are ticked/);
  e.commit({ type: 'saveEffort', storyId: '5001', hours: 40, note: 'from the team' });
  assert.strictEqual(ok(await e.svc.effortFind({ storyId: '5001' })).current.hours, 40, 'the page is shown the number that is there now');
  assert.strictEqual(e.store.efforts['5001'].source, 'manual');
  const noRepo = ready({ repo: null });
  assert.match((await noRepo.svc.effortFind({ storyId: '5001' })).error, /No local git repository/);
  const viaWindow = ready({ repo: null, currentRepos: () => [{ path: repo, label: 'open folder' }] });
  const w = ok(await viaWindow.svc.effortFind({ storyId: '5001' }));
  assert.strictEqual(w.commits.filter((c) => c.match === 'id').length, 2, 'falls back to the repository open in this window');
}, { git: true });

check('effort: a list of commits belongs to one story, expires, and works with Azure DevOps turned off but not in Restricted Mode', async () => {
  const repo = effortRepo();
  const e = ready({ repo, enabled: false });
  e.addStory('5002', 'Reports'); e.tag('5002', ['s-3']);
  const f = ok(await e.svc.effortFind({ storyId: '5001' }));
  assert.match((await e.svc.effortCompute({ storyId: '5002', cacheId: f.cacheId, selected: f.selected })).error, /expired/, 'the list is for story 5001 only');
  assert.match((await e.svc.effortSave({ storyId: '5002', cacheId: f.cacheId, selected: f.selected })).error, /expired/);
  assert.match((await e.svc.effortCompute({ storyId: '5001', cacheId: 'x', selected: [] })).error, /expired/);
  e.tick(31 * 60 * 1000);
  assert.match((await e.svc.effortSave({ storyId: '5001', cacheId: f.cacheId, selected: f.selected })).error, /expired/);
  assert.strictEqual(e.stub.requests.length, 0, 'effort never touches Azure DevOps');
  const t = ready({ repo, trusted: false });
  assert.match((await t.svc.effortFind({ storyId: '5001' })).error, /Restricted Mode/);
}, { git: true });

check('effort: workspaces that are remote or have no repository are skipped, and an unreadable repository is reported, not fatal', async () => {
  const repo = effortRepo();
  const e = ready({ repo });
  const d = makeData(repo);
  d.workspaces['file:///work/shop'].local = false;
  e.setData(d);
  assert.match((await e.svc.effortFind({ storyId: '5001' })).error, /No local git repository/);
  const d2 = makeData(path.join(tmp, 'missing'));
  e.setData(d2);
  const f = ok(await e.svc.effortFind({ storyId: '5001' }));
  assert.deepStrictEqual(f.commits, []);
  assert.ok(f.notes.some((n) => /no longer exists/.test(n)));
  assert.ok(!f.estimate.ok);
}, { git: true });

/* ----------------------------- review fixes ----------------------------- */

/** Send each organisation's requests to its own stand-in, the way the real service has one place per organisation. */
function routeOrgs(e, stubs) {
  e.deps.client = async () => Ado.createClient({ org: e.sets.organization, fetch: (url, init) => stubs[String(e.sets.organization).toLowerCase()].fetch(url, init), sleep: noSleep, auth: async () => ({ scheme: 'Bearer', token: 'bearer-token-1' }) });
}
const dataWithout = (ids) => { const d = makeData(null); d.sessions = d.sessions.filter((x) => !ids.includes(x.id)); return d; };
const syncNow = async (e, id) => ok(await e.svc.syncApply({ storyId: id || '5001', planId: ok(await e.svc.syncPreview({ storyId: id || '5001' })).planId }));

check('a preview is only written to the organisation it was made for', async () => {
  const e = ready();
  const other = createStub({ org: 'fabrikam' }); ADO_STORIES(other);
  routeOrgs(e, { contoso: e.stub, fabrikam: other });
  const p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  const before = e.stub.requests.length;
  e.sets.organization = 'fabrikam';
  const r = await e.svc.syncApply({ storyId: '5001', planId: p.planId });
  assert.ok(!r.ok && r.expired && /different Azure DevOps organisation/.test(r.error) && /Nothing was written/.test(r.error), JSON.stringify(r));
  assert.strictEqual(e.stub.requests.length, before, 'no request went to the first organisation');
  assert.strictEqual(other.requests.length, 0, 'and none to the new one');
  assert.strictEqual(e.stub.count('POST', 'workitems/$Task'), 0);
  e.sets.organization = 'contoso';
  assert.ok((await e.svc.syncApply({ storyId: '5001', planId: p.planId })).ok, 'back in the organisation it was made for, the same preview still works');
});

check('a story linked in one organisation is not synced to another until it is refreshed there; nothing from the first is carried over', async () => {
  const e = ready();
  const other = createStub({ org: 'fabrikam' }); ADO_STORIES(other);
  routeOrgs(e, { contoso: e.stub, fabrikam: other });
  const first = await syncNow(e);
  assert.deepStrictEqual([e.store.ado['5001'].org, e.store.ado['5001'].adoId], ['contoso', 5001]);
  e.sets.organization = 'fabrikam';
  const r = await e.svc.syncPreview({ storyId: '5001' });
  assert.ok(!r.ok && /"contoso".*"fabrikam"/.test(r.error), JSON.stringify(r));
  assert.strictEqual(other.requests.length, 0, 'the check is made before anything is asked of the other organisation');
  assert.strictEqual(e.svc.urlFor({ storyId: '5001', kind: 'task' }), null, 'a Task number from the first organisation is not turned into an address in the second');
  assert.strictEqual(e.svc.urlFor({ storyId: '5001' }), 'https://dev.azure.com/fabrikam/_workitems/edit/5001');
  ok(await e.svc.refreshStory({ storyId: '5001' }));
  const l = e.store.ado['5001'];
  assert.deepStrictEqual([l.org, l.adoId, l.taskId, l.hash, l.sessions, l.syncedAt], ['fabrikam', 5001, null, '', [], 0], 'what was synced before says nothing about this organisation');
  const p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.deepStrictEqual([p.creating, p.changes.added, p.changes.removed], [true, 2, 0]);
  ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  assert.strictEqual(trackingTasks(other, 5001).length, 1);
  assert.strictEqual(trackingTasks(e.stub, 5001).length, 1, 'the first organisation was not touched again');
  assert.ok(reportOf(e.stub, first.taskId));
});

check('pointing a story at another work item forgets what was synced to the first one, and never edits the first', async () => {
  const e = ready();
  const first = await syncNow(e);
  const before = e.stub.items.get(first.taskId).fields['System.Description'];
  e.commit({ type: 'saveStory', mode: 'edit', story: { id: '5001', title: 'Login', adoId: 5002 } });
  const p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.deepStrictEqual([p.target.adoId, p.creating, p.changes.removed, p.changes.added], [5002, true, 0, 2]);
  ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  assert.strictEqual(trackingTasks(e.stub, 5002).length, 1);
  assert.strictEqual(e.stub.items.get(first.taskId).fields['System.Description'], before, 'the first work item\'s task is exactly as it was');
  assert.strictEqual(e.store.ado['5001'].adoId, 5002);
  // refresh does the same bookkeeping
  e.commit({ type: 'saveStory', mode: 'edit', story: { id: '5001', title: 'Login', adoId: 5001 } });
  ok(await e.svc.refreshStory({ storyId: '5001' }));
  assert.deepStrictEqual([e.store.ado['5001'].adoId, e.store.ado['5001'].taskId, e.store.ado['5001'].sessions], [5001, null, []]);
});

check('a session is only taken out of the report when it is known to have left the story, never because the scan did not show it', async () => {
  // history cleared, another profile, a scan that failed: nothing is in the scan but everything is still tagged
  let e = ready();
  const first = await syncNow(e);
  e.setData(dataWithout(['s-1', 's-2'])); e.tick(1000);
  let p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.deepStrictEqual([p.changes.removed, p.changed], [0, false], 'an empty scan removes nothing');
  ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  assert.deepStrictEqual(reportOf(e.stub, first.taskId).contributors[0].sessions.map((x) => x.session_id), ['s-1', 's-2']);
  assert.deepStrictEqual(e.store.ado['5001'].sessions, ['s-1', 's-2'], 'and they are still remembered as mine');
  // a partial scan
  e = ready(); const second = await syncNow(e);
  e.setData(dataWithout(['s-2'])); e.tick(1000);
  p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.deepStrictEqual([p.changes.removed, p.changes.unchanged], [0, 1]);
  ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  assert.deepStrictEqual(reportOf(e.stub, second.taskId).contributors[0].sessions.map((x) => x.session_id), ['s-1', 's-2']);
  assert.deepStrictEqual(e.store.ado['5001'].sessions, ['s-1', 's-2']);
  // evidence 1: untagged (while the session was still shown), and since gone from the scan
  e = ready(); const second2 = await syncNow(e);
  e.commit({ type: 'tagSessions', ids: ['s-2'], storyId: null });
  e.setData(dataWithout(['s-2'])); e.tick(1000);
  p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.strictEqual(p.changes.removed, 1, 'untagging is evidence even when the scan no longer has the session');
  ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  assert.deepStrictEqual(reportOf(e.stub, second2.taskId).contributors[0].sessions.map((x) => x.session_id), ['s-1']);
  // evidence 2: still in the scan, but now counted for another story
  e = ready(); const third = await syncNow(e);
  e.addStory('5002', 'Reports'); e.commit({ type: 'tagSessions', ids: ['s-2'], storyId: '5002' }); e.tick(1000);
  p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.strictEqual(p.changes.removed, 1);
  ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  assert.deepStrictEqual(reportOf(e.stub, third.taskId).contributors[0].sessions.map((x) => x.session_id), ['s-1']);
  // a prompt tag counts as "still tagged" too
  e = ready(); const fourth = await syncNow(e);
  e.commit({ type: 'tagSessions', ids: ['s-2'], storyId: null });
  assert.ok(e.commit({ type: 'tagPrompt', sessionId: 's-2', key: String(T(7, 9)), value: '5001' }).ok);
  e.setData(dataWithout(['s-2'])); e.tick(1000);
  p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.strictEqual(p.changes.removed, 0, 'one prompt of the session is still tagged to the story, and the session is not in the scan');
  ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  assert.ok(reportOf(e.stub, fourth.taskId).contributors[0].sessions.some((x) => x.session_id === 's-2'));
});

check('if the task description turns into something unreadable while the person is reviewing, nothing is written and a new review is asked for', async () => {
  const stub = createStub(); ADO_STORIES(stub);
  const a = makeEnv({ stub, contributor: 'inst-aaaa' }); a.addStory('5001', 'Login'); a.tag('5001', ['s-1']);
  const first = await syncNow(a);
  a.setData(makeData(null, { 's-1': 1 })); a.tick(1000);
  const p = ok(await a.svc.syncPreview({ storyId: '5001' }));
  assert.strictEqual(p.replacesUnreadable, false);
  stub.state.beforePatch = (it) => { it.rev += 1; it.fields['System.Description'] = '<p>someone typed over the report</p>'; stub.state.beforePatch = null; };
  const r = await a.svc.syncApply({ storyId: '5001', planId: p.planId });
  assert.ok(!r.ok && r.replan && /cannot read/.test(r.error) && /Nothing was written/.test(r.error), JSON.stringify(r));
  assert.strictEqual(stub.items.get(first.taskId).fields['System.Description'], '<p>someone typed over the report</p>', 'their text was not replaced behind their back');
  const again = ok(await a.svc.syncPreview({ storyId: '5001' }));
  assert.strictEqual(again.replacesUnreadable, true, 'the new preview warns that the text will be replaced');
});

check('the name in the report is exactly what the person shares now', async () => {
  const e = ready({ shareName: true });
  const first = await syncNow(e);
  assert.strictEqual(reportOf(e.stub, first.taskId).contributors[0].display_name, 'Dev inst-1111');
  e.sets.shareName = false; e.tick(1000);
  const p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.strictEqual(p.changed, true, 'removing the name is a change');
  ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  assert.strictEqual(reportOf(e.stub, first.taskId).contributors[0].display_name, '', 'turning sharing off removes the name from the next write');
  assert.ok(!/Dev inst/.test(e.stub.items.get(first.taskId).fields['System.Description']));
});

check('a 51st contributor is refused with a plain message and nothing is written', async () => {
  const stub = createStub(); ADO_STORIES(stub);
  let rep = null;
  for (let i = 1; i <= 50; i++) {
    const m = U.mergeReport({ remote: rep, contributorId: 'dev-' + String(i).padStart(3, '0'), sessions: [{ session_id: 'x-' + i, first_day: '2026-10-06', last_day: '2026-10-06', user_initiated_interaction_count: 1, credits: 1, input_tokens: 1, output_tokens: 1 }], previouslySynced: [], effort: null, now: T(14), adoId: 5001, points: null });
    assert.ok(!m.error, m.error); rep = U.parseDescription(U.renderDescription(m.report).html).report;
  }
  const client = Ado.createClient({ org: 'contoso', fetch: stub.fetch, sleep: noSleep, auth: async () => ({ scheme: 'Bearer', token: 'bearer-token-1' }) });
  await client.createTrackingTask({ story: await client.getStory(5001), descriptionHtml: U.renderDescription(rep).html });
  const e = makeEnv({ stub, contributor: 'inst-late' }); e.addStory('5001', 'Login'); e.tag('5001', ['s-1']);
  const r = await e.svc.syncPreview({ storyId: '5001' });
  assert.ok(!r.ok && /already has 50 contributors/.test(r.error), JSON.stringify(r));
  assert.strictEqual(stub.count('PATCH'), 0);
});

check('the story is pointed at another work item while a conflict is being sorted out: nothing is written to either', async () => {
  const stub = createStub(); ADO_STORIES(stub);
  const a = makeEnv({ stub, contributor: 'inst-aaaa' }); a.addStory('5001', 'Login'); a.tag('5001', ['s-1']);
  const first = await syncNow(a);
  a.setData(makeData(null, { 's-1': 1 })); a.tick(1000);
  const p = ok(await a.svc.syncPreview({ storyId: '5001' }));
  const before = stub.items.get(first.taskId).fields['System.Description'];
  stub.state.beforePatch = (it) => { it.rev += 1; a.commit({ type: 'saveStory', mode: 'edit', story: { id: '5001', title: 'Login', adoId: 5002 } }); stub.state.beforePatch = null; };
  const r = await a.svc.syncApply({ storyId: '5001', planId: p.planId });
  assert.ok(!r.ok && r.replan && /different work item/.test(r.error) && /Nothing was written/.test(r.error), JSON.stringify(r));
  assert.strictEqual(stub.items.get(first.taskId).fields['System.Description'], before);
  assert.strictEqual(trackingTasks(stub, 5002).length, 0, 'and nothing was created under the new work item');
  // the same when the organisation changes in that window
  const other = createStub({ org: 'fabrikam' }); ADO_STORIES(other);
  const b = makeEnv({ stub, contributor: 'inst-bbbb' }); b.addStory('5001', 'Login'); b.tag('5001', ['s-1']);
  routeOrgs(b, { contoso: stub, fabrikam: other });
  const pb = ok(await b.svc.syncPreview({ storyId: '5001' }));
  stub.state.beforePatch = (it) => { it.rev += 1; b.sets.organization = 'fabrikam'; stub.state.beforePatch = null; };
  const rb = await b.svc.syncApply({ storyId: '5001', planId: pb.planId });
  assert.ok(!rb.ok, JSON.stringify(rb));
  assert.strictEqual(other.requests.filter((q) => q.method !== 'GET' && !/wiql/.test(q.path)).length, 0, 'nothing was written to the other organisation');
});

check('the backlog list belongs to the organisation it was read from: importing after a change of organisation is refused', async () => {
  const e = makeEnv();
  ADO_STORIES(e.stub);
  const other = createStub({ org: 'fabrikam' }); ADO_STORIES(other);
  routeOrgs(e, { contoso: e.stub, fabrikam: other });
  const list = ok(await e.svc.listBacklog({ project: 'Shop' }));
  assert.ok(list.items.length >= 2);
  e.sets.organization = 'fabrikam';
  const r = await e.svc.importStories({ ids: list.items.map((x) => x.id) });
  assert.ok(!r.ok && /another organisation/.test(r.error), JSON.stringify(r));
  assert.deepStrictEqual(Object.keys(e.store.stories), [], 'no story was created');
  e.sets.organization = 'contoso';
  assert.ok((await e.svc.importStories({ ids: list.items.map((x) => x.id) })).ok, 'in the organisation it was read from, the same list works');
  assert.deepStrictEqual(Object.values(e.store.ado).map((l) => l.org), ['contoso', 'contoso'], 'and the links say where they were read');
});

check('sessions this machine wrote to one work item are not taken out of another work item\'s report', async () => {
  const stub = createStub(); ADO_STORIES(stub);
  const a = makeEnv({ stub, contributor: 'inst-aaaa' }); a.addStory('5001', 'Login'); a.tag('5001', ['s-1', 's-2']);
  await syncNow(a);                                                   // a wrote s-1 and s-2 to work item 5001
  const b = makeEnv({ stub, contributor: 'inst-bbbb' }); b.addStory('5002', 'Reports'); b.tag('5002', ['s-2']);
  const theirs = await syncNow(b, '5002');                            // someone else has a session with that ID in work item 5002
  a.commit({ type: 'tagSessions', ids: ['s-2'], storyId: null });
  a.commit({ type: 'saveStory', mode: 'edit', story: { id: '5001', title: 'Login', adoId: 5002 } });
  const p = ok(await a.svc.syncPreview({ storyId: '5001' }));
  assert.strictEqual(p.changes.removed, 0, 'what was written to 5001 says nothing about 5002');
  ok(await a.svc.syncApply({ storyId: '5001', planId: p.planId }));
  const rep = reportOf(stub, theirs.taskId);
  assert.deepStrictEqual(rep.contributors.map((c) => [c.contributor_id, c.sessions.map((s) => s.session_id)]), [['inst-aaaa', ['s-1']], ['inst-bbbb', ['s-2']]], 'the other person\'s session is still there');
});

check('two previews of one story cannot both create a Task: the second waits its turn and then finds the first one\'s Task', async () => {
  const e = ready();
  const p1 = ok(await e.svc.syncPreview({ storyId: '5001' }));
  const p2 = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.notStrictEqual(p1.planId, p2.planId);
  const [x, y] = await Promise.all([e.svc.syncApply({ storyId: '5001', planId: p1.planId }), e.svc.syncApply({ storyId: '5001', planId: p2.planId })]);
  assert.strictEqual([x, y].filter((r) => r.ok).length, 1, 'exactly one of the two clicks wrote');
  assert.match([x, y].find((r) => !r.ok).error, /already running/);
  assert.strictEqual(e.stub.count('POST', 'workitems/$Task'), 1);
  // The second preview was made before the first sync, so what this machine had already written has changed since: it is not used.
  const later = await e.svc.syncApply({ storyId: '5001', planId: p2.planId });
  assert.ok(!later.ok && later.replan && /Nothing was written/.test(later.error), JSON.stringify(later));
  assert.strictEqual(trackingTasks(e.stub, 5001).length, 1);
  const fresh = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.strictEqual(fresh.changed, false, 'a new preview finds everything already written');
});

check('the extension asks for itself before writing to a new or changed target, and not when nothing about the target changed', async () => {
  const e = ready();
  const asked = [];
  let answer = false;
  e.deps.confirmWrite = async (d) => { asked.push(d); return answer; };
  // first sync: a Task will be created
  let p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  let r = await e.svc.syncApply({ storyId: '5001', planId: p.planId });
  assert.ok(!r.ok && r.cancelled && /Nothing was written/.test(r.error), JSON.stringify(r));
  assert.deepStrictEqual(asked[0], { org: 'contoso', project: 'Shop', adoId: 5001, title: 'Login', creating: true, taskId: null });
  assert.strictEqual(e.stub.count('POST', 'workitems/$Task'), 0, 'declining writes nothing');
  assert.strictEqual(Core.hasOwn(e.store.ado, '5001'), false, 'and records nothing');
  answer = true;
  r = ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  assert.strictEqual(asked.length, 2, 'the same preview can still be confirmed after a decline');
  assert.strictEqual(r.created, true);
  // later syncs to the same target are not asked about again
  e.setData(makeData(null, { 's-1': 1 })); e.tick(1000);
  p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  assert.strictEqual(asked.length, 2, 'the target is the one confirmed before');
  // nothing to write: no question either
  p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.strictEqual(p.changed, false);
  answer = false;
  ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  assert.strictEqual(asked.length, 2);
  // the story is pointed at another work item: new target, asked again, naming it
  e.commit({ type: 'saveStory', mode: 'edit', story: { id: '5001', title: 'Login', adoId: 5002 } });
  p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  r = await e.svc.syncApply({ storyId: '5001', planId: p.planId });
  assert.ok(!r.ok && r.cancelled);
  assert.deepStrictEqual([asked[2].adoId, asked[2].creating, asked[2].title], [5002, true, 'Reports']);
  assert.strictEqual(trackingTasks(e.stub, 5002).length, 0);
  // back to the first work item: the declined attempt changed nothing, so the target is the one confirmed before and nothing is asked
  e.commit({ type: 'saveStory', mode: 'edit', story: { id: '5001', title: 'Login', adoId: 5001 } });
  e.setData(makeData(null, { 's-1': 2 })); e.tick(1000);
  p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  ok(await e.svc.syncApply({ storyId: '5001', planId: p.planId }));
  assert.strictEqual(asked.length, 3);
  // the saved link no longer matches the Task that would be updated: asked again, naming that Task
  const real = e.store.ado['5001'].taskId;
  e.commit({ type: 'adoRecord', storyId: '5001', link: { taskId: real + 1000 } });
  e.setData(makeData(null, { 's-1': 3 })); e.tick(1000);
  p = ok(await e.svc.syncPreview({ storyId: '5001' }));
  assert.strictEqual(p.creating, false);
  r = await e.svc.syncApply({ storyId: '5001', planId: p.planId });
  assert.ok(!r.ok && r.cancelled);
  assert.deepStrictEqual([asked[3].creating, asked[3].taskId, asked[3].adoId], [false, real, 5001]);
});

/* ----------------------------- run ----------------------------- */

(async () => {
  try {
    for (const [name, fn, opts] of checks) {
      if (opts.git && !HAVE_GIT) { console.log('SKIP ' + name + ' (git is not installed)'); continue; }
      try { const r = await fn(); console.log('PASS ' + name + (r === undefined ? '' : ' -> ' + r)); } catch (e) { failed++; console.log('FAIL ' + name + ' -> ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : e)); }
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nAzure DevOps service checks passed.');
  process.exit(failed ? 1 : 0);
})();
