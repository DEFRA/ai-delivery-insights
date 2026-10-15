'use strict';
/**
 * Unit tests for the story logic (media/story-core.js), the store (lib/stories.js) and the CSV export.
 * Oracles are plain loops over the scan payload; they never call the code under test to work out the answer.
 * Run: LENS_DATA=<scan.json> node test/test-stories.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Core = require('../media/story-core.js');
const Stories = require('../lib/stories.js');
const { toCsv } = require('../lib/scanner.js');
const oracle = require('./phase-oracle.js');

const data = JSON.parse(fs.readFileSync(process.env.LENS_DATA, 'utf8'));
let failed = 0;
function check(name, fn) {
  try { const r = fn(); console.log('PASS ' + name + (r === undefined ? '' : ' -> ' + r)); } catch (e) { failed++; console.log('FAIL ' + name + ' -> ' + (e && e.message)); }
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || 'values differ'}: ${a} vs ${b}`);
const ctx = Stories.contextFor(data);
const S = data.sessions;
const keyOf = (p) => (p.ts ? String(p.ts) : '#' + p.i);

/** Apply an op and require success. */
function ok(store, op) { const r = Stories.applyOp(store, op, ctx, 5000); assert.ok(r.ok, r.error); return r.store; }
const story = (id, extra) => Object.assign({ id, title: 'Story ' + id }, extra || {});

/* ---------------- validation ---------------- */
check('story ids: accepted and rejected forms', () => {
  for (const id of ['1234', 'AB#1234', 'US-12', 'PROJ_7', 'a.b:c', 'constructor', 'toString']) { assert.ok(Core.validId(id), id + ' should be valid'); }
  for (const id of ['', ' ', 'a b', '__proto__', '#12', '-1', 'x'.repeat(41), 'inherit', 'None', 'NEW', '__new__', 'all', 'a/b', '<b>', 7, null]) { assert.ok(!Core.validId(id), String(id) + ' should be invalid'); }
});

check('story fields: trimming, clamping, numbers', () => {
  const r = Core.normalizeStory({ id: ' 12 ', title: '  A\u0000 b\tc  ', points: '5', budget: ' 250.555 ', group: 'x'.repeat(100) });
  assert.ok(r.ok);
  assert.strictEqual(r.story.id, '12'); assert.strictEqual(r.story.title, 'A b c');
  assert.strictEqual(r.story.points, 5); assert.strictEqual(r.story.budget, 250.56); assert.strictEqual(r.story.group.length, 60);
  assert.strictEqual(Core.normalizeStory({ id: '1', title: 'x'.repeat(500) }).story.title.length, 120);
  for (const bad of [{ id: '1', title: '' }, { id: '1', title: '   ' }, { id: '1', title: 'x', points: 0 }, { id: '1', title: 'x', points: -2 }, { id: '1', title: 'x', points: 'abc' }, { id: '1', title: 'x', points: 1001 }, { id: '1', title: 'x', budget: 1e8 }, { id: '1', title: 'x', budget: NaN }, null, 'str']) {
    assert.ok(!Core.normalizeStory(bad).ok, JSON.stringify(bad) + ' should be rejected');
  }
  const none = Core.normalizeStory({ id: '1', title: 'x', points: '', budget: null });
  assert.ok(none.ok && none.story.points === null && none.story.budget === null);
});

check('hostile stored data cannot pollute prototypes or smuggle tags', () => {
  const raw = JSON.parse('{"stories":[{"id":"__proto__","title":"x"},{"id":"ok","title":"fine"},{"id":"constructor","title":"also fine"}],'
    + '"sessionTags":{"__proto__":"ok","s1":"ok","s2":"missing","s3":5,"":"ok"},'
    + '"promptTags":{"__proto__":{"polluted":"ok"},"s1":{"1":"ok","2":null,"3":"missing","4":7}}}');
  const store = Core.normalizeStore(raw);
  assert.strictEqual({}.polluted, undefined); assert.strictEqual(Object.prototype.polluted, undefined);
  assert.deepStrictEqual(Object.keys(store.stories).sort(), ['constructor', 'ok']);
  assert.ok(Core.hasOwn(store.sessionTags, 's1') && !Core.hasOwn(store.sessionTags, 's2') && !Core.hasOwn(store.sessionTags, 's3') && !Core.hasOwn(store.sessionTags, ''));
  assert.deepStrictEqual(Object.keys(store.promptTags.s1).sort(), ['1', '2']);
  assert.strictEqual(store.promptTags.s1['2'], null);
  assert.ok(!Core.hasOwn(store.sessionTags, '__proto__') && !Core.hasOwn(store.promptTags, '__proto__'), 'a __proto__ key is dropped, so converting back to plain JSON cannot change an object\'s prototype');
  const plain = Core.toPlain(store);
  assert.strictEqual(Object.getPrototypeOf(plain.promptTags), Object.prototype); assert.strictEqual(plain.promptTags.polluted, undefined);
  // an id like "constructor" must behave as a normal id, not as an inherited property
  assert.strictEqual(Core.hasOwn(Core.emptyStore().stories, 'constructor'), false);
  return `${Object.keys(store.stories).length} stories kept`;
});

check('every dictionary in a store has no prototype, however the store was built', () => {
  const bare = (o, what) => assert.strictEqual(Object.getPrototypeOf(o), null, what + ' has a prototype');
  const sid = S[0].id, k0 = keyOf(S[0].prompts[0]);
  const parts = (st, what) => {
    for (const d of ['stories', 'sessionTags', 'promptTags', 'phaseTags']) { bare(st[d], what + '.' + d); }
    for (const d of ['promptTags', 'phaseTags']) { for (const inner of Object.values(st[d])) { bare(inner, what + '.' + d + ' entry'); } }
  };
  parts(Core.emptyStore(), 'emptyStore');
  const raw = { stories: [story('a')], sessionTags: { [sid]: 'a' }, promptTags: { [sid]: { [k0]: 'a' } }, phaseTags: { [sid]: { [k0]: 'test' } } };
  parts(Core.normalizeStore(raw), 'normalizeStore');
  parts(Core.cloneStore(Core.normalizeStore(raw)), 'cloneStore');
  // stores produced by edits, which create inner dictionaries on first use
  let st = ok(Core.emptyStore(), { type: 'saveStory', mode: 'new', story: story('a') });
  st = ok(st, { type: 'tagPrompt', sessionId: sid, key: k0, value: 'a' });
  st = ok(st, { type: 'tagPhase', sessionId: sid, keys: [k0], phase: 'build' });
  parts(st, 'after edits');
  assert.ok(Object.keys(st.promptTags).length === 1 && Object.keys(st.phaseTags).length === 1, 'the inner dictionaries were really created');
  const imported = ok(Core.emptyStore(), { type: 'import', mode: 'merge', data: Object.assign({ kind: Stories.KIND, version: 1 }, raw) });
  assert.ok(Object.keys(imported.promptTags).length === 1 && Object.keys(imported.phaseTags).length === 1, 'import created the inner dictionaries');
  parts(imported, 'after import');
  const replaced = ok(st, { type: 'import', mode: 'replace', data: Object.assign({ kind: Stories.KIND, version: 1 }, raw) });
  parts(replaced, 'after replace');
});

check('stores are capped', () => {
  const stories = []; for (let i = 0; i < Core.LIMITS.stories + 50; i++) { stories.push({ id: 'S' + i, title: 't' }); }
  assert.strictEqual(Object.keys(Core.normalizeStore({ stories }).stories).length, Core.LIMITS.stories);
});

check('route validation', () => {
  assert.deepStrictEqual(Core.normalizeRoute({ name: 'story', id: '1', extra: 'x' }), { name: 'story', id: '1' });
  assert.deepStrictEqual(Core.normalizeRoute({ name: 'prompt', id: 's', key: 'k' }), { name: 'prompt', id: 's', key: 'k' });
  for (const bad of [null, {}, { name: 'nope' }, { name: 'story' }, { name: 'prompt', id: 's' }, { name: 'story', id: 5 }, { name: 'session', id: 'x'.repeat(300) }]) { assert.strictEqual(Core.normalizeRoute(bad), null, JSON.stringify(bad)); }
});

/* ---------------- which story a prompt belongs to ---------------- */
// the plan: session A -> 100 (whole), one prompt moved to 200, one prompt set to "no story";
//           session B -> 200 (whole); session C -> 100 via two prompts only (no session tag)
const A = S[0], B = S[1], C = S[2];
let store = Core.emptyStore();
store = ok(store, { type: 'saveStory', mode: 'new', story: story('100', { points: 5, budget: 200, group: 'Sprint 1' }) });
store = ok(store, { type: 'saveStory', mode: 'new', story: story('200') });
store = ok(store, { type: 'tagSessions', ids: [A.id], storyId: '100' });
store = ok(store, { type: 'tagSessions', ids: [B.id], storyId: '200' });
store = ok(store, { type: 'tagPrompt', sessionId: A.id, key: keyOf(A.prompts[0]), value: '200' });
store = ok(store, { type: 'tagPrompt', sessionId: A.id, key: keyOf(A.prompts[1]), value: 'none' });
store = ok(store, { type: 'tagPrompt', sessionId: C.id, key: keyOf(C.prompts[0]), value: '100' });
store = ok(store, { type: 'tagPrompt', sessionId: C.id, key: keyOf(C.prompts[1]), value: '100' });

/** Independent oracle: the expected credits per story, from the plan above, by plain loops. */
function expectedCredits(id) {
  let c = 0;
  for (const s of S) {
    for (let i = 0; i < s.prompts.length; i++) {
      let owner = null;
      if (s === A) { owner = i === 0 ? '200' : i === 1 ? null : '100'; } else if (s === B) { owner = '200'; } else if (s === C) { owner = i < 2 ? '100' : null; }
      if (owner === id) { c += s.prompts[i].credits; }
    }
    if (s.overhead && ((s === A && id === '100') || (s === B && id === '200'))) { c += s.overhead.credits; }
  }
  return c;
}

check('a prompt follows its own tag, else its session; background calls follow the session', () => {
  const { rows } = Core.buildRows(data);
  const g = Core.groupByStory(rows, store);
  near(Core.totals(g.byStory.get('100')).credits, expectedCredits('100'), 'story 100');
  near(Core.totals(g.byStory.get('200')).credits, expectedCredits('200'), 'story 200');
  const total = rows.reduce((a, r) => a + r.p.credits, 0);
  near(Core.totals(g.byStory.get('100')).credits + Core.totals(g.byStory.get('200')).credits + Core.totals(g.untagged).credits, total, 'tagged + untagged = everything');
  assert.ok(g.byStory.get('100').every((r) => r.ov ? r.s === A : true));
  return `100 = ${expectedCredits('100').toFixed(2)}, 200 = ${expectedCredits('200').toFixed(2)}`;
});

check('sourceOf reports override, session or none', () => {
  const { rows } = Core.buildRows(data);
  const find = (s, i) => rows.find((r) => r.s === s && !r.ov && r.p === s.prompts[i]);
  assert.strictEqual(Core.sourceOf(store, find(A, 0)), 'override');
  assert.strictEqual(Core.sourceOf(store, find(A, 1)), 'override');
  assert.strictEqual(Core.storyOf(store, find(A, 1)), null);
  assert.strictEqual(Core.sourceOf(store, find(A, 2)), 'session');
  assert.strictEqual(Core.sourceOf(store, find(S[3], 0)), 'none');
});

check('deleting a story removes its tags; its prompts fall back to their session', () => {
  const next = ok(store, { type: 'deleteStory', id: '200' });
  const { rows } = Core.buildRows(data);
  const g = Core.groupByStory(rows, next);
  assert.ok(!g.byStory.has('200'));
  // A's first prompt was moved to 200; with 200 gone it follows session A (story 100) again.
  near(Core.totals(g.byStory.get('100')).credits, expectedCredits('100') + A.prompts[0].credits, 'story 100 takes back the prompt that was moved away');
  const total = rows.reduce((a, r) => a + r.p.credits, 0);
  near(Core.totals(g.byStory.get('100')).credits + Core.totals(g.untagged).credits, total, 'everything else is untagged');
  assert.ok(!Core.hasOwn(next.sessionTags, B.id), "B's session tag went with the story");
  assert.ok(!Core.hasOwn(next.promptTags, A.id) || !Object.values(next.promptTags[A.id]).includes('200'), 'no override still names 200');
  assert.strictEqual(next.promptTags[A.id][keyOf(A.prompts[1])], null, 'an explicit "no story" override is not touched');
});

/* ---------------- operations ---------------- */
check('operations never change the store they are given', () => {
  const before = JSON.stringify(Core.toPlain(store));
  Stories.applyOp(store, { type: 'deleteStory', id: '100' }, ctx);
  Stories.applyOp(store, { type: 'tagSessions', ids: [S[5].id], storyId: '100' }, ctx);
  assert.strictEqual(JSON.stringify(Core.toPlain(store)), before);
});

check('create rules: duplicate, missing edit, bad input, unknown request', () => {
  assert.ok(!Stories.applyOp(store, { type: 'saveStory', mode: 'new', story: story('100') }, ctx).ok);
  assert.ok(!Stories.applyOp(store, { type: 'saveStory', mode: 'edit', story: story('999') }, ctx).ok);
  assert.ok(!Stories.applyOp(store, { type: 'saveStory', mode: 'oops', story: story('5') }, ctx).ok);
  assert.ok(!Stories.applyOp(store, { type: 'saveStory', mode: 'new', story: { id: '__proto__', title: 'x' } }, ctx).ok);
  assert.ok(!Stories.applyOp(store, { type: 'nope' }, ctx).ok);
  assert.ok(!Stories.applyOp(store, null, ctx).ok);
  assert.ok(!Stories.applyOp(store, { type: 'tagSessions', ids: [], storyId: '100' }, ctx).ok);
  assert.ok(!Stories.applyOp(store, { type: 'tagSessions', ids: [S[0].id], storyId: 'missing' }, ctx).ok);
  assert.ok(!Stories.applyOp(store, { type: 'tagSessions', ids: new Array(1001).fill(S[0].id), storyId: '100' }, ctx).ok);
});

check('edit keeps created time and changes the rest; the id cannot change', () => {
  const t0 = Stories.applyOp(Core.emptyStore(), { type: 'saveStory', mode: 'new', story: story('7') }, ctx, 1000).store;
  const t1 = Stories.applyOp(t0, { type: 'saveStory', mode: 'edit', story: story('7', { title: 'Renamed', points: 3 }) }, ctx, 2000).store;
  assert.strictEqual(t1.stories['7'].created, 1000); assert.strictEqual(t1.stories['7'].updated, 2000);
  assert.strictEqual(t1.stories['7'].title, 'Renamed'); assert.strictEqual(t1.stories['7'].points, 3);
});

check('create-and-tag in one step (sessions and a prompt)', () => {
  let s2 = ok(Core.emptyStore(), { type: 'saveStory', mode: 'new', story: story('9'), apply: { kind: 'sessions', ids: [S[3].id, S[4].id] } });
  assert.strictEqual(s2.sessionTags[S[3].id], '9'); assert.strictEqual(s2.sessionTags[S[4].id], '9');
  s2 = ok(s2, { type: 'saveStory', mode: 'new', story: story('10'), apply: { kind: 'prompt', sessionId: S[3].id, key: keyOf(S[3].prompts[0]) } });
  assert.strictEqual(s2.promptTags[S[3].id][keyOf(S[3].prompts[0])], '10');
  // a failing apply must not leave a half-made story
  const bad = Stories.applyOp(Core.emptyStore(), { type: 'saveStory', mode: 'new', story: story('11'), apply: { kind: 'sessions', ids: [] } }, ctx);
  assert.ok(!bad.ok);
});

check('bulk tagging: unknown ids skipped, onlyUntagged respected, clearOverrides works', () => {
  let s2 = ok(Core.emptyStore(), { type: 'saveStory', mode: 'new', story: story('1') });
  s2 = ok(s2, { type: 'saveStory', mode: 'new', story: story('2') });
  s2 = ok(s2, { type: 'tagSessions', ids: [S[0].id], storyId: '1' });
  const r = Stories.applyOp(s2, { type: 'tagSessions', ids: [S[0].id, S[1].id, 'nope'], storyId: '2', onlyUntagged: true }, ctx);
  assert.ok(r.ok); assert.strictEqual(r.store.sessionTags[S[0].id], '1'); assert.strictEqual(r.store.sessionTags[S[1].id], '2'); assert.ok(!Core.hasOwn(r.store.sessionTags, 'nope'));
  let s3 = ok(r.store, { type: 'tagPrompt', sessionId: S[1].id, key: keyOf(S[1].prompts[0]), value: '1' });
  assert.ok(Core.hasOwn(s3.promptTags, S[1].id));
  s3 = ok(s3, { type: 'tagSessions', ids: [S[1].id], storyId: '2', clearOverrides: true });
  assert.ok(!Core.hasOwn(s3.promptTags, S[1].id));
  const cleared = ok(s3, { type: 'tagSessions', ids: [S[1].id], storyId: null });
  assert.ok(!Core.hasOwn(cleared.sessionTags, S[1].id));
});

check('prompt tags: set, none, inherit; unknown prompt and session rejected', () => {
  let s2 = ok(Core.emptyStore(), { type: 'saveStory', mode: 'new', story: story('1') });
  const k = keyOf(S[0].prompts[0]);
  s2 = ok(s2, { type: 'tagPrompt', sessionId: S[0].id, key: k, value: '1' }); assert.strictEqual(s2.promptTags[S[0].id][k], '1');
  s2 = ok(s2, { type: 'tagPrompt', sessionId: S[0].id, key: k, value: 'none' }); assert.strictEqual(s2.promptTags[S[0].id][k], null);
  s2 = ok(s2, { type: 'tagPrompt', sessionId: S[0].id, key: k, value: 'inherit' }); assert.ok(!Core.hasOwn(s2.promptTags, S[0].id));
  assert.ok(!Stories.applyOp(s2, { type: 'tagPrompt', sessionId: S[0].id, key: 'zz', value: '1' }, ctx).ok);
  assert.ok(!Stories.applyOp(s2, { type: 'tagPrompt', sessionId: 'nope', key: k, value: '1' }, ctx).ok);
  assert.ok(!Stories.applyOp(s2, { type: 'tagPrompt', sessionId: S[0].id, key: k, value: 'ghost' }, ctx).ok);
});

check('import: merge keeps mine, replace swaps all, junk is dropped', () => {
  const mine = ok(Core.emptyStore(), { type: 'saveStory', mode: 'new', story: story('1', { title: 'Mine' }) });
  const theirs = { kind: Stories.KIND, version: 1, stories: [story('1', { title: 'Theirs' }), story('2')], sessionTags: { [S[0].id]: '2', zzz: 'missing' }, promptTags: {} };
  const merged = Stories.applyOp(mine, { type: 'import', data: theirs, mode: 'merge' }, ctx).store;
  assert.strictEqual(merged.stories['1'].title, 'Mine'); assert.ok(merged.stories['2']); assert.strictEqual(merged.sessionTags[S[0].id], '2'); assert.ok(!Core.hasOwn(merged.sessionTags, 'zzz'));
  const replaced = Stories.applyOp(mine, { type: 'import', data: theirs, mode: 'replace' }, ctx).store;
  assert.strictEqual(replaced.stories['1'].title, 'Theirs');
  const roundTrip = Stories.parseImport(Stories.exportText(merged));
  assert.ok(roundTrip.ok); assert.deepStrictEqual(Core.toPlain(Core.normalizeStore(roundTrip.data)), Core.toPlain(merged));
  assert.ok(!Stories.parseImport('{not json').ok); assert.ok(!Stories.parseImport('{"kind":"other","version":1}').ok); assert.ok(!Stories.parseImport('x'.repeat(6 * 1024 * 1024)).ok);
  const backup = Stories.exportText(store);
  for (const sess of S) { for (const p of sess.prompts) { if (p.text && p.text.length >= 12) { assert.ok(!backup.includes(p.text), 'backup contains no prompt text'); } } if (sess.title && sess.title.length >= 12) { assert.ok(!backup.includes(sess.title), 'backup contains no session titles'); } }
  assert.ok(!backup.includes(os.homedir()) && !/[A-Za-z]:\\\\|\/home\/|\/Users\//.test(backup), 'backup contains no file paths');
});

check('import into a full store: a story that did not fit takes no tags with it', () => {
  const stories = []; for (let i = 0; i < Core.LIMITS.stories; i++) { stories.push({ id: 'F' + i, title: 't' }); }
  const full = Core.normalizeStore({ stories });
  assert.strictEqual(Object.keys(full.stories).length, Core.LIMITS.stories);
  const sid = S[0].id, k0 = keyOf(S[0].prompts[0]);
  const theirs = { kind: Stories.KIND, version: 1, stories: [story('F0', { title: 'dup' }), story('FRESH')], sessionTags: { [sid]: 'FRESH' }, promptTags: { [sid]: { [k0]: 'FRESH' } }, phaseTags: {} };
  for (const mode of ['merge', 'replace']) {
    const r = Stories.applyOp(full, { type: 'import', data: theirs, mode }, ctx);
    assert.ok(r.ok, r.error);
    const out = r.store;
    if (mode === 'merge') { assert.strictEqual(Object.keys(out.stories).length, Core.LIMITS.stories, 'the cap holds'); assert.ok(!Core.hasOwn(out.stories, 'FRESH'), 'FRESH did not fit'); }
    else { assert.ok(Core.hasOwn(out.stories, 'FRESH') && Core.hasOwn(out.stories, 'F0'), 'replace starts empty, so both fit'); }
    if (mode === 'merge') {
      assert.ok(!Core.hasOwn(out.sessionTags, sid), 'no session tag to a story that is not there');
      assert.ok(!Core.hasOwn(out.promptTags, sid), 'no prompt tag to a story that is not there');
    }
    // whatever happened, every tag in memory points at a story that exists
    for (const v of Object.values(out.sessionTags)) { assert.ok(Core.hasOwn(out.stories, v), 'session tag to ' + v); }
    for (const m of Object.values(out.promptTags)) { for (const v of Object.values(m)) { assert.ok(v === null || Core.hasOwn(out.stories, v), 'prompt tag to ' + v); } }
  }
});

/* ---------------- persistence ---------------- */
check('saving is atomic and round-trips; a damaged file is kept aside', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-stories-'));
  assert.deepStrictEqual(Object.keys(Stories.load(dir).store.stories), []);
  Stories.save(dir, store);
  assert.deepStrictEqual(fs.readdirSync(dir), ['stories.json'], 'no temporary file is left behind');
  const back = Stories.load(dir);
  assert.strictEqual(back.recovered, false); assert.deepStrictEqual(Core.toPlain(back.store), Core.toPlain(store));
  fs.writeFileSync(path.join(dir, 'stories.json'), '{broken');
  const bad = Stories.load(dir);
  assert.strictEqual(bad.recovered, true); assert.deepStrictEqual(Object.keys(bad.store.stories), []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('stories.json.damaged-')), 'the damaged file is preserved');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------- suggestions ---------------- */
check('suggestions: strong and weak patterns, matched to existing stories by number', () => {
  const st = ok(ok(Core.emptyStore(), { type: 'saveStory', mode: 'new', story: story('AB#1234') }), { type: 'saveStory', mode: 'new', story: story('US-770') });
  const sess = (texts) => ({ prompts: texts.map((t) => ({ text: t })) });
  let sug = Core.suggestForSession(sess(['fix AB#1234 please', 'continuing AB#1234', 'also #5678 mentioned']), st);
  assert.strictEqual(sug[0].number, '1234'); assert.ok(sug[0].strong); assert.strictEqual(sug[0].count, 2); assert.strictEqual(sug[0].storyId, 'AB#1234');
  assert.strictEqual(sug[1].number, '5678'); assert.ok(!sug[1].strong); assert.strictEqual(sug[1].storyId, null);
  sug = Core.suggestForSession(sess(['work on US 770', 'bug-9001 is unrelated']), st);
  assert.strictEqual(sug.find((x) => x.number === '770').storyId, 'US-770');
  assert.deepStrictEqual(Core.suggestForSession(sess(['color #fff', 'issue #12', 'see https://x.test/page#4567', 'a&#1234;b', 'version 1234']), st), [], 'no false positives');
  const amb = ok(ok(Core.emptyStore(), { type: 'saveStory', mode: 'new', story: story('A-5') }), { type: 'saveStory', mode: 'new', story: story('B-5') });
  assert.strictEqual(Core.suggestForSession(sess(['AB#5']), amb)[0].storyId, null, 'two stories share the number: no automatic match');
});

/* ---------------- waste signals, efficiency, budget, roll-ups ---------------- */
const mk = (sid, ts, text, extra) => ({ s: { id: sid }, ov: false, ts, p: Object.assign({ text, credits: 1, inTok: 100, outTok: 10, cached: 0, quality: 'exact', tag: 'Feature', model: 'm1', calls: 1, i: 1 }, extra || {}) });
check('waste signals: cancelled, retries, cache share, costliest', () => {
  const T = 1700000000000, MIN = 60000;
  const rows = [
    mk('a', T, 'add pagination to the orders endpoint with tests', { credits: 3, canceled: true }),
    mk('a', T + 3 * MIN, 'add pagination to the orders endpoint with unit tests', { credits: 5 }),       // retry of the above (similar, 3 min)
    mk('a', T + 40 * MIN, 'add pagination to the orders endpoint with unit tests', { credits: 7 }),      // same words but 37 min later: not a retry
    mk('a', T + 41 * MIN, 'completely different question about kubernetes ingress', { credits: 2 }),     // dissimilar
    mk('b', T + 4 * MIN, 'add pagination to the orders endpoint with tests', { credits: 11 }),            // other session: not a retry
    mk('c', T, 'x', { credits: 1, quality: 'estimated', inTok: 5000, cached: 4000 }),                     // estimated: excluded from cache share
  ];
  rows.push({ s: { id: 'a' }, ov: true, ts: T, p: { credits: 4, inTok: 0, outTok: 0, calls: 1 } });
  const w = Core.wasteSignals(rows);
  assert.strictEqual(w.canceled.n, 1); near(w.canceled.credits, 3);
  // only the first pair qualifies: T and T+3min are similar and close; T+3min and T+40min are similar but 37 minutes apart
  assert.strictEqual(w.retries.n, 1);
  assert.deepStrictEqual(w.retries.rows.map((r) => r.p.credits), [3], 'flags the earlier prompt of the pair');
  assert.strictEqual(w.cache.share, 0); assert.strictEqual(w.cache.base, 500);
  near(w.background.credits, 4); near(w.background.share, 4 / (3 + 5 + 7 + 2 + 11 + 1 + 4), 'background share');
  assert.deepStrictEqual(w.costliest.map((r) => r.p.credits), [11, 7, 5, 3, 2]);
});

check('efficiency tables need 3 prompts per row and rank cheapest first', () => {
  const rows = [];
  for (let i = 0; i < 3; i++) { rows.push(mk('a', i, 't' + i, { model: 'cheap', credits: 1, tag: 'Bug fix' })); rows.push(mk('a', i, 't' + i, { model: 'dear', credits: 4, tag: 'Bug fix' })); }
  rows.push(mk('a', 9, 'x', { model: 'rare', credits: 0.1, tag: 'Bug fix' }));
  const e = Core.efficiency(rows, (r) => r.p.model);
  assert.deepStrictEqual(e.map((x) => x.k), ['cheap', 'dear']); near(e[0].perPrompt, 1); near(e[1].perPrompt, 4);
  const mt = Core.modelByType(rows);
  assert.strictEqual(mt.length, 1); assert.strictEqual(mt[0].type, 'Bug fix'); assert.deepStrictEqual(mt[0].models.map((m) => m.model), ['cheap', 'dear']);
});

check('budget thresholds and group roll-up', () => {
  const st = { budget: 100 };
  assert.strictEqual(Core.budgetState(st, 79).state, 'ok'); assert.strictEqual(Core.budgetState(st, 80).state, 'warn');
  assert.strictEqual(Core.budgetState(st, 100).state, 'warn'); assert.strictEqual(Core.budgetState(st, 100.01).state, 'over');
  assert.strictEqual(Core.budgetState({ budget: null }, 999).state, 'none');
  const t = (c) => ({ credits: c, inTok: 10, outTok: 5, prompts: 2 });
  const r = Core.rollupByGroup([{ story: { group: 'S1', points: 5 }, t: t(50) }, { story: { group: 'S1', points: null }, t: t(30) }, { story: { group: '', points: 2 }, t: t(10) }]);
  const s1 = r.find((x) => x.group === 'S1');
  near(s1.credits, 80); assert.strictEqual(s1.stories, 2); assert.strictEqual(s1.points, 5); near(s1.perPoint, 10, 'only stories with points count toward credits per point');
  assert.strictEqual(r.find((x) => x.group === '').perPoint, 5);
});

/* ---------------- CSV ---------------- */
check('CSV: story columns, per-story export reconciles with the story total, ranges, formulas', () => {
  const csvRows = (csv) => csv.split('\n').slice(1);
  const full = toCsv(data, { store });
  assert.strictEqual(full.split('\n')[0].split(',').slice(-3).join(','), 'story_id,story_title,story_group');
  assert.strictEqual(csvRows(full).length, S.reduce((a, s) => a + s.prompts.length, 0), 'one row per prompt');
  const one = toCsv(data, { store, storyId: '100' });
  const lines = csvRows(one);
  // credits column is index 11; the rows (prompts + one background row per session) must add up to the story total
  let sum = 0; for (const l of lines) { sum += Number(l.match(/,(\d+\.\d{4}),\d+\.\d{4},(exact|tokens|estimated),/)[1]); }
  // each cell is rounded to 4 decimals, so allow half a unit in the last place per row
  assert.ok(Math.abs(sum - expectedCredits('100')) <= lines.length * 5e-5 + 1e-9, `story CSV adds up to the story total: ${sum} vs ${expectedCredits('100')}`);
  assert.ok(lines.some((l) => l.includes('(background calls)')), 'background calls are included in a story export');
  assert.ok(lines.every((l) => /,100,Story 100,Sprint 1$/.test(l)), 'every row carries the story columns');
  // range filter
  const mid = S[0].prompts[2].ts;
  const rng = csvRows(toCsv(data, { store, storyId: '100', from: mid, to: mid }));
  assert.ok(rng.length >= 1 && rng.length < lines.length, 'range narrows the export');
  // formula injection
  const evil = JSON.parse(JSON.stringify(data));
  evil.sessions[0].title = '@SUM(1+1)'; evil.sessions[0].prompts[0].text = '=cmd|calc'; evil.sessions[0].prompts[1].text = '+1'; evil.sessions[0].prompts[2].text = '-2+3'; evil.sessions[0].prompts[3].text = '\tTAB';
  const es = Core.emptyStore(); es.stories['x'] = { id: 'x', title: '=EVIL()', points: null, budget: null, group: '', created: 0, updated: 0 }; es.sessionTags[evil.sessions[0].id] = 'x';
  const ecsv = toCsv(evil, { store: es });
  for (const cell of ["'@SUM(1+1)", "'=cmd|calc", "'+1", "'-2+3", "'\tTAB", "'=EVIL()"]) { assert.ok(ecsv.includes(cell), 'neutralised: ' + cell); }
  assert.ok(!/(^|,)[=+@]/m.test(ecsv.split('\n').slice(1).join('\n').replace(/"[^"]*"/g, '""')), 'no cell starts with a formula character');
  return `${lines.length} rows for story 100`;
});

/* ---------------- which workspace is this window (two windows must never be mixed up) ---------------- */
check('current workspace: a multi-root window matches its workspace file, never a member folder, whatever the order', () => {
  const W = (kind, p, local) => ({ kind, name: path.basename(p), path: p, local: local !== false });
  const folderA = 'file:///work/shop-api', folderB = 'file:///work/storefront-web', wsFile = 'file:///work/fullstack.code-workspace';
  const orderings = [[folderA, folderB, wsFile], [wsFile, folderB, folderA], [folderB, wsFile, folderA]];
  for (const order of orderings) {
    const workspaces = {}; for (const k of order) { workspaces[k] = k === wsFile ? W('multi-root', '/work/fullstack.code-workspace') : W('folder', k.replace('file://', '')); }
    const winMulti = { uris: [folderA, folderB], paths: ['/work/shop-api', '/work/storefront-web'], file: wsFile, filePath: '/work/fullstack.code-workspace' };
    const winFolder = { uris: [folderB], paths: ['/work/storefront-web'], file: null, filePath: null };
    assert.strictEqual(Core.currentWorkspaceKey(workspaces, winMulti), wsFile, 'multi-root window -> its workspace file (order ' + order.map((k) => path.basename(k)).join(',') + ')');
    assert.strictEqual(Core.currentWorkspaceKey(workspaces, winFolder), folderB, 'folder window -> its folder');
    assert.notStrictEqual(Core.currentWorkspaceKey(workspaces, winMulti), Core.currentWorkspaceKey(workspaces, winFolder), 'two different windows never resolve to the same workspace');
  }
  // the multi-root window has no chats of its own yet: no match, and in particular NOT one of its folders
  const onlyFolders = { [folderA]: W('folder', '/work/shop-api'), [folderB]: W('folder', '/work/storefront-web') };
  assert.strictEqual(Core.currentWorkspaceKey(onlyFolders, { uris: [folderA, folderB], paths: [], file: wsFile, filePath: '/work/fullstack.code-workspace' }), null);
  // the same for a workspace file that lists only ONE folder: no chats under the file -> no match, not "the one folder"
  assert.strictEqual(Core.currentWorkspaceKey(onlyFolders, { uris: [folderA], paths: ['/work/shop-api'], file: wsFile, filePath: '/work/fullstack.code-workspace' }), null);
  // a workspace-file window only matches a multi-root entry, and a folder window only a folder entry
  const swapped = { [wsFile]: W('folder', '/work/fullstack.code-workspace'), [folderA]: W('multi-root', '/work/shop-api') };
  assert.strictEqual(Core.currentWorkspaceKey(swapped, { uris: [], paths: [], file: wsFile, filePath: '/work/fullstack.code-workspace' }), null);
  assert.strictEqual(Core.currentWorkspaceKey(swapped, { uris: [folderA], paths: ['/work/shop-api'], file: null }), null);
  // an untitled multi-folder window (no file) and an empty window cannot be matched
  assert.strictEqual(Core.currentWorkspaceKey(onlyFolders, { uris: [folderA, folderB], paths: [], file: null }), null);
  assert.strictEqual(Core.currentWorkspaceKey(onlyFolders, { uris: [], paths: [], file: null }), null);
  for (const junk of [null, undefined, 'x', 7, [], {}]) { assert.strictEqual(Core.currentWorkspaceKey(onlyFolders, junk), null); }
  assert.strictEqual(Core.currentWorkspaceKey(null, { uris: [folderA] }), null);
  assert.ok(Core.hasWorkspace({ uris: [folderA] }) && Core.hasWorkspace({ file: wsFile, uris: [] }) && !Core.hasWorkspace({ uris: [] }) && !Core.hasWorkspace(null));
});

check('current workspace: Windows paths ignore case and slashes; remote folders never match a local path', () => {
  const ws = {
    'file:///c%3A/Users/Me/Repo': { kind: 'folder', path: 'c:\\Users\\Me\\Repo', local: true },
    'vscode-remote://wsl%2Bubuntu/home/dev/app': { kind: 'folder', path: '/home/dev/app', local: false },
    'file:///home/dev/app': { kind: 'folder', path: '/home/dev/app', local: true },
    '__empty__': { kind: 'none', path: '', local: false },
  };
  // same folder, spelled differently by the two sides (different URI encoding, drive letter case, slash direction, trailing slash)
  assert.strictEqual(Core.currentWorkspaceKey(ws, { uris: ['file:///C:/Users/Me/Repo'], paths: ['C:\\users\\me\\repo\\'] }), 'file:///c%3A/Users/Me/Repo');
  // a WSL window and a local window with the same path are different workspaces
  assert.strictEqual(Core.currentWorkspaceKey(ws, { uris: ['vscode-remote://wsl%2Bubuntu/home/dev/app'], paths: ['/home/dev/app'] }), 'vscode-remote://wsl%2Bubuntu/home/dev/app');
  assert.strictEqual(Core.currentWorkspaceKey(ws, { uris: ['file:///home/dev/app'], paths: ['/home/dev/app'] }), 'file:///home/dev/app');
  // a remote window we have never scanned must NOT be matched to the local folder that happens to have the same path
  assert.strictEqual(Core.currentWorkspaceKey(ws, { uris: ['vscode-remote://ssh-remote%2Bother/home/dev/app'], paths: ['/home/dev/app'] }), null);
  assert.strictEqual(Core.currentWorkspaceKey(ws, { uris: ['vscode-remote://ssh-remote%2Bother/c:/Users/Me/Repo'], paths: ['c:\\Users\\Me\\Repo'] }), null);
  // and a remote multi-root window matches only by its exact workspace-file URI
  const rw = { 'vscode-remote://wsl%2Bubuntu/home/dev/x.code-workspace': { kind: 'multi-root', path: '/home/dev/x.code-workspace', local: false }, 'file:///home/dev/x.code-workspace': { kind: 'multi-root', path: '/home/dev/x.code-workspace', local: true } };
  assert.strictEqual(Core.currentWorkspaceKey(rw, { uris: [], paths: [], file: 'vscode-remote://wsl%2Bubuntu/home/dev/x.code-workspace', filePath: '/home/dev/x.code-workspace' }), 'vscode-remote://wsl%2Bubuntu/home/dev/x.code-workspace');
  assert.strictEqual(Core.currentWorkspaceKey(rw, { uris: [], paths: [], file: 'vscode-remote://ssh-remote%2Bq/home/dev/x.code-workspace', filePath: '/home/dev/x.code-workspace' }), null);
  // a local window is matched to the LOCAL entry by path even when a remote entry with the same path is listed first
  const mixed = {
    'vscode-remote://wsl%2Bubuntu/c:/users/me/repo': { kind: 'folder', path: 'c:/users/me/repo', local: false },
    'file:///c%3A/Users/Me/Repo': { kind: 'folder', path: 'c:\\Users\\Me\\Repo', local: true },
  };
  assert.strictEqual(Core.currentWorkspaceKey(mixed, { uris: ['file:///C:/Users/Me/Repo'], paths: ['C:\\Users\\Me\\Repo'] }), 'file:///c%3A/Users/Me/Repo');
  const remoteOnly = { 'vscode-remote://wsl%2Bubuntu/home/dev/app': { kind: 'folder', path: '/home/dev/app', local: false } };
  assert.strictEqual(Core.currentWorkspaceKey(remoteOnly, { uris: ['file:///home/dev/app'], paths: ['/home/dev/app'] }), null, 'a local window is not matched to a remote entry that has the same path');
  // Linux paths are case-sensitive
  assert.strictEqual(Core.currentWorkspaceKey(ws, { uris: ['file:///home/dev/APP'], paths: ['/home/dev/APP'] }), null);
  // the empty-window bucket is never "this window"
  assert.strictEqual(Core.currentWorkspaceKey(ws, { uris: [''], paths: [''] }), null);
});

/* ---------------- lifecycle phase ---------------- */
const P = (text, tag, agent) => Core.autoPhase({ text, tag: tag || 'Other', agent: agent || '' });

check('phase: automatic rules, in priority order', () => {
  // [text, work type from the scanner, agent, expected]
  const cases = [
    ['Create a plan to migrate auth to OAuth', 'Feature', '', 'plan'],            // planning words beat the work type
    ['Design the retry architecture for the worker', 'Feature', '', 'plan'],
    ['Break this down into milestones', 'Other', '', 'plan'],
    ['anything at all', 'Other', 'Plan', 'plan'],                                  // Copilot's Plan agent
    ['Investigate why the nightly build is slow', 'Other', '', 'analysis'],
    ['Do a root cause analysis of the outage', 'Bug fix', '', 'analysis'],         // investigating words beat the work type
    ['Compare Redis and Memcached for sessions', 'Other', '', 'analysis'],
    ['Explain how the saga orchestrator works', 'Explain', '', 'analysis'],        // no keyword: falls to the work type
    ['Fix the null reference in cart totals', 'Bug fix', '', 'bugfix'],
    ['Add jest tests for the cart', 'Tests', '', 'test'],
    ['Add an endpoint to list orders', 'Feature', '', 'build'],
    ['Rename the DTOs', 'Refactor', '', 'refactor'],
    ['Update the README', 'Docs', '', 'docs'],
    ['Write a terraform module', 'DevOps', '', 'release'],
    ['Review this diff', 'Review', '', 'review'],
    ['continue', 'Other', '', 'other'],
    ['', 'Other', '', 'other'],
    ['Update the planner widget', 'Feature', '', 'build'],                         // "planner" is not "plan"
    ['Add a design token for spacing', 'Feature', '', 'plan'],                     // known limit of a keyword rule: "design" wins; the person can correct it
    ['whatever', 'NotARealTag', '', 'other'],
    ['whatever', 'constructor', '', 'other'],                                      // a tag named like an inherited property is not a lookup hit
  ];
  for (const [text, tag, agent, want] of cases) { assert.strictEqual(P(text, tag, agent), want, JSON.stringify(text) + ' [' + tag + (agent ? ', ' + agent : '') + ']'); }
  assert.deepStrictEqual(Core.PHASE_KEYS, oracle.ORDER);
  for (const k of oracle.ORDER) { assert.strictEqual(Core.phaseLabel(k), oracle.LABEL[k]); }
  for (const k of Core.PHASE_KEYS) { assert.ok(Core.phaseLabel(k) && Core.validPhase(k)); }
  for (const bad of ['', 'Build', 'constructor', '__proto__', null, 7]) { assert.ok(!Core.validPhase(bad), String(bad)); assert.strictEqual(Core.phaseLabel(bad), ''); }
  return cases.length + ' cases';
});

check('phase: your choice beats the guess, per prompt; background calls have no phase', () => {
  const sa = { id: 'sa' }, p1 = { ts: 1000, i: 0, text: 'Fix the crash', tag: 'Bug fix' }, p2 = { ts: 2000, i: 1, text: 'Add a field', tag: 'Feature' };
  const r1 = { s: sa, p: p1, ov: false }, r2 = { s: sa, p: p2, ov: false };
  const st = Core.emptyStore();
  assert.strictEqual(Core.phaseOf(st, r1), 'bugfix'); assert.strictEqual(Core.phaseSource(st, r1), 'auto');
  st.phaseTags.sa = Core.dict(); st.phaseTags.sa['1000'] = 'plan';
  assert.strictEqual(Core.phaseOf(st, r1), 'plan'); assert.strictEqual(Core.phaseSource(st, r1), 'manual');
  assert.strictEqual(Core.phaseOf(st, r2), 'build', 'the other prompt in the session is untouched'); assert.strictEqual(Core.phaseSource(st, r2), 'auto');
  assert.strictEqual(Core.phaseOf(null, r1), 'bugfix', 'no store at all: the guess');
  assert.strictEqual(Core.phaseOf({ stories: {}, sessionTags: {}, promptTags: {} }, r1), 'bugfix', 'a store from before phases existed: the guess');
  st.phaseTags.sa['1000'] = 'not-a-phase'; // corrupt value that slipped in: ignored
  assert.strictEqual(Core.phaseOf(st, r1), 'bugfix');
  const bg = { s: sa, p: { credits: 1 }, ov: true };
  assert.strictEqual(Core.phaseOf(st, bg), null); assert.strictEqual(Core.phaseSource(st, bg), null);
  // a story tag has no effect on the phase and the other way round
  st.sessionTags.sa = 'X'; assert.strictEqual(Core.phaseOf(st, r2), 'build');
});

check('phase: totals by phase add up to the prompts in the data, in lifecycle order', () => {
  const rows = Core.buildRows(data).rows;
  const by = Core.byPhase(rows, store);
  // oracle: loop over the raw payload, applying the documented rule by hand
  const want = new Map(); let credits = 0, prompts = 0;
  for (const s of S) {
    for (const p of s.prompts) {
      const k = oracle.guess(p);
      const e = want.get(k) || { c: 0, n: 0 }; e.c += p.credits; e.n++; want.set(k, e); credits += p.credits; prompts++;
    }
  }
  assert.strictEqual(by.reduce((a, e) => a + e.prompts, 0), prompts, 'every prompt is in exactly one phase');
  near(by.reduce((a, e) => a + e.credits, 0), credits, 'phase credits add up to prompt credits (background calls are not a phase)');
  for (const e of by) { assert.strictEqual(e.prompts, want.get(e.k).n, e.k + ' count'); near(e.credits, want.get(e.k).c, e.k + ' credits'); assert.strictEqual(e.label, Core.phaseLabel(e.k)); }
  const order = by.map((e) => Core.PHASE_KEYS.indexOf(e.k)); assert.deepStrictEqual(order, order.slice().sort((a, b) => a - b), 'lifecycle order, not by size');
  return by.map((e) => e.k + ':' + e.prompts).join(' ');
});

check('phase: tagPhase sets, clears, validates and never edits the input store', () => {
  const sid = A.id, k0 = keyOf(A.prompts[0]), k1 = keyOf(A.prompts[1]);
  const base = Core.emptyStore();
  const snapshot = JSON.stringify(Core.toPlain(base));
  let st = ok(base, { type: 'tagPhase', sessionId: sid, keys: [k0, k1], phase: 'test' });
  assert.strictEqual(JSON.stringify(Core.toPlain(base)), snapshot, 'input store not modified');
  assert.strictEqual(st.phaseTags[sid][k0], 'test'); assert.strictEqual(st.phaseTags[sid][k1], 'test');
  st = ok(st, { type: 'tagPhase', sessionId: sid, keys: [k0], phase: 'auto' });
  assert.ok(!Core.hasOwn(st.phaseTags[sid], k0) && st.phaseTags[sid][k1] === 'test', 'auto clears just that prompt');
  st = ok(st, { type: 'tagPhase', sessionId: sid, keys: [k1], phase: 'auto' });
  assert.ok(!Core.hasOwn(st.phaseTags, sid), 'an emptied session entry is removed');
  const fail = (op, re) => { const r = Stories.applyOp(base, op, ctx, 5000); assert.ok(!r.ok && re.test(r.error), JSON.stringify(op).slice(0, 80) + ' -> ' + r.error); };
  fail({ type: 'tagPhase', sessionId: 'nope', keys: [k0], phase: 'build' }, /session was not found/);
  fail({ type: 'tagPhase', sessionId: sid, keys: [], phase: 'build' }, /at least one prompt/);
  fail({ type: 'tagPhase', sessionId: sid, keys: 'x', phase: 'build' }, /at least one prompt/);
  fail({ type: 'tagPhase', sessionId: sid, keys: [k0], phase: 'Build' }, /not a lifecycle phase/);
  fail({ type: 'tagPhase', sessionId: sid, keys: [k0], phase: '__proto__' }, /not a lifecycle phase/);
  fail({ type: 'tagPhase', sessionId: sid, keys: new Array(Core.LIMITS.bulk + 1).fill(k0), phase: 'build' }, /at most/);
  const r = Stories.applyOp(base, { type: 'tagPhase', sessionId: sid, keys: ['not-a-key', k0, 7], phase: 'docs' }, ctx, 5000);
  assert.ok(r.ok && /\(2 skipped\)/.test(r.message) && r.store.phaseTags[sid][k0] === 'docs' && Object.keys(r.store.phaseTags[sid]).length === 1, r.message);
  assert.strictEqual(Stories.applyOp(base, { type: 'tagPhase', sessionId: '__proto__', keys: [k0], phase: 'docs' }, ctx, 5000).ok, false);
});

check('phase: tags survive save, load and backup; import merges without overwriting, replace replaces', () => {
  const sid = A.id, k0 = keyOf(A.prompts[0]), k1 = keyOf(A.prompts[1]);
  let st = ok(Core.emptyStore(), { type: 'tagPhase', sessionId: sid, keys: [k0, k1], phase: 'plan' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-phase-'));
  Stories.save(dir, st);
  const back = Stories.load(dir).store;
  assert.deepStrictEqual(Core.toPlain(back).phaseTags, Core.toPlain(st).phaseTags);
  const text = Stories.exportText(st);
  assert.ok(!S.some((s) => s.prompts.some((p) => p.text && p.text.length >= 12 && text.includes(p.text))), 'backup holds no prompt text');
  const parsed = Stories.parseImport(text); assert.ok(parsed.ok);
  let mine = ok(Core.emptyStore(), { type: 'tagPhase', sessionId: sid, keys: [k0], phase: 'bugfix' });
  let merged = ok(mine, { type: 'import', mode: 'merge', data: parsed.data });
  assert.strictEqual(merged.phaseTags[sid][k0], 'bugfix', 'merge keeps what you already set'); assert.strictEqual(merged.phaseTags[sid][k1], 'plan', 'and adds the rest');
  let replaced = ok(mine, { type: 'import', mode: 'replace', data: parsed.data });
  assert.strictEqual(replaced.phaseTags[sid][k0], 'plan', 'replace takes the file');
  // a backup written before phases existed does not wipe phases on merge
  const old = { kind: Stories.KIND, version: 1, stories: [], sessionTags: {}, promptTags: {} };
  assert.strictEqual(ok(mine, { type: 'import', mode: 'merge', data: old }).phaseTags[sid][k0], 'bugfix');
  // hostile import values are dropped
  const evil = JSON.parse(`{"kind":"${Stories.KIND}","version":1,"phaseTags":{"${sid}":{"${k0}":"rm -rf","${k1}":"build","__proto__":"build"},"__proto__":{"x":"build"}}}`);
  const e = ok(Core.emptyStore(), { type: 'import', mode: 'merge', data: evil });
  assert.deepStrictEqual(Object.keys(e.phaseTags[sid]), [k1]); assert.strictEqual({}.x, undefined);
  assert.ok(!Core.hasOwn(e.phaseTags, '__proto__'), 'a __proto__ session is dropped');
  const plain = Core.toPlain(e);
  assert.strictEqual(Object.getPrototypeOf(plain.phaseTags), Object.prototype, 'converting back to plain JSON cannot change a prototype'); assert.strictEqual(plain.phaseTags.x, undefined);
  assert.deepStrictEqual(Object.keys(plain.phaseTags), [sid]);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('phase: CSV has phase and phase_source columns (guess, your choice, background)', () => {
  const parse = (line) => { const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') { q = false; } else { cur += c; } } else if (c === '"') { q = true; } else if (c === ',') { out.push(cur); cur = ''; } else { cur += c; } } out.push(cur); return out; };
  const sid = A.id, k = keyOf(A.prompts[1]);
  const st = ok(Core.emptyStore(), { type: 'tagPhase', sessionId: sid, keys: [k], phase: 'plan' });
  const csv = toCsv(data, { store: st });
  const lines = csv.split('\n'); const head = parse(lines[0]);
  assert.deepStrictEqual(head.slice(5, 9), ['work_type', 'phase', 'phase_source', 'model']);
  const sessionOf = (title) => title; let manual = 0, auto = 0;
  const idx = (name) => head.indexOf(name);
  for (const l of lines.slice(1)) {
    const c = parse(l); assert.strictEqual(c.length, head.length, 'every row has every column');
    if (c[idx('phase_source')] === 'manual') { manual++; assert.strictEqual(c[idx('phase')], 'Plan & design'); } else { auto++; assert.strictEqual(c[idx('phase_source')], 'auto'); assert.ok(Core.PHASES.some(([, l2]) => l2 === c[idx('phase')]), c[idx('phase')]); }
  }
  assert.strictEqual(manual, 1); assert.strictEqual(auto, lines.length - 2);
  // without a store the file still says what the guess is
  const plain = toCsv(data); assert.ok(plain.split('\n').slice(1).every((l) => parse(l)[idx('phase_source')] === 'auto'));
  // a story export adds the background row, which has its own marker
  const story1 = ok(ok(Core.emptyStore(), { type: 'saveStory', mode: 'new', story: { id: 'Z1', title: 'z' } }), { type: 'tagSessions', ids: [S.find((s) => s.overhead).id], storyId: 'Z1' });
  const bgRow = toCsv(data, { store: story1, storyId: 'Z1' }).split('\n').slice(1).map(parse).find((c) => c[4] === '(background calls)');
  assert.ok(bgRow && bgRow[idx('phase')] === 'Background' && bgRow[idx('phase_source')] === '' && bgRow.length === head.length);
  return `${lines.length - 1} rows, ${head.length} columns`;
});

/* ---------------- several windows share one stories file ---------------- */
check('two windows: an edit in one is never lost by the other (reload before write)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-windows-'));
  // window A and window B each start from the same saved file and keep their own copy in memory
  let a = { store: Core.emptyStore(), stamp: null }, b = { store: Core.emptyStore(), stamp: null };
  const sync = (w) => { const r = Stories.refresh(dir, w.stamp); w.stamp = r.stamp; if (r.changed) { w.store = r.store; } return r; };
  const edit = (w, op) => { sync(w); const r = Stories.applyOp(w.store, op, ctx, 5000); assert.ok(r.ok, r.error); w.stamp = Stories.save(dir, r.store); w.store = r.store; };
  sync(a); sync(b);
  assert.strictEqual(a.stamp, 'missing'); assert.ok(!sync(a).changed, 'nothing new when nothing changed');
  edit(a, { type: 'saveStory', mode: 'new', story: story('FROM-A') });
  edit(b, { type: 'saveStory', mode: 'new', story: story('FROM-B') });                         // B has never looked since A saved
  edit(a, { type: 'tagSessions', ids: [A.id], storyId: 'FROM-B' });                            // A tags with B's story, which it only knows by reloading
  edit(b, { type: 'tagPhase', sessionId: A.id, keys: [keyOf(A.prompts[0])], phase: 'test' });
  const disk = Stories.load(dir).store;
  assert.deepStrictEqual(Object.keys(disk.stories).sort(), ['FROM-A', 'FROM-B'], 'both windows\' stories are on disk');
  assert.strictEqual(disk.sessionTags[A.id], 'FROM-B'); assert.strictEqual(disk.phaseTags[A.id][keyOf(A.prompts[0])], 'test');
  // our own save does not look like somebody else's change (the stamp taken before the rename matches the saved file)
  assert.strictEqual(sync(b).changed, false, 'own save is not seen as a foreign change');
  // and the hazard is real: applying an edit to a stale in-memory copy and writing it (what happened before) loses the other window's work
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-stale-'));
  const winA = ok(Core.emptyStore(), { type: 'saveStory', mode: 'new', story: story('ONLY-A') }); Stories.save(dir2, winA);
  const staleB = Core.emptyStore(); // window B loaded before A saved and never looked again
  Stories.save(dir2, ok(staleB, { type: 'saveStory', mode: 'new', story: story('ONLY-B') }));
  assert.deepStrictEqual(Object.keys(Stories.load(dir2).store.stories), ['ONLY-B'], 'without a reload, B overwrites A');
  fs.rmSync(dir2, { recursive: true, force: true });
  // a window that is only looking picks the change up when it syncs
  const c = { store: Core.emptyStore(), stamp: null }; const r = sync(c); assert.ok(r.changed && Object.keys(c.store.stories).length === 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('two windows: a damaged or removed file never wipes what a window has in memory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-damaged-'));
  const w = { store: Core.emptyStore(), stamp: null };
  w.store = ok(Core.emptyStore(), { type: 'saveStory', mode: 'new', story: story('KEEP') }); w.stamp = Stories.save(dir, w.store);
  fs.writeFileSync(path.join(dir, Stories.FILE), '{ half a file'); // another window crashed mid-write on a filesystem without atomic rename
  const r = Stories.refresh(dir, w.stamp);
  assert.ok(r.damaged && !r.changed && !r.store, 'reported as damaged, no replacement store');
  assert.strictEqual(fs.readFileSync(path.join(dir, Stories.FILE), 'utf8'), '{ half a file', 'refresh does not touch the file');
  assert.ok(!Stories.refresh(dir, r.stamp).changed && !Stories.refresh(dir, r.stamp).damaged, 'the same bad file is not re-parsed every time');
  // too big
  fs.writeFileSync(path.join(dir, Stories.FILE), ' '.repeat(21 * 1024 * 1024));
  assert.ok(Stories.refresh(dir, r.stamp).damaged, 'an oversized file is treated as damaged');
  // removed: that is a real change (someone deleted it), and the store is empty
  fs.rmSync(path.join(dir, Stories.FILE));
  const gone = Stories.refresh(dir, r.stamp); assert.ok(gone.changed && gone.stamp === 'missing' && Object.keys(gone.store.stories).length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('summarize can be limited to one workspace', () => {
  const { summarize } = require('../lib/scanner.js');
  const keys = [...new Set(S.map((s) => s.wsKey))];
  let sumC = 0, sumP = 0;
  for (const k of keys) {
    const x = summarize(data, 0, k);
    let c = 0, n = 0; for (const s of S) { if (s.wsKey !== k) { continue; } for (const p of s.prompts) { c += p.credits; n++; } if (s.overhead) { c += s.overhead.credits; } }
    near(x.credits, c, 'credits for ' + k); assert.strictEqual(x.prompts, n);
    sumC += x.credits; sumP += x.prompts;
  }
  const all = summarize(data, 0);
  near(sumC, all.credits, 'workspaces add up to the total'); assert.strictEqual(sumP, all.prompts);
  assert.strictEqual(summarize(data, 0, 'no-such-workspace').prompts, 0);
});

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nStory logic checks passed.');
process.exit(failed ? 1 : 0);
