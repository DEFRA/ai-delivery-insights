'use strict';
/**
 * Tests for the story store's Azure DevOps parts: the work item number, the traditional effort, what this machine
 * remembers about the Azure DevOps side, and how all of that is saved, backed up and cleaned up.
 * Expected values are written out by hand. Run: node test/test-ado-store.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Core = require('../media/story-core.js');
const Stories = require('../lib/stories.js');

let failed = 0;
function check(name, fn) {
  try { const r = fn(); console.log('PASS ' + name + (r === undefined ? '' : ' -> ' + r)); } catch (e) { failed++; console.log('FAIL ' + name + ' -> ' + (e && e.message)); }
}
const ctx = { sessions: new Map() };
const apply = (store, op) => Stories.applyOp(store, op, ctx, 1700000000000);
const must = (store, op) => { const r = apply(store, op); assert.ok(r.ok, r.error); return r.store; };
const story = (id, extra) => Object.assign({ id, title: 'Story ' + id }, extra || {});
const withStories = (...ids) => ids.reduce((st, id) => must(st, { type: 'saveStory', mode: 'new', story: story(id) }), Core.emptyStore());
const HASH = 'ab'.repeat(32);

check('the Azure DevOps number: typed, or taken from a numeric ID, or unknown', () => {
  const cases = [
    [{ id: '1234' }, 1234], [{ id: 'AB#1234' }, 1234], [{ id: 'ab#7' }, 7], [{ id: 'US-12' }, null], [{ id: 'PROJ_7' }, null],
    [{ id: 'US-12', adoId: 99 }, 99], [{ id: '1234', adoId: 55 }, 55], [{ id: '1234567890' }, null], [{ id: '0' }, null],
    [{ id: 'US-12', adoId: 0 }, null], [{ id: 'US-12', adoId: 1.5 }, null], [{ id: 'US-12', adoId: '9' }, null], [null, null], [undefined, null],
  ];
  for (const [s, want] of cases) { assert.strictEqual(Core.adoIdOf(s), want, JSON.stringify(s)); }
  assert.strictEqual(Core.normalizeStory({ id: 'US-12', title: 't', adoId: ' 42 ' }).story.adoId, 42, 'a typed number is trimmed');
  assert.strictEqual(Core.normalizeStory({ id: 'US-12', title: 't', adoId: '' }).story.adoId, null);
  for (const bad of ['abc', '-3', '0', '1.5', '99999999999', '12 34', 2147483648]) {
    const r = Core.normalizeStory({ id: 'US-12', title: 't', adoId: bad });
    assert.ok(!r.ok && /Azure DevOps ID/.test(r.error), String(bad));
  }
});

check('effort records: hours are rounded, ranges must bracket the hours, junk is dropped', () => {
  const ok = Core.normalizeEffort({ hours: 46.375, low: 32.46, high: 69.56, source: 'estimated', method: 'size-v1', confidence: 'medium', setAt: 5, inputs: { prodLines: 450, testLines: 300, files: 14, commits: 3, points: 5, evil: 9, junk: 'x' } });
  assert.ok(ok.ok);
  assert.deepStrictEqual(ok.effort, { hours: 46.4, low: 32.5, high: 69.6, source: 'estimated', method: 'size-v1', confidence: 'medium', setAt: 5, note: '', inputs: { commits: 3, prodLines: 450, testLines: 300, files: 14, points: 5 } });
  // a range that does not contain the hours is not kept
  assert.strictEqual(Core.normalizeEffort({ hours: 10, low: 12, high: 20, source: 'estimated' }).effort.low, null);
  assert.strictEqual(Core.normalizeEffort({ hours: 10, low: 5, high: 8, source: 'estimated' }).effort.high, null);
  // a typed value is always "manual", with no method, no inputs and the manual confidence label
  const m = Core.normalizeEffort({ hours: '12.04', source: 'manual', method: 'size-v1', confidence: 'high', inputs: { files: 3 }, note: ' by hand\u0000 ' });
  assert.deepStrictEqual(m.effort, { hours: 12, low: null, high: null, source: 'manual', method: '', confidence: 'manual', setAt: 0, note: 'by hand', inputs: {} });
  // an estimate cannot claim the manual label, and an unknown label becomes the cautious one
  assert.strictEqual(Core.normalizeEffort({ hours: 3, source: 'estimated', confidence: 'manual' }).effort.confidence, 'low');
  assert.strictEqual(Core.normalizeEffort({ hours: 3, source: 'estimated', confidence: 'certain' }).effort.confidence, 'low');
  assert.strictEqual(Core.normalizeEffort({ hours: 3, source: 'nonsense' }).effort.source, 'manual');
  for (const bad of [0, -1, NaN, Infinity, 100001, 'abc', null, undefined, {}, [], true]) { assert.ok(!Core.normalizeEffort({ hours: bad }).ok, 'hours ' + String(bad)); }
  assert.ok(!Core.normalizeEffort(null).ok && !Core.normalizeEffort('x').ok);
  assert.ok(Core.normalizeEffort({ hours: 100000 }).ok, 'the top of the range is allowed');
});

check('Azure DevOps link records keep only what is valid, and an empty one is nothing', () => {
  const l = Core.normalizeAdoLink({ project: 'Shop', type: 'User Story', state: 'Active', iteration: 'Shop\\Sprint 12', fetchedAt: 9, taskId: 77, hash: HASH, syncedAt: 10, sessions: ['a', 'b', 'a', '', 7, null, '__proto__', 'x'.repeat(201)] });
  assert.deepStrictEqual(l, { org: '', adoId: null, project: 'Shop', type: 'User Story', state: 'Active', iteration: 'Shop\\Sprint 12', fetchedAt: 9, taskId: 77, hash: HASH, syncedAt: 10, sessions: ['a', 'b'] });
  // the organisation and work item a link belongs to are kept (organisation lower-cased), and junk for either is dropped
  const bound = Core.normalizeAdoLink({ org: 'Contoso', adoId: 5001, taskId: 77 });
  assert.strictEqual(bound.org, 'contoso'); assert.strictEqual(bound.adoId, 5001);
  const unbound = Core.normalizeAdoLink({ org: { x: 1 }, adoId: 1.5, taskId: 77 });
  assert.strictEqual(unbound.org, ''); assert.strictEqual(unbound.adoId, null);
  assert.strictEqual(Core.normalizeAdoLink({ org: 'contoso', adoId: 5001 }), null, 'an organisation and number alone are not a record');
  assert.strictEqual(Core.normalizeAdoLink({}), null); assert.strictEqual(Core.normalizeAdoLink(null), null); assert.strictEqual(Core.normalizeAdoLink('x'), null);
  assert.strictEqual(Core.normalizeAdoLink({ taskId: 1.5, hash: 'nothex', fetchedAt: 'x' }), null, 'bad values are dropped, leaving nothing');
  const big = Core.normalizeAdoLink({ taskId: 1, sessions: Array.from({ length: Core.LIMITS.adoSessions + 50 }, (_, i) => 's' + i) });
  assert.strictEqual(big.sessions.length, Core.LIMITS.adoSessions, 'the list of synced sessions is capped');
});

check('a store with effort and Azure DevOps data survives save and load; data for missing stories is dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-ado-store-'));
  let st = withStories('1', 'US-2');
  st = must(st, { type: 'saveEffort', storyId: '1', hours: 12.5, note: 'typed' });
  st = must(st, { type: 'adoRecord', storyId: 'US-2', link: { project: 'Shop', taskId: 88, hash: HASH, sessions: ['s1', 's2'], syncedAt: 3 } });
  Stories.save(dir, st);
  const back = Stories.load(dir).store;
  assert.deepStrictEqual(Core.toPlain(back), Core.toPlain(st));
  assert.strictEqual(back.efforts['1'].hours, 12.5); assert.deepStrictEqual(back.ado['US-2'].sessions, ['s1', 's2']);
  // hand-edited file: effort and links for stories that do not exist, and hostile keys
  const raw = JSON.parse(fs.readFileSync(path.join(dir, Stories.FILE), 'utf8'));
  raw.efforts.ghost = { hours: 4 }; raw.ado.ghost = { taskId: 5 };
  const evil = JSON.parse('{"stories":[{"id":"1","title":"t"}],"efforts":{"__proto__":{"hours":5},"1":{"hours":5}},"ado":{"__proto__":{"taskId":5},"1":{"taskId":6}}}');
  const n = Core.normalizeStore(raw), e = Core.normalizeStore(evil);
  assert.ok(!Core.hasOwn(n.efforts, 'ghost') && !Core.hasOwn(n.ado, 'ghost'), 'nothing is kept for a story that does not exist');
  assert.deepStrictEqual(Object.keys(e.efforts), ['1']); assert.deepStrictEqual(Object.keys(e.ado), ['1']);
  assert.strictEqual({}.hours, undefined); assert.strictEqual({}.taskId, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('saveEffort and clearEffort: typed hours only, for a story that exists, and the page cannot claim an estimate', () => {
  const st = withStories('1');
  const s1 = must(st, { type: 'saveEffort', storyId: '1', hours: '20', note: 'my guess' });
  assert.deepStrictEqual(s1.efforts['1'], { hours: 20, low: null, high: null, source: 'manual', method: '', confidence: 'manual', setAt: 1700000000000, note: 'my guess', inputs: {} });
  // the page tries to dress a typed number up as an estimate
  const s2 = must(st, { type: 'saveEffort', storyId: '1', hours: 20, source: 'estimated', method: 'size-v1', confidence: 'high', inputs: { prodLines: 9 }, low: 1, high: 99 });
  assert.strictEqual(s2.efforts['1'].source, 'manual'); assert.strictEqual(s2.efforts['1'].confidence, 'manual'); assert.strictEqual(s2.efforts['1'].low, null); assert.deepStrictEqual(s2.efforts['1'].inputs, {});
  for (const bad of [0, -2, 'x', null, 1e9]) { assert.ok(!apply(st, { type: 'saveEffort', storyId: '1', hours: bad }).ok, 'hours ' + bad); }
  assert.ok(!apply(st, { type: 'saveEffort', storyId: 'nope', hours: 5 }).ok); assert.ok(!apply(st, { type: 'saveEffort', storyId: 7, hours: 5 }).ok); assert.ok(!apply(st, { type: 'saveEffort', hours: 5 }).ok);
  const cleared = must(s1, { type: 'clearEffort', storyId: '1' });
  assert.ok(!Core.hasOwn(cleared.efforts, '1')); assert.ok(Core.hasOwn(s1.efforts, '1'), 'the input store is not changed');
  assert.ok(!apply(st, { type: 'clearEffort', storyId: 'nope' }).ok);
});

check('setEffortEstimate stores an estimate as an estimate, and replaces a typed number', () => {
  let st = withStories('1');
  st = must(st, { type: 'saveEffort', storyId: '1', hours: 3 });
  const est = { hours: 46.375, low: 32.46, high: 69.56, method: 'size-v1', confidence: 'medium', inputs: { prodLines: 450, testLines: 300, files: 14, commits: 3 } };
  const s2 = must(st, { type: 'setEffortEstimate', storyId: '1', effort: est });
  assert.deepStrictEqual(s2.efforts['1'], { hours: 46.4, low: 32.5, high: 69.6, source: 'estimated', method: 'size-v1', confidence: 'medium', setAt: 1700000000000, note: '', inputs: { prodLines: 450, testLines: 300, files: 14, commits: 3 } });
  assert.strictEqual(s2.efforts['1'].source, 'estimated');
  assert.ok(!apply(st, { type: 'setEffortEstimate', storyId: '1', effort: { hours: 0 } }).ok);
  assert.ok(!apply(st, { type: 'setEffortEstimate', storyId: 'nope', effort: est }).ok);
});

check('adoRecord merges, keeps what it is not told about, and removes an empty record', () => {
  let st = withStories('1');
  st = must(st, { type: 'adoRecord', storyId: '1', link: { project: 'Shop', state: 'Active', fetchedAt: 5 } });
  st = must(st, { type: 'adoRecord', storyId: '1', link: { taskId: 10, hash: HASH, sessions: ['a'], syncedAt: 6 } });
  assert.deepStrictEqual(st.ado['1'], { org: '', adoId: null, project: 'Shop', type: '', state: 'Active', iteration: '', fetchedAt: 5, taskId: 10, hash: HASH, syncedAt: 6, sessions: ['a'] });
  st = must(st, { type: 'adoRecord', storyId: '1', link: { sessions: ['a', 'b'] } });
  assert.deepStrictEqual(st.ado['1'].sessions, ['a', 'b']); assert.strictEqual(st.ado['1'].taskId, 10);
  const wiped = must(st, { type: 'adoRecord', storyId: '1', link: { project: '', state: '', taskId: null, hash: '', sessions: [], iteration: '', type: '' } });
  assert.ok(!Core.hasOwn(wiped.ado, '1'), 'a record with nothing in it is removed');
  assert.ok(!apply(st, { type: 'adoRecord', storyId: 'nope', link: { taskId: 1 } }).ok);
});

check('adoImport creates stories from backlog items and skips ones already here', () => {
  let st = withStories('1234', 'US-9');
  st = must(st, { type: 'saveStory', mode: 'edit', story: story('US-9', { adoId: 555 }) });
  const items = [
    { id: 1234, title: 'Already here by ID', points: 3, project: 'Shop', state: 'Active', type: 'User Story', iteration: 'Shop\\S1' },
    { id: 555, title: 'Same item as US-9', points: 2, project: 'Shop' },
    { id: 777, title: 'New one', points: 5, project: 'Shop', state: 'New', type: 'User Story', iteration: 'Shop\\Sprint 12' },
    { id: 778, title: 'No points', points: 0, project: 'Shop', state: 'New' },
    { id: 779, title: '', points: 1 },
    { id: 'x y', title: 'Bad id' }, null, 'junk',
  ];
  const r = apply(st, { type: 'adoImport', org: 'Contoso', items });
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(Object.keys(r.store.stories).sort(), ['1234', '777', '778', 'US-9']);
  assert.strictEqual(r.store.stories['777'].adoId, 777); assert.strictEqual(r.store.stories['777'].points, 5); assert.strictEqual(r.store.stories['778'].points, null, 'zero points mean not estimated');
  assert.deepStrictEqual(r.store.ado['777'], { org: 'contoso', adoId: 777, project: 'Shop', type: 'User Story', state: 'New', iteration: 'Shop\\Sprint 12', fetchedAt: 1700000000000, taskId: null, hash: '', syncedAt: 0, sessions: [] });
  assert.strictEqual(r.store.stories['1234'].title, 'Story 1234', 'an existing story is not changed');
  assert.ok(/Imported 2 stories/.test(r.message) && /6 already here or not valid/.test(r.message), r.message);
  assert.ok(!apply(st, { type: 'adoImport', items: [] }).ok); assert.ok(!apply(st, { type: 'adoImport' }).ok);
  assert.ok(!apply(st, { type: 'adoImport', items: Array.from({ length: 201 }, (_, i) => ({ id: 2000 + i, title: 't' })) }).ok, 'at most 200 at a time');
});

check('deleting a story removes its effort and Azure DevOps record', () => {
  let st = withStories('1', '2');
  st = must(st, { type: 'saveEffort', storyId: '1', hours: 5 }); st = must(st, { type: 'saveEffort', storyId: '2', hours: 6 });
  st = must(st, { type: 'adoRecord', storyId: '1', link: { taskId: 3 } }); st = must(st, { type: 'adoRecord', storyId: '2', link: { taskId: 4 } });
  const d = must(st, { type: 'deleteStory', id: '1' });
  assert.deepStrictEqual(Object.keys(d.efforts), ['2']); assert.deepStrictEqual(Object.keys(d.ado), ['2']);
});

check('backup carries effort but not the per-machine Azure DevOps record; restore merges or replaces', () => {
  let mine = withStories('1', '2');
  mine = must(mine, { type: 'saveEffort', storyId: '1', hours: 10, note: 'mine' });
  mine = must(mine, { type: 'adoRecord', storyId: '1', link: { taskId: 3, hash: HASH, sessions: ['secret-session-id'], project: 'Shop' } });
  const text = Stories.exportText(mine);
  assert.ok(!text.includes('secret-session-id') && !text.includes('"taskId"'), 'no synced-session list or task number in a backup');
  assert.strictEqual(JSON.parse(text).efforts['1'].hours, 10);
  const theirsStore = must(must(withStories('1', '2'), { type: 'saveEffort', storyId: '1', hours: 99 }), { type: 'saveEffort', storyId: '2', hours: 8 });
  const theirs = Stories.parseImport(Stories.exportText(theirsStore)).data;
  const merged = must(mine, { type: 'import', data: theirs, mode: 'merge' });
  assert.strictEqual(merged.efforts['1'].hours, 10, 'merge keeps my effort'); assert.strictEqual(merged.efforts['2'].hours, 8, 'merge adds the one I did not have');
  assert.deepStrictEqual(merged.ado['1'].sessions, ['secret-session-id'], 'merge leaves my Azure DevOps record alone');
  const replaced = must(mine, { type: 'import', data: theirs, mode: 'replace' });
  assert.strictEqual(replaced.efforts['1'].hours, 99); assert.deepStrictEqual(Object.keys(replaced.ado), [], 'replace starts with no Azure DevOps record');
  // a backup that tries to smuggle in a record for a story it does not contain
  const sneaky = JSON.parse(text); sneaky.efforts.ghost = { hours: 5 }; sneaky.ado = { 1: { taskId: 1, sessions: ['x'] } };
  const viaSneaky = must(Core.emptyStore(), { type: 'import', data: sneaky, mode: 'merge' });
  assert.ok(!Core.hasOwn(viaSneaky.efforts, 'ghost') && Object.keys(viaSneaky.ado).length === 0, 'unknown stories and the ado section of a backup are ignored');
});

check('every dictionary for effort and Azure DevOps data has no prototype', () => {
  let st = withStories('1');
  st = must(st, { type: 'saveEffort', storyId: '1', hours: 5 }); st = must(st, { type: 'adoRecord', storyId: '1', link: { taskId: 3 } });
  for (const s of [Core.emptyStore(), Core.normalizeStore({}), Core.cloneStore(st), st]) {
    assert.strictEqual(Object.getPrototypeOf(s.efforts), null); assert.strictEqual(Object.getPrototypeOf(s.ado), null);
  }
  assert.ok(!Core.hasOwn(Core.emptyStore().efforts, 'constructor'));
});

check('the page may only change effort by typing it; the extension-only operations are not in its list', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const m = /const allowed = \[([^\]]*)\]/.exec(src);
  assert.ok(m, 'the allow-list is in extension.js');
  const list = m[1].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean).sort();
  assert.deepStrictEqual(list, ['clearEffort', 'deleteStory', 'saveEffort', 'saveStory', 'tagPhase', 'tagPrompt', 'tagSessions']);
});

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nAzure DevOps store checks passed.');
process.exit(failed ? 1 : 0);
