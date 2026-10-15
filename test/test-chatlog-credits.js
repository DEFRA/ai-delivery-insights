'use strict';
/**
 * Billed cost taken from the chat log itself (copilotCredits), and a session whose opening snapshot was trimmed away.
 * Run: node test/test-chatlog-credits.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan } = require('../lib/scanner.js');

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ' -> ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e)); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-chatlog-'));
const userDir = path.join(tmp, 'Code', 'User');
const chatDir = path.join(userDir, 'workspaceStorage', 'abc123', 'chatSessions');
fs.mkdirSync(chatDir, { recursive: true });
fs.writeFileSync(path.join(userDir, 'workspaceStorage', 'abc123', 'workspace.json'), JSON.stringify({ folder: 'file:///tmp/proj' }));

const T = Date.UTC(2026, 9, 5, 10, 0, 0);
const req = (id, extra) => ({ requestId: id, timestamp: T, modelId: 'copilot/claude-sonnet-5', message: { text: 'hello', parts: [{ text: 'hello' }] }, agent: { id: 'github.copilot.editsAgent' }, response: [], promptTokens: 100000, completionTokens: 5000, ...extra });
const write = (id, lines) => fs.writeFileSync(path.join(chatDir, id + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

// full snapshot; one request has Copilot's own cost, one does not
write('with-snapshot', [{ kind: 0, v: { version: 3, sessionId: 'with-snapshot', creationDate: T, requests: [req('r1', { copilotCredits: 123.5 }), req('r2')] } }]);
// the opening snapshot was trimmed away: only pushes and sets remain
write('trimmed', [
  { kind: 2, k: ['requests'], v: [req('r3')] },
  { kind: 1, k: ['requests', 0, 'copilotCredits'], v: 40.25 },
]);

(async () => {
  const data = await scan({ userDirs: [userDir], pricing: {} });
  const prompts = data.sessions.flatMap((s) => s.prompts);

  await check('copilotCredits is used as the billed cost, whatever the model or reasoning effort', () => {
    const s = data.sessions.find((x) => x.id === 'with-snapshot');
    const p = s.prompts.find((x) => x.credits === 123.5);
    assert.ok(p, 'the recorded cost is used exactly');
    assert.strictEqual(p.quality, 'exact');
  });
  await check('a request with no recorded cost still falls back to token pricing', () => {
    const s = data.sessions.find((x) => x.id === 'with-snapshot');
    const p = s.prompts.find((x) => x.credits !== 123.5);
    assert.strictEqual(p.quality, 'tokens');
    assert.ok(p.credits > 0);
  });
  await check('a session whose opening snapshot was trimmed away is still read', () => {
    const s = data.sessions.find((x) => x.id === 'trimmed');
    assert.ok(s, 'session kept');
    assert.strictEqual(s.prompts.length, 1);
    assert.strictEqual(s.prompts[0].credits, 40.25);
  });
  await check('no prompt has negative or NaN credits', () => { assert.ok(prompts.every((p) => Number.isFinite(p.credits) && p.credits >= 0)); });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nChat log credit checks passed.');
  process.exit(failed ? 1 : 0);
})();
