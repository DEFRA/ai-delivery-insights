'use strict';
/**
 * Tests for lib/effort.js (the "size-v1" rule of thumb). Expected hours are worked out by hand in the comments.
 * Run: node test/test-effort.js
 */
const assert = require('assert');
const Core = require('../media/story-core.js');
const E = require('../lib/effort.js');

let failed = 0;
function check(name, fn) {
  try { const r = fn(); console.log('PASS ' + name + (r === undefined ? '' : ' -> ' + r)); } catch (e) { failed++; console.log('FAIL ' + name + ' -> ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : e)); }
}

const file = (p, a, d, extra) => ({ path: p, added: a, deleted: d, ...(extra || {}) });
const commit = (key, match, files) => ({ key, match, files });
const pad = (n, prefix) => Array.from({ length: n }, (_, i) => file(`${prefix}${i}.js`, 0, 0));

check('the worked example: 450 + 300 weighted lines and 14 files give 46.4 hours (32.5 to 69.6)', () => {
  // production 450 / 150 per day = 3 days = 24.0 h; tests 300 / 250 = 1.2 days = 9.6 h; 14 files x 0.25 = 3.5 h
  // subtotal 37.1 h; x 1.25 = 46.375 -> 46.4; low x 0.7 = 32.4625 -> 32.5; high x 1.5 = 69.5625 -> 69.6
  const r = E.estimate({ commits: [commit('0:aaaaaaaa', 'id', [file('src/a.js', 400, 100), file('test/a.test.js', 280, 40), ...pad(12, 'src/f')])] });
  assert.ok(r.ok);
  assert.deepStrictEqual([r.hours, r.low, r.high, r.confidence, r.method], [46.4, 32.5, 69.6, 'high', 'size-v1']);
  assert.deepStrictEqual(r.inputs, { commits: 1, prodLines: 450, testLines: 300, files: 14, points: undefined });
  assert.deepStrictEqual(r.steps.map((s) => s.value), [24, 9.6, 3.5, 37.1, 46.4, null]);
  assert.match(r.steps[0].detail, /450 weighted lines .* 150 lines a day .* 8 hours/);
  assert.match(r.steps[4].label, /Overhead \+25%/);
  assert.match(r.steps[5].detail, /70% to 150%.*32\.5 to 69\.6 hours/);
});

check('lines are weighted: a deleted line counts half; sums are rounded once at the end', () => {
  // 100 added + 40 deleted = 120 weighted; 120 / 150 x 8 = 6.4 h; 1 file = 0.25; 6.65 x 1.25 = 8.3125 -> 8.3
  const r = E.estimate({ commits: [commit('0:a', 'id', [file('src/a.js', 100, 40)])] });
  assert.strictEqual(r.hours, 8.3);
  assert.strictEqual(r.inputs.prodLines, 120);
  // 7 production files with 1 line each: 7 / 150 x 8 = 0.3733 h; 7 x 0.25 = 1.75; 2.1233 x 1.25 = 2.654 -> 2.7 (rounding every step first would give 2.7 too; the next case would not)
  const s = E.estimate({ commits: [commit('0:a', 'id', Array.from({ length: 7 }, (_, i) => file(`src/f${i}.js`, 1, 0)))] });
  assert.strictEqual(s.hours, 2.7);
});

check('settings change the answer exactly as the formula says', () => {
  // prod 300 weighted at 100 lines/day, 8 h/day = 24 h; 3 files = 0.75 h; subtotal 24.75; no overhead -> 24.75 -> 24.8; low 17.325 -> 17.3; high 37.125 -> 37.1
  const r = E.estimate({ commits: [commit('0:a', 'id', [file('src/a.js', 300, 0), file('src/b.js', 0, 0), file('src/c.js', 0, 0)])], settings: { prodLinesPerDay: 100, overheadPercent: 0 } });
  assert.deepStrictEqual([r.hours, r.low, r.high], [24.8, 17.3, 37.1]);
  // a 6 hour day: 300 / 150 x 6 = 12 h; + 0.25 = 12.25 x 1.25 = 15.3125 -> 15.3
  assert.strictEqual(E.estimate({ commits: [commit('0:a', 'id', [file('src/a.js', 300, 0)])], settings: { hoursPerDay: 6 } }).hours, 15.3);
  // tests at 500 lines a day: 500 / 500 x 8 = 8 h; + 0.25 = 8.25 x 1.25 = 10.3125 -> 10.3
  assert.strictEqual(E.estimate({ commits: [commit('0:a', 'id', [file('test/a.test.js', 500, 0)])], settings: { testLinesPerDay: 500 } }).hours, 10.3);
});

check('settings from outside are checked: silly values fall back to the defaults', () => {
  const bad = E.normalizeSettings({ prodLinesPerDay: -5, testLinesPerDay: 'x', hoursPerDay: 99, overheadPercent: NaN, hoursPerPoint: -1 });
  assert.deepStrictEqual(bad, { prodLinesPerDay: 150, testLinesPerDay: 250, hoursPerDay: 8, overheadPercent: 25, hoursPerPoint: 0 });
  assert.deepStrictEqual(E.normalizeSettings(null), E.DEFAULTS);
  assert.deepStrictEqual(E.normalizeSettings({ prodLinesPerDay: 200, overheadPercent: 0, hoursPerPoint: 6 }), { prodLinesPerDay: 200, testLinesPerDay: 250, hoursPerDay: 8, overheadPercent: 0, hoursPerPoint: 6 });
});

check('which files count: code and config yes; tests separately; docs, locks, generated, vendored, build output and binaries no', () => {
  const table = {
    'src/a.js': 'prod', 'src/App.vue': 'prod', 'Makefile': 'prod', '.github/workflows/ci.yml': 'prod', 'requirements.txt': 'prod', 'bin/cli.js': 'prod', 'src/contest/x.js': 'prod', 'src/latest.js': 'prod', 'C:\\x\\y.js': 'prod',
    'src/a.test.ts': 'test', 'test/foo.js': 'test', 'tests/x/y.py': 'test', 'a/b/FooTests.cs': 'test', 'x/test_util.py': 'test', 'a/b/fooSpec.java': 'test', 'spec/a_spec.rb': 'test', 'e2e/login.ts': 'test',
    'package-lock.json': 'ignored', 'yarn.lock': 'ignored', 'go.sum': 'ignored', 'Cargo.lock': 'ignored', 'node_modules/x/y.js': 'ignored', 'vendor/lib/a.php': 'ignored', 'dist/app.js': 'ignored', 'build/out.js': 'ignored',
    'app.min.js': 'ignored', 'bin/Debug/app.dll': 'ignored', 'README.md': 'ignored', 'docs/guide.html': 'ignored', 'CHANGELOG.md': 'ignored', 'LICENSE': 'ignored', 'img/logo.png': 'ignored', 'src/__snapshots__/a.snap': 'ignored',
    'api.pb.go': 'ignored', 'Model.Designer.cs': 'ignored', 'font.woff2': 'ignored', 'x.map': 'ignored', '': 'ignored',
  };
  for (const [p, want] of Object.entries(table)) { assert.strictEqual(E.classify(p), want, p); }
});

check('ignored and binary files are not counted as lines, and only real files add file time', () => {
  const r = E.estimate({ commits: [commit('0:a', 'id', [file('src/a.js', 150, 0), file('package-lock.json', 9000, 3000), file('README.md', 400, 0), file('img/a.png', 0, 0, { binary: true }), file('src/data.bin2', 0, 0, { binary: true })])] });
  // prod 150 / 150 x 8 = 8 h; files: src/a.js and src/data.bin2? the binary non-ignored file is skipped before it is counted, so 1 file = 0.25; 8.25 x 1.25 = 10.3125 -> 10.3
  assert.strictEqual(r.hours, 10.3);
  assert.deepStrictEqual([r.counts.prodFiles, r.counts.ignoredFiles, r.counts.binaryFiles], [1, 3, 1]);
  const none = E.estimate({ commits: [commit('0:a', 'id', [file('package-lock.json', 10, 1), file('README.md', 4, 0)])] });
  assert.ok(!none.ok && /only change documentation, generated, lock or binary files/.test(none.reason));
});

check('only ticked commits count; none ticked, or none found, says what to do', () => {
  const list = [commit('0:a', 'id', [file('src/a.js', 150, 0)]), commit('0:b', 'id', [file('src/b.js', 300, 0)])];
  // only a: 150 / 150 x 8 = 8 + 0.25 = 8.25 x 1.25 = 10.3125 -> 10.3 ; both: 450 / 150 x 8 = 24 + 0.5 = 24.5 x 1.25 = 30.625 -> 30.6
  assert.strictEqual(E.estimate({ commits: list, selected: ['0:a'] }).hours, 10.3);
  assert.strictEqual(E.estimate({ commits: list, selected: new Set(['0:a', '0:b']) }).hours, 30.6);
  assert.strictEqual(E.estimate({ commits: list }).hours, 30.6, 'no selection means all');
  const none = E.estimate({ commits: list, selected: [] });
  assert.ok(!none.ok && /No commits are ticked/.test(none.reason));
  assert.ok(!E.estimate({ commits: list, selected: ['9:zzz'] }).ok);
  const empty = E.estimate({ commits: [] });
  assert.ok(!empty.ok && /No commits were found/.test(empty.reason));
  assert.ok(!E.estimate({}).ok && !E.estimate(null).ok);
});

check('a file changed in two commits adds its lines twice but its file time once; the same path in two repositories is two files', () => {
  const two = E.estimate({ commits: [commit('0:a', 'id', [file('src/a.js', 75, 0)]), commit('0:b', 'id', [file('src/a.js', 75, 0)])] });
  // 150 / 150 x 8 = 8 + 1 file x 0.25 = 8.25 x 1.25 = 10.3125 -> 10.3
  assert.strictEqual(two.hours, 10.3);
  assert.strictEqual(two.inputs.files, 1);
  const repos = E.estimate({ commits: [commit('0:a', 'id', [file('src/a.js', 75, 0)]), commit('1:b', 'id', [file('src/a.js', 75, 0)])] });
  assert.strictEqual(repos.inputs.files, 2);
  assert.strictEqual(repos.hours, 10.6); // 8 + 0.5 = 8.5 x 1.25 = 10.625 -> 10.6
});

check('confidence follows how the commits were found, and the notes say so', () => {
  const f = [file('src/a.js', 100, 0)];
  const c = (key, match) => commit(key, match, f);
  assert.strictEqual(E.estimate({ commits: [c('0:a', 'id'), c('0:b', 'id')] }).confidence, 'high');
  assert.strictEqual(E.estimate({ commits: [c('0:a', 'branch')] }).confidence, 'high', 'a branch named for the story is as explicit as a message');
  const mixed = E.estimate({ commits: [c('0:a', 'id'), c('0:b', 'time')] });
  assert.strictEqual(mixed.confidence, 'medium');
  assert.ok(mixed.notes.some((n) => /1 commit was matched only by time/.test(n)));
  const timeOnly = E.estimate({ commits: [c('0:a', 'time'), c('0:b', 'time')] });
  assert.strictEqual(timeOnly.confidence, 'low');
  assert.ok(timeOnly.notes.some((n) => /only by the time you were working/.test(n)));
  assert.deepStrictEqual([timeOnly.counts.byId, timeOnly.counts.byTime], [0, 2]);
  assert.strictEqual(E.estimate({ commits: [c('0:a', 'id'), c('0:b', 'time')], selected: ['0:a'] }).confidence, 'high', 'unticking the time-based commit raises it');
});

check('notes warn about one commit dominating, and about tiny changes', () => {
  const big = E.estimate({ commits: [commit('0:abcdef12', 'id', [file('src/a.js', 1000, 0)]), commit('0:b', 'id', [file('src/b.js', 100, 0)])] });
  assert.ok(big.notes.some((n) => /abcdef12.*more than 60%/.test(n)), JSON.stringify(big.notes));
  const even = E.estimate({ commits: [commit('0:a', 'id', [file('src/a.js', 500, 0)]), commit('0:b', 'id', [file('src/b.js', 500, 0)])] });
  assert.ok(!even.notes.some((n) => /60%/.test(n)));
  assert.ok(!E.estimate({ commits: [commit('0:a', 'id', [file('src/a.js', 1000, 0)])] }).notes.some((n) => /60%/.test(n)), 'one commit is always all of it');
  assert.ok(E.estimate({ commits: [commit('0:a', 'id', [file('src/a.js', 3, 1)])] }).notes.some((n) => /Very little code/.test(n)));
});

check('the story points cross-check: same range, far above, far below, or off', () => {
  const r = (points, hoursPerPoint) => E.estimate({ commits: [commit('0:a', 'id', [file('src/a.js', 400, 100), file('test/a.test.js', 280, 40), ...pad(12, 'src/f')])], settings: { hoursPerPoint }, points });
  const same = r(5, 8).pointsCheck;                       // 5 x 8 = 40 h; 46.4 / 40 = 1.16
  assert.deepStrictEqual([same.expected, same.ratio], [40, 1.16]);
  assert.match(same.note, /in the same range/);
  assert.match(r(1, 8).pointsCheck.note, /more than twice/);   // 8 h; 46.4 / 8 = 5.8
  assert.match(r(13, 8).pointsCheck.note, /less than half/);   // 104 h; 0.45
  assert.strictEqual(r(5, 0).pointsCheck, null, 'off by default');
  assert.strictEqual(E.estimate({ commits: [commit('0:a', 'id', [file('src/a.js', 100, 0)])], settings: { hoursPerPoint: 8 }, points: null }).pointsCheck, null);
  assert.strictEqual(r(5, 8).inputs.points, 5);
});

check('hostile or broken commit data cannot crash the estimate or inflate it', () => {
  const r = E.estimate({
    commits: [
      null, 5, 'x', { key: 7 }, { match: 'id', files: [] },
      commit('0:a', 'id', [null, 'x', file('src/a.js', NaN, -5), file('src/b.js', Infinity, 0), file('src/c.js', 'ten', 0), { added: 5 }, file('src/d.js', 150, 0)]),
      { key: '0:b', match: 'id', files: 'not a list' },
    ],
  });
  assert.ok(r.ok);
  assert.strictEqual(r.inputs.prodLines, 150, 'only the one valid file counted its lines');
  assert.ok(Number.isFinite(r.hours));
  const huge = E.estimate({ commits: [commit('0:a', 'id', [file('src/a.js', 1e15, 0)])] });
  assert.ok(!huge.ok && /outside a believable range/.test(huge.reason));
});

check('the estimate becomes a store record the store accepts, and a failed estimate becomes nothing', () => {
  const r = E.estimate({ commits: [commit('0:aaaaaaaa', 'id', [file('src/a.js', 400, 100), file('test/a.test.js', 280, 40), ...pad(12, 'src/f')])], points: 5 });
  const rec = E.toEffortRecord(r, 1700000000000, 'from 1 commit');
  const n = Core.normalizeEffort(rec);
  assert.ok(n.ok, n.error);
  assert.deepStrictEqual([n.effort.hours, n.effort.low, n.effort.high, n.effort.source, n.effort.method, n.effort.confidence, n.effort.note], [46.4, 32.5, 69.6, 'estimated', 'size-v1', 'high', 'from 1 commit']);
  assert.deepStrictEqual(n.effort.inputs, { commits: 1, prodLines: 450, testLines: 300, files: 14, points: 5 });
  assert.strictEqual(E.toEffortRecord({ ok: false, reason: 'x' }, 1, ''), null);
  assert.strictEqual(E.toEffortRecord(null, 1, ''), null);
});

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nEffort estimate checks passed.');
process.exit(failed ? 1 : 0);
