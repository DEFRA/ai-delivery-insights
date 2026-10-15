'use strict';
/**
 * Tests for the defences that stop untrusted input from doing harm: the chat-log replay, price overrides, and the settings that
 * decide where data goes. Each one answers a finding of the independent security review (docs/ai-delivery-insights/ado-integration.md).
 * Run: node test/test-hardening.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { replayMutationLog } = require('../lib/jsonl.js');
const Pricing = require('../lib/pricing.js');

let failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

async function* lines(list) { for (const l of list) { yield typeof l === 'string' ? l : JSON.stringify(l); } }
const replay = (list) => replayMutationLog(lines(list));
const protoClean = () => {
  assert.strictEqual({}.polluted, undefined);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
  assert.strictEqual(typeof Object.prototype.toString, 'function', 'a built-in on Object.prototype was not deleted');
  assert.strictEqual(typeof Object.prototype.hasOwnProperty, 'function');
  assert.strictEqual(typeof Array.prototype.push, 'function');
  assert.strictEqual(typeof ({}).constructor, 'function');
};

check('chat log replay: normal sets, pushes, splices and deletes still work', async () => {
  const s = await replay([
    { kind: 0, v: { requests: [{ id: 1 }], title: 'a' } },
    { kind: 1, k: ['title'], v: 'b' },
    { kind: 2, k: ['requests'], v: [{ id: 2 }, { id: 3 }] },
    { kind: 2, k: ['requests'], i: 1, v: [{ id: 9 }] },
    { kind: 1, k: ['requests', 0, 'done'], v: true },
    { kind: 3, k: ['title'] },
    { kind: 1, k: ['deep', 'er', 'path'], v: 5 },
    'not json at all', '[1,2]', 'null',
  ]);
  assert.deepStrictEqual(s, { requests: [{ id: 1, done: true }, { id: 9 }], deep: { er: { path: 5 } } });
});

check('chat log replay: a log cannot write to or delete from the prototype of every object', async () => {
  const attacks = [
    { kind: 1, k: ['__proto__', 'polluted'], v: 'yes' },
    { kind: 1, k: ['constructor', 'prototype', 'polluted'], v: 'yes' },
    { kind: 1, k: ['a', '__proto__', 'polluted'], v: 'yes' },
    { kind: 2, k: ['__proto__', 'list'], v: ['x'] },
    { kind: 2, k: ['constructor', 'prototype', 'list'], v: ['x'] },
    { kind: 3, k: ['__proto__', 'toString'] },
    { kind: 3, k: ['constructor', 'prototype', 'hasOwnProperty'] },
    { kind: 3, k: ['a', 'constructor', 'prototype', 'toString'] },
    { kind: 1, k: ['prototype', 'polluted'], v: 'yes' },
    '{"kind":1,"k":["__proto__","polluted"],"v":"yes"}',
    '{"kind":1,"k":[["__proto__"],"polluted"],"v":1}',
  ];
  const s = await replay([{ kind: 0, v: { a: {}, requests: [] } }, ...attacks, { kind: 1, k: ['ok'], v: 1 }]);
  protoClean();
  assert.strictEqual(s.ok, 1, 'the log carries on after an ignored line');
  assert.strictEqual({}.list, undefined);
  // the same attacks as the very first lines of a log
  await replay(attacks);
  protoClean();
});

check('chat log replay: a path of the wrong shape is ignored, and a missing path keeps its old meaning', async () => {
  const s = await replay([
    { kind: 0, v: { a: 1 } },
    { kind: 1, k: 'a', v: 2 },
    { kind: 1, k: [{}], v: 2 },
    { kind: 1, k: [null], v: 2 },
    { kind: 1, k: [Infinity], v: 2 },
    { kind: 3, k: 'a' },
    { kind: 3, k: [] },
  ]);
  assert.deepStrictEqual(s, { a: 1 });
  assert.deepStrictEqual(await replay([{ kind: 0, v: { a: 1 } }, { kind: 1, v: { replaced: true } }]), { replaced: true }, 'a set with no path replaces the whole state');
  assert.deepStrictEqual(await replay([{ kind: 0, v: { a: 1 } }, { kind: 1, k: [], v: { replaced: true } }]), { replaced: true });
  assert.deepStrictEqual(await replay([{ kind: 0, v: [1] }, { kind: 2, v: [2, 3] }]), [1, 2, 3], 'a push with no path adds to the state itself');
});

check('price overrides: junk in the setting cannot break pricing or make a negative or endless price', () => {
  const base = Pricing.rateFor('claude-sonnet-4.5', undefined);
  for (const bad of [null, 5, 'x', [], [1], { 'claude-sonnet': null }, { 'claude-sonnet': 7 }, { 'claude-sonnet': 'x' }, { 'claude-sonnet': [] }, JSON.parse('{"__proto__":{"input":1}}')]) {
    assert.deepStrictEqual(Pricing.rateFor('claude-sonnet-4.5', bad), base, JSON.stringify(bad));
  }
  assert.strictEqual({}.input, undefined);
  const r = Pricing.rateFor('claude-sonnet-4.5', { 'claude-sonnet': { input: -5, cachedInput: Infinity, output: 1e99 } });
  assert.deepStrictEqual([r.input, r.cachedInput, r.output], [0, 0, 0], 'negative, infinite and absurd rates count as 0');
  const ok = Pricing.rateFor('claude-sonnet-4.5', { 'claude-sonnet': { input: 2, output: 10 } });
  assert.deepStrictEqual([ok.input, ok.cachedInput, ok.output], [2, 0.2, 10], 'a sensible override still works; cached input defaults to a tenth');
  assert.ok(Pricing.creditsFromTokens('claude-sonnet-4.5', 1e6, 0, 0, { 'claude-sonnet': { input: 2, output: 10 } }) === 200);
});

check('the settings that choose where data goes or how numbers are worked out can only be set by the user, never by a workspace', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const props = pkg.contributes.configuration.properties || pkg.contributes.configuration.reduce((a, c) => ({ ...a, ...c.properties }), {});
  const mustBeUser = Object.keys(props).filter((k) => /^aiDeliveryInsights\.(ado\.|extraDataDirs$|pricing$|effort\.)/.test(k));
  assert.ok(mustBeUser.length >= 12, 'found them: ' + mustBeUser.join(', '));
  for (const k of mustBeUser) { assert.strictEqual(props[k].scope, 'application', k + ' must be scope "application"'); }
  assert.strictEqual(pkg.capabilities.untrustedWorkspaces.supported, 'limited');
});

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ' -> ' + (e && e.stack ? e.stack.split('\n').slice(0, 8).join(' | ') : e)); }
  }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nHardening checks passed.');
  process.exit(failed ? 1 : 0);
})();
