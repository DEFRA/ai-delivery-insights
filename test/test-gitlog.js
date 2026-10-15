'use strict';
/**
 * Tests for lib/gitlog.js against real temporary git repositories. Nothing outside the temporary folder is touched, and
 * git is told to ignore the machine's own configuration for the commits made here. Skipped (with a clear message) if git
 * is not installed. Run: node test/test-gitlog.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const G = require('../lib/gitlog.js');
const E = require('../lib/effort.js');

if (spawnSync('git', ['--version']).status !== 0) {
  console.log('SKIP git is not installed, so the git reader was not tested. Install git and run this again.');
  process.exit(0);
}

let failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-delivery-insights-git-'));
// an empty global git config: on Windows os.devNull is a device path that git refuses as a config file
const NO_CONFIG = path.join(tmp, 'empty.gitconfig'); fs.writeFileSync(NO_CONFIG, '');
let counter = 0;
const ME = 'me@example.com';
const THEM = 'them@example.com';
const T = (d, h, m) => `2026-10-${String(d).padStart(2, '0')}T${String(h || 10).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}:00Z`;

function sh(cwd, args, env) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: NO_CONFIG, GIT_CONFIG_NOSYSTEM: '1', ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
}
function newRepo(name) {
  const dir = path.join(tmp, `${name || 'repo'}-${++counter}`);
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, ['init', '-q', '.']);
  sh(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  sh(dir, ['config', 'user.name', 'Test']); sh(dir, ['config', 'user.email', ME]); sh(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag || 'line'} ${i}`).join('\n') + '\n';
function write(dir, file, content) { const p = path.join(dir, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
function commit(dir, message, when, who) {
  sh(dir, ['add', '-A']);
  const email = who || ME;
  return sh(dir, ['-c', `user.email=${email}`, 'commit', '-q', '--allow-empty', '-m', message], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }).trim() || sh(dir, ['rev-parse', 'HEAD']).trim();
}
const head = (dir) => sh(dir, ['rev-parse', 'HEAD']).trim();
const ids = { adoId: 1234, localId: 'US-12' };
const run = (dir, extra) => G.collect({ repos: [{ path: dir, label: path.basename(dir) }], ids, ...(extra || {}) });
const byMsg = (res, re) => res.commits.find((c) => re.test(c.subject));

/** A repository with every kind of commit the finder must treat differently. */
function buildMain() {
  const d = newRepo('main');
  write(d, 'README.md', 'hello\n'); commit(d, 'initial commit', T(1));
  write(d, 'src/login.js', lines(100)); write(d, 'test/login.test.js', lines(60)); write(d, 'package-lock.json', lines(5000)); commit(d, 'AB#1234 add login', T(2));
  write(d, 'src/other.js', lines(10)); commit(d, 'unrelated change', T(3));
  write(d, 'src/login.js', lines(100).replace(/line 1\n/, 'changed\n') + lines(5, 'new')); commit(d, 'fix #1234 edge case\n\nlonger body', T(4));
  sh(d, ['mv', 'src/login.js', 'src/auth.js']); write(d, 'src/auth.js', fs.readFileSync(path.join(d, 'src/auth.js'), 'utf8') + 'two\nlines\n'); commit(d, 'US-12 rename login to auth', T(5));
  fs.writeFileSync(path.join(d, 'logo.png'), Buffer.from([0, 1, 2, 0, 3, 0, 255, 0])); commit(d, 'AB#1234 add logo', T(6));
  write(d, 'src/colleague.js', lines(9)); commit(d, 'AB#1234 colleague work', T(7), THEM);
  write(d, 'src/mention.js', lines(4)); commit(d, 'refs AB#12345 and #12 only', T(8));          // different numbers: must not match
  write(d, 'src/time.js', lines(7)); commit(d, 'no number here, made during a session', T(9, 11, 30));
  write(d, 'src/time2.js', lines(3)); commit(d, 'someone else, same hour', T(9, 11, 40), THEM);
  sh(d, ['checkout', '-q', '-b', 'feature/1234-login-wip']);
  write(d, 'src/wip.js', lines(20)); commit(d, 'wip', T(10));
  sh(d, ['checkout', '-q', 'main']);
  sh(d, ['checkout', '-q', '-b', 'side']); write(d, 'side.js', lines(2)); commit(d, 'side work', T(11));
  sh(d, ['checkout', '-q', 'main']);
  sh(d, ['merge', '--no-ff', '-q', '-m', 'Merge AB#1234 side', 'side'], { GIT_AUTHOR_DATE: T(12), GIT_COMMITTER_DATE: T(12) });
  return d;
}

check('finds commits by story number in the message, by a branch named for the story, and by your time window; and not the others', async () => {
  const d = buildMain();
  const window = { from: Date.parse(T(9, 11, 0)), to: Date.parse(T(9, 12, 30)) };
  const res = await run(d, { windows: [window] });
  assert.deepStrictEqual(res.repos.map((r) => [r.ok, r.error]), [[true, '']]);
  const got = Object.fromEntries(res.commits.map((c) => [c.subject.split('\n')[0], c.match]));
  assert.deepStrictEqual(got, {
    'AB#1234 add login': 'id', 'fix #1234 edge case': 'id', 'US-12 rename login to auth': 'id', 'AB#1234 add logo': 'id', 'AB#1234 colleague work': 'id',
    'wip': 'branch', 'no number here, made during a session': 'time',
  }, 'AB#12345, #12, the unrelated commit, the other person\'s commit in your window, "side work" and the merge commit are all left out');
  assert.deepStrictEqual(res.commits.map((c) => c.date), res.commits.map((c) => c.date).slice().sort().reverse(), 'newest first');
  assert.ok(res.commits.every((c) => /^[0-9a-f]{40}$/.test(c.hash) && c.key === `0:${c.hash}` && c.short === c.hash.slice(0, 8)));
});

check('the line counts are exactly what git reports, including renames and binaries', async () => {
  const d = buildMain();
  const res = await run(d, {});
  const add = byMsg(res, /add login$/);
  assert.deepStrictEqual(add.files.map((f) => [f.path, f.added, f.deleted]).sort(), [['package-lock.json', 5000, 0], ['src/login.js', 100, 0], ['test/login.test.js', 60, 0]]);
  assert.strictEqual(add.added, 5160);
  const fix = byMsg(res, /edge case/);
  assert.deepStrictEqual(fix.files.map((f) => [f.path, f.added, f.deleted]), [['src/login.js', 6, 1]], 'one line changed and five added');
  const rename = byMsg(res, /rename login to auth/);
  assert.deepStrictEqual(rename.files.map((f) => [f.path, f.added, f.deleted]), [['src/auth.js', 2, 0]], 'a rename is the new name with only the real changes, not 106 lines deleted and added');
  const logo = byMsg(res, /add logo/);
  assert.deepStrictEqual(logo.files.map((f) => [f.path, f.binary, f.added, f.deleted]), [['logo.png', true, 0, 0]]);
});

check('the found commits feed the estimate: lock files and the binary logo are ignored', async () => {
  const d = buildMain();
  const res = await run(d, {});
  const r = E.estimate({ commits: res.commits.filter((c) => c.match === 'id') });
  // production: login 100 + fix (6 + 0.5) + auth 2 + colleague 9 = 117.5 ; tests 60 ; files: login.js, auth.js, colleague.js = 3 prod, 1 test
  assert.strictEqual(r.inputs.prodLines, 117.5);
  assert.strictEqual(r.inputs.testLines, 60);
  assert.strictEqual(r.inputs.files, 4);
  assert.strictEqual(r.inputs.commits, 5);
  assert.strictEqual(r.counts.ignoredFiles, 2, 'package-lock.json and logo.png');
  assert.strictEqual(r.confidence, 'high');
});

check('time matches need a window and your own e-mail; with neither there are none', async () => {
  const d = buildMain();
  const w = { from: Date.parse(T(9, 11, 0)), to: Date.parse(T(9, 12, 0)) };
  assert.ok(!(await run(d, {})).commits.some((c) => c.match === 'time'), 'no window');
  assert.ok(!(await run(d, { windows: [{ from: Date.parse(T(9, 13)), to: Date.parse(T(9, 14)) }] })).commits.some((c) => c.match === 'time'), 'window at another time');
  assert.ok((await run(d, { windows: [w] })).commits.some((c) => c.match === 'time'));
  for (const bad of [{ from: NaN, to: 1 }, { from: 5, to: 1 }, null, 'x', { from: '1', to: '2' }]) { assert.ok(!(await run(d, { windows: [bad] })).commits.some((c) => c.match === 'time')); }
  // a commit that matches by number AND is inside the window is reported as the stronger match
  const both = await run(d, { windows: [{ from: Date.parse(T(2, 0)), to: Date.parse(T(3, 0)) }] });
  assert.strictEqual(byMsg(both, /add login$/).match, 'id');
  assert.strictEqual(both.commits.filter((c) => /add login$/.test(c.subject)).length, 1, 'never listed twice');
  // someone whose git e-mail is different sees none of "my" time commits
  sh(d, ['config', 'user.email', 'other@example.com']);
  assert.ok(!(await run(d, { windows: [w] })).commits.some((c) => c.match === 'time'));
});

check('a story with no number in the ID only matches on the number; a numeric ID is not matched twice', async () => {
  const d = buildMain();
  assert.strictEqual((await G.collect({ repos: [{ path: d }], ids: { adoId: null, localId: 'US-12' } })).commits.length, 1, 'only the "US-12" commit');
  assert.strictEqual((await G.collect({ repos: [{ path: d }], ids: { adoId: 1234, localId: '1234' } })).commits.filter((c) => c.match === 'id').length, 4, 'four mention the number; the fifth only says US-12');
  assert.strictEqual((await G.collect({ repos: [{ path: d }], ids: { adoId: null, localId: '' } })).commits.length, 0);
  assert.strictEqual((await G.collect({ repos: [{ path: d }], ids: null })).commits.length, 0);
  const lower = await G.collect({ repos: [{ path: d }], ids: { adoId: null, localId: 'us-12' } });
  assert.strictEqual(lower.commits.length, 1, 'case does not matter');
});

check('message patterns: whole numbers only, never part of a longer number or word', () => {
  const [re] = G.idMatchers({ adoId: 1234 });
  for (const yes of ['AB#1234', 'fix AB#1234.', '(#1234)', '#1234: done', 'ab#1234', 'x\n#1234']) { assert.ok(re.test(yes), yes); }
  for (const no of ['AB#12345', '#12340', 'AB#123', 'ID1234', 'xx#1234a'.replace('#1234a', '#12349'), '1234']) { assert.ok(!re.test(no), no); }
  const [, local] = G.idMatchers({ adoId: 1234, localId: 'US-12' });
  assert.ok(local.test('US-12 done') && local.test('(us-12)') && !local.test('US-123') && !local.test('BUS-12') && !local.test('US-12a'));
  assert.strictEqual(G.idMatchers({ adoId: 0, localId: '--output=x' }).length, 0, 'an ID that is not a story ID is never turned into a pattern');
  assert.strictEqual(G.idMatchers({ adoId: 5, localId: 'a.b+c' }).length, 1, 'only the number pattern, since "+" is not allowed in a story ID');
  const [dots] = G.idMatchers({ adoId: null, localId: 'A.B' });
  assert.ok(dots.test('A.B done') && !dots.test('AxB done'), 'a dot in an ID is a dot, not "any character"');
  const [branch] = G.branchMatchers({ adoId: 1234 });
  for (const yes of ['feature/1234-login', 'bugfix/1234', 'u/me/AB-1234-x', '1234']) { assert.ok(branch.test(yes), yes); }
  for (const no of ['feature/12345', 'v1234x'.replace('x', '9'), 'release-2.1234.5'.replace('1234', '12345')]) { assert.ok(!branch.test(no), no); }
});

check('the numstat parser: normal lines, binaries, renames, odd names, and junk', () => {
  const out = ['3\t1\tsrc/a.js', '-\t-\timg/a.png', '2\t0\t', 'old name.js', 'new name.js', '0\t0\tdir with spaces/\u00e9.js', 'garbage', '', '7\t7\ttab\tname.js'].join('\0') + '\0';
  assert.deepStrictEqual(G.parseNumstat(out), [
    { path: 'src/a.js', added: 3, deleted: 1, binary: false },
    { path: 'img/a.png', added: 0, deleted: 0, binary: true },
    { path: 'new name.js', added: 2, deleted: 0, binary: false },
    { path: 'dir with spaces/\u00e9.js', added: 0, deleted: 0, binary: false },
    { path: 'tab\tname.js', added: 7, deleted: 7, binary: false },
  ]);
  assert.deepStrictEqual(G.parseNumstat(''), []);
  assert.deepStrictEqual(G.parseNumstat(null), []);
  assert.deepStrictEqual(G.parseNumstat('1\t1\ta.js\0').map((f) => f.path), ['a.js']);
  assert.strictEqual(G.parseNumstat(Array.from({ length: G.LIMITS.files + 50 }, (_, i) => `1\t0\tf${i}.js`).join('\0')).length, G.LIMITS.files);
});

check('the log parser ignores damaged records', () => {
  const h = 'a'.repeat(40);
  const good = `${h}\x1f2026-10-02T10:00:00+00:00\x1fMe@Example.com\x1fAB#1 subject\x1fbody\x1fwith separator\x1e`;
  const out = `${good}\nnothash\x1f2026-10-02T10:00:00Z\x1fx\x1fy\x1fz\x1e${h}\x1fnot a date\x1fx\x1fy\x1fz\x1e${h}\x1fonly\x1etwo\x1e`;
  const [c, ...rest] = G.parseLog(out);
  assert.strictEqual(rest.length, 0);
  assert.deepStrictEqual([c.hash, c.email, c.subject, c.body, c.ts], [h, 'me@example.com', 'AB#1 subject', 'body\x1fwith separator', Date.parse('2026-10-02T10:00:00Z')]);
});

check('a repository whose own settings try to start programs: nothing is run, and the answer is still right', async () => {
  const d = buildMain();
  const marker = path.join(tmp, 'PWNED');
  const script = path.join(tmp, process.platform === 'win32' ? 'evil.cmd' : 'evil.sh');
  fs.writeFileSync(script, process.platform === 'win32' ? `@echo off\r\necho x> "${marker}"\r\n` : `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  const evil = script.replace(/\\/g, '/');
  for (const kv of [['core.fsmonitor', evil], ['core.pager', evil], ['diff.external', evil], ['diff.evil.textconv', evil], ['diff.evil.command', evil], ['core.editor', evil], ['alias.log', `!${evil}`], ['alias.show', `!${evil}`], ['core.sshCommand', evil], ['core.hooksPath', path.dirname(script).replace(/\\/g, '/')]]) {
    sh(d, ['config', kv[0], kv[1]]);
  }
  write(d, '.gitattributes', '*.js diff=evil\n');
  const res = await run(d, {});
  assert.ok(!fs.existsSync(marker), 'no program from the repository\'s configuration was started');
  assert.strictEqual(res.commits.filter((c) => c.match === 'id').length, 5);
  assert.deepStrictEqual(byMsg(res, /edge case/).files.map((f) => [f.path, f.added, f.deleted]), [['src/login.js', 6, 1]]);
});

check('every git command is a read-only one, and each carries the safety settings that stop a repository starting programs', async () => {
  if (process.platform === 'win32') { return; } // the recording wrapper below is a shell-script style launcher
  const d = buildMain();
  const logFile = path.join(tmp, 'argv.log');
  const wrapper = path.join(tmp, 'git-wrapper.js');
  fs.writeFileSync(wrapper, `#!/usr/bin/env node\nconst fs = require('fs');\nfs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nconst r = require('child_process').spawnSync('git', process.argv.slice(2), { stdio: 'inherit' });\nprocess.exit(r.status === null ? 1 : r.status);\n`, { mode: 0o755 });
  const res = await run(d, { command: wrapper });
  assert.strictEqual(res.commits.filter((c) => c.match === 'id').length, 5, 'the wrapper changed nothing about the answer');
  const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(calls.length > 5, 'git was really asked several things');
  for (const argv of calls) {
    assert.strictEqual(argv[0], '--no-pager');
    assert.deepStrictEqual(argv.slice(1, 1 + G.SAFE_CONFIG.length), G.SAFE_CONFIG, 'the safety settings come first: ' + argv.join(' ').slice(0, 80));
    const sub = argv[1 + G.SAFE_CONFIG.length];
    assert.ok(['log', 'show', 'for-each-ref', 'rev-parse', 'config'].includes(sub), 'only reading commands: ' + sub);
    if (sub === 'config') { assert.strictEqual(argv[2 + G.SAFE_CONFIG.length], '--get'); }
    if (sub === 'show') { assert.ok(argv.includes('--no-ext-diff') && argv.includes('--no-textconv')); }
  }
  for (const must of ['core.fsmonitor=false', 'diff.external=', 'protocol.allow=never', 'core.sshCommand=false', 'core.gitProxy=', 'credential.helper=', 'core.askPass=']) { assert.ok(G.SAFE_CONFIG.includes(must), 'the settings that matter are in the list: ' + must); }
});

check('git is told nothing from the surrounding environment: GIT_DIR and friends cannot redirect it', async () => {
  const d = buildMain();
  const other = newRepo('decoy');
  write(other, 'x.js', 'x\n'); commit(other, 'AB#1234 decoy', T(2));
  const saved = { ...process.env };
  process.env.GIT_DIR = path.join(other, '.git'); process.env.GIT_WORK_TREE = other; process.env.GIT_INDEX_FILE = path.join(other, 'nope'); process.env.GIT_CONFIG_COUNT = '1'; process.env.GIT_CONFIG_KEY_0 = 'core.fsmonitor'; process.env.GIT_CONFIG_VALUE_0 = 'true';
  try {
    const res = await run(d, {});
    assert.ok(!res.commits.some((c) => /decoy/.test(c.subject)), 'the decoy repository was not read');
    assert.strictEqual(res.commits.filter((c) => c.match === 'id').length, 5);
  } finally {
    for (const k of Object.keys(process.env)) { if (!(k in saved)) { delete process.env[k]; } }
  }
  const env = G.gitEnv({ PATH: '/bin', GIT_DIR: '/x', git_work_tree: '/y', HOME: '/h', Other: 'z' });
  assert.ok(!('GIT_DIR' in env) && !('git_work_tree' in env), 'the caller\'s GIT_ variables are gone');
  assert.deepStrictEqual([env.HOME, env.PATH, env.Other], ['/h', '/bin', 'z'], 'everything else is kept');
  assert.deepStrictEqual([env.GIT_ALLOW_PROTOCOL, env.GIT_NO_LAZY_FETCH, env.GIT_SSH_COMMAND, env.GIT_ASKPASS, env.GIT_TERMINAL_PROMPT], ['none', '1', 'false', 'false', '0'], 'no transport can run, nothing is fetched, nothing asks questions');
});

check('a partial clone cannot make git fetch: the repository\'s ssh command is never started, and the commit that needed the fetch is reported', async () => {
  if (process.platform === 'win32') { return; } // the marker script is a shell script
  const origin = newRepo('origin');
  write(origin, 'src/a.js', lines(20)); commit(origin, 'AB#1234 in a partial clone', T(2));
  sh(origin, ['config', 'uploadpack.allowFilter', 'true']); sh(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  const victim = path.join(tmp, 'partial-victim');
  try { sh(tmp, ['clone', '-q', '--no-local', '--filter=blob:none', '--no-checkout', 'file://' + origin, victim]); } catch { console.log('SKIP this git cannot make a partial clone, so the lazy-fetch case was not tested.'); return; }
  const marker = path.join(tmp, 'LAZY-RAN');
  const script = path.join(tmp, 'lazy.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
  sh(victim, ['config', 'remote.origin.url', 'ssh://git@host.invalid/repo.git']); sh(victim, ['config', 'core.sshCommand', script]);
  // the attack must work against plain git here, or this test proves nothing
  try { sh(victim, ['show', '--numstat', '--format=', 'HEAD']); } catch { /* the fetch fails; the program was still started */ }
  if (!fs.existsSync(marker)) { console.log('SKIP this git did not try to fetch the missing file, so the lazy-fetch case was not tested.'); return; }
  fs.unlinkSync(marker);
  const res = await run(victim, {});
  assert.ok(!fs.existsSync(marker), 'the ssh command named by the repository was not started');
  assert.strictEqual(res.commits.length, 0, 'the commit that needs a fetch is left out, not guessed');
  assert.ok(res.notes.some((n) => /could not be read/.test(n) && /never fetches/.test(n)), 'and the person is told why');
});

check('git is found by an absolute path on PATH, never in the repository folder', async () => {
  const bin = path.join(tmp, 'bin-real'); fs.mkdirSync(bin, { recursive: true });
  const fake = path.join(bin, 'git'); fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (process.platform !== 'win32') { assert.strictEqual(G.findGit({ PATH: `:.:relative/dir:${bin}` }, 'linux'), fake, 'empty and relative entries are skipped'); }
  assert.strictEqual(G.findGit({ PATH: ':.:relative/dir' }, 'linux'), null, 'with only those, git is not found');
  assert.strictEqual(G.findGit({ PATH: path.join(tmp, 'no-such-dir') }, 'linux'), null);
  if (process.platform !== 'win32') {
    // a program called git in the current directory, with "." and a relative folder on PATH: it must be ignored
    const here = path.join(tmp, 'cwd-with-git'); fs.mkdirSync(path.join(here, 'rel'), { recursive: true });
    fs.writeFileSync(path.join(here, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); fs.writeFileSync(path.join(here, 'rel', 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const was = process.cwd();
    try {
      process.chdir(here);
      assert.strictEqual(G.findGit({ PATH: '.:rel' }, 'linux'), null, 'a git in the current directory is not used');
      assert.strictEqual(G.findGit({ PATH: `.:rel:${bin}` }, 'linux'), fake, 'the real one further along PATH is');
    } finally { process.chdir(was); }
  }
  assert.strictEqual(G.findGit({ Path: '.;rel;\\\\server\\share' , PATH: undefined }, 'win32'), null, 'Windows: relative entries are skipped too');
  if (process.platform === 'win32') { return; }
  // a program called git in the repository itself, with the current directory on PATH, must not be started
  const d = buildMain();
  const marker = path.join(tmp, 'PLANTED-RAN');
  fs.writeFileSync(path.join(d, 'git'), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
  const res = await G.collect({ repos: [{ path: d, label: 'main' }], ids, env: { ...process.env, PATH: `:.:${process.env.PATH}` } });
  assert.ok(!fs.existsSync(marker), 'the planted git was not started');
  assert.strictEqual(res.commits.filter((c) => c.match === 'id').length, 5, 'the real git did the work');
  const none = await G.collect({ repos: [{ path: d, label: 'main' }], ids, env: { PATH: ':.' } });
  assert.match(none.repos[0].error, /Git was not found/, 'with no real git on PATH it says so instead of using the planted one');
  assert.ok(!fs.existsSync(marker));
});

check('a very large result is capped: the oldest commits are left out and the paths are clipped, with a note', async () => {
  const d = buildMain();
  const saved = G.LIMITS.totalFiles;
  try {
    G.LIMITS.totalFiles = 3;
    const res = await run(d, {});
    const whole = await (async () => { G.LIMITS.totalFiles = saved; return run(d, {}); })();
    assert.ok(res.commits.length < whole.commits.length, 'fewer commits were kept');
    assert.ok(res.notes.some((n) => /left out because the commits found touch more than 3 files/.test(n)), 'and the person is told');
    assert.ok(res.commits.reduce((n, c) => n + c.files.length, 0) <= 3);
  } finally { G.LIMITS.totalFiles = saved; }
  const long = G.parseNumstat(`1\t0\t${'d/'.repeat(600)}file.js\0`);
  assert.strictEqual(long[0].path.length, G.LIMITS.pathChars);
  assert.ok(long[0].path.endsWith('file.js'), 'the end of the path, where the file type is, is kept');
});

check('branch and subject text are only ever arguments, never shell commands', async () => {
  const d = newRepo('shell');
  const marker = path.join(tmp, 'PWNED2');
  write(d, 'a.js', 'a\n'); commit(d, 'start', T(1));
  const branch = `feature/1234-$(touch ${marker.replace(/\\/g, '/')})`;
  try { sh(d, ['checkout', '-q', '-b', branch]); } catch { sh(d, ['checkout', '-q', '-b', 'feature/1234-weird;touch-x']); }
  write(d, 'b.js', lines(3)); commit(d, 'x`touch ' + marker.replace(/\\/g, '/') + '` $(touch ' + marker.replace(/\\/g, '/') + ') AB#1234', T(2));
  const res = await run(d, {});
  assert.ok(!fs.existsSync(marker));
  assert.ok(res.commits.length >= 1);
  assert.ok(!/[\u0000-\u001f]/.test(res.commits[0].subject));
});

check('bad paths, non-repositories, a missing git, and an empty repository give messages, not crashes', async () => {
  const empty = newRepo('empty');
  const notRepo = path.join(tmp, 'plain'); fs.mkdirSync(notRepo);
  const aFile = path.join(tmp, 'afile.txt'); fs.writeFileSync(aFile, 'x');
  const res = await G.collect({ repos: [{ path: 'relative/path' }, { path: path.join(tmp, 'nope') }, { path: notRepo }, { path: aFile }, { path: empty, label: 'empty' }, null, { path: 5 }], ids });
  assert.deepStrictEqual(res.repos.map((r) => r.error), ['The repository folder is not a full path.', 'The repository folder no longer exists.', 'This folder is not a git repository.', 'This folder is not a git repository.', '', 'The repository folder is not a full path.', 'The repository folder is not a full path.']);
  assert.ok(res.repos[4].ok, 'an empty repository is fine: just no commits');
  assert.strictEqual(res.commits.length, 0);
  assert.ok(res.notes.some((n) => /not a git repository/.test(n)));
  const d = buildMain();
  const missing = await G.collect({ repos: [{ path: d }], ids, command: 'definitely-not-git-xyz' });
  assert.match(missing.repos[0].error, /Git was not found/);
  assert.strictEqual(missing.commits.length, 0);
  const same = await G.collect({ repos: [{ path: d }, { path: d + path.sep }], ids });
  assert.strictEqual(same.repos[1].error, 'Listed twice.');
  assert.strictEqual(same.commits.length, 6, 'five by number or story ID, one by branch');
  assert.strictEqual((await G.collect({})).commits.length, 0);
});

check('two repositories: each commit belongs to its own, and the key says which', async () => {
  const a = buildMain(), b = newRepo('second');
  write(b, 'x.js', lines(11)); commit(b, 'AB#1234 other repo', T(13));
  const res = await G.collect({ repos: [{ path: a, label: 'one' }, { path: b, label: 'two' }], ids });
  const other = res.commits.find((c) => /other repo/.test(c.subject));
  assert.strictEqual(other.repo, 1);
  assert.strictEqual(other.key, `1:${other.hash}`);
  assert.strictEqual(res.commits.filter((c) => c.repo === 0).length, 6);
  assert.deepStrictEqual(res.repos.map((r) => r.label), ['one', 'two']);
});

check('too many commits: the newest are kept and the person is told', async () => {
  const d = newRepo('many');
  for (let i = 1; i <= 8; i++) { write(d, `f${i}.js`, lines(i)); commit(d, `AB#1234 step ${i}`, T(i)); }
  const res = await run(d, { maxCommits: 5 });
  assert.strictEqual(res.commits.length, 5);
  assert.deepStrictEqual(res.commits.map((c) => c.subject), ['AB#1234 step 8', 'AB#1234 step 7', 'AB#1234 step 6', 'AB#1234 step 5', 'AB#1234 step 4']);
  assert.ok(res.notes.some((n) => /3 older commits were left out; only the newest 5/.test(n)), JSON.stringify(res.notes));
});

check('a branch named for the story is not used when there is no main branch to compare with, and says so', async () => {
  const d = newRepo('nomain');
  sh(d, ['checkout', '-q', '-b', 'trunk']);
  write(d, 'a.js', 'a\n'); commit(d, 'start', T(1));
  sh(d, ['checkout', '-q', '-b', 'feature/1234-x']); write(d, 'b.js', lines(3)); commit(d, 'work', T(2));
  const res = await run(d, {});
  assert.strictEqual(res.commits.length, 0);
  assert.ok(res.notes.some((n) => /no main branch/.test(n)), JSON.stringify(res.notes));
});

(async () => {
  try {
    for (const [name, fn] of checks) {
      try { const r = await fn(); console.log('PASS ' + name + (r === undefined ? '' : ' -> ' + r)); } catch (e) { failed++; console.log('FAIL ' + name + ' -> ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : e)); }
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nGit reader checks passed.');
  process.exit(failed ? 1 : 0);
})();
