'use strict';
/**
 * Tests for scripts/verify-package.sh: a copy of the extension is made, one rule is broken in it, and the script must fail;
 * an unbroken copy must pass. This keeps the packaging check honest (a check that is never shown to fail proves little).
 * It needs bash and the dev dependencies (vsce). Without bash (a plain Windows shell) it says so and skips.
 * Run: node test/test-verify-package.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
if (bash.status !== 0) { console.log('SKIP the packaging check needs bash, which is not available here.'); console.log('\nPackaging check tests skipped.'); process.exit(0); }
if (!fs.existsSync(path.join(ROOT, 'node_modules', '.bin'))) { console.log('SKIP the dev dependencies are not installed (run npm ci).'); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-delivery-insights-verify-'));
let failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

function copy() {
  const dir = fs.mkdtempSync(path.join(tmp, 'ext-'));
  for (const f of fs.readdirSync(ROOT)) {
    if (f === 'node_modules' || f === 'test' || f.endsWith('.vsix')) { continue; }
    fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return dir;
}
const verify = (dir) => spawnSync('bash', ['scripts/verify-package.sh'], { cwd: dir, encoding: 'utf8' });
const append = (dir, file, text) => fs.appendFileSync(path.join(dir, file), '\n' + text + '\n');

check('an unchanged copy passes', () => {
  const r = verify(copy());
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Network APIs only in lib\/ado\.js/); assert.match(r.stdout, /child_process only in lib\/gitlog\.js/); assert.match(r.stdout, /No dynamic code evaluation/);
});

const bad = [
  ['a network call in another file', 'lib/text.js', "fetch('https://example.invalid/x');", /outside lib\/ado\.js/],
  ['a network call in the page script', 'media/dashboard.js', "new WebSocket('wss://example.invalid');", /outside lib\/ado\.js/],
  ['a node network module', 'lib/usage.js', "require('node:https');", /outside lib\/ado\.js/],
  ['XMLHttpRequest in the page', 'media/story-core.js', 'new XMLHttpRequest();', /outside lib\/ado\.js/],
  ['a lower-level network module inside ado.js', 'lib/ado.js', "require('https');", /global fetch only/],
  ['another host named in ado.js', 'lib/ado.js', "const other = 'https://example.invalid/api';", /other than dev\.azure\.com/],
  ['a process started outside gitlog.js', 'lib/text.js', "require('child_process').execSync('x');", /outside lib\/gitlog\.js/],
  ['a process started in ado.js', 'lib/ado.js', "require('child_process');", /outside lib\/gitlog\.js/],
  ['a shell in gitlog.js', 'lib/gitlog.js', "spawn('git', [], { shell: true });", /through a shell/],
  ['eval', 'media/dashboard.js', "eval('1');", /Dynamic code/],
  ['new Function', 'lib/usage.js', "new Function('return 1');", /Dynamic code/],
  ['importScripts', 'media/story-core.js', "importScripts('x.js');", /Dynamic code/],
];
for (const [name, file, code, message] of bad) {
  check('fails on ' + name, () => {
    const dir = copy(); append(dir, file, code);
    const r = verify(dir);
    assert.notStrictEqual(r.status, 0, 'the script accepted it:\n' + r.stdout);
    assert.match(r.stdout + r.stderr, message);
  });
}

check('a file with the same name as lib/ado.js somewhere else gets no exemption', () => {
  const dir = copy(); fs.mkdirSync(path.join(dir, 'lib', 'sub')); fs.writeFileSync(path.join(dir, 'lib', 'sub', 'ado.js'), "fetch('https://example.invalid');\n");
  assert.notStrictEqual(verify(dir).status, 0);
});

check('a file the check cannot read fails the check instead of being skipped', () => {
  if (process.platform === 'win32') { return; }   // creating links needs extra rights there
  const dir = copy(); fs.symlinkSync(path.join(dir, 'does-not-exist.js'), path.join(dir, 'lib', 'dangling.js'));
  const r = verify(dir);
  assert.notStrictEqual(r.status, 0, 'the script passed with an unreadable file in lib:\n' + r.stdout);
  assert.match(r.stdout + r.stderr, /cannot vouch/);
});

check('a file outside the packaging allow-list fails', () => {
  const dir = copy(); fs.mkdirSync(path.join(dir, 'secrets')); fs.writeFileSync(path.join(dir, 'secrets', 'notes.txt'), 'x');
  fs.writeFileSync(path.join(dir, '.vscodeignore'), '');   // nothing is excluded, so everything would ship
  const r = verify(dir);
  assert.notStrictEqual(r.status, 0); assert.match(r.stdout + r.stderr, /outside the packaging allow-list/);
});

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ' -> ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : e)); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nPackaging check tests passed.');
  process.exit(failed ? 1 : 0);
})();
