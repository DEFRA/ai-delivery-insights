'use strict';
// Builds a synthetic VS Code "User" directory so the scanner and dashboard can be tested without real data.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.argv[2] || '/tmp/lens-fixture';
const USER = path.join(ROOT, 'Code', 'User');
const REPOS = path.join(ROOT, 'repos');
fs.rmSync(ROOT, { recursive: true, force: true });

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const uuid = () => crypto.randomUUID();
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function mkRepo(dir, remote, branch) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
}

const shop = path.join(REPOS, 'shop-api');
const web = path.join(REPOS, 'storefront-web');
const infra = path.join(REPOS, 'platform-infra');
const mono = path.join(REPOS, 'mono-workspace');
mkRepo(shop, 'https://ghp_secrettoken@github.com/acme/shop-api.git', 'feature/checkout-v2');
mkRepo(web, 'git@github.com:acme/storefront-web.git', 'main');
mkRepo(infra, 'https://github.com/acme/platform-infra.git', 'fix/aks-ingress');
mkRepo(path.join(mono, 'svc-orders'), 'https://github.com/acme/svc-orders.git', 'main');
mkRepo(path.join(mono, 'svc-billing'), 'https://github.com/acme/svc-billing.git', 'develop');
const multi = path.join(REPOS, 'fullstack.code-workspace');
fs.writeFileSync(multi, `{\n // comment\n "folders": [{"path":"shop-api"},{"path":"storefront-web"},],\n}`);

const WORKSPACES = [
  { uri: 'file://' + shop, w: 5, kind: 'folder' },
  { uri: 'file://' + web, w: 3, kind: 'folder' },
  { uri: 'file://' + infra, w: 2, kind: 'folder' },
  { uri: 'file://' + mono, w: 2, kind: 'folder' },
  { uri: 'file://' + multi, w: 2, kind: 'workspace' },
  { uri: 'vscode-remote://wsl%2Bubuntu/home/dev/ml-notebooks', w: 1, kind: 'folder' },
];

const PROMPTS = {
  'Bug fix': ['Fix the null reference in the cart totals when a coupon expires', 'Why is this test failing with a timeout error after the refactor?', 'The build crashes with an unhandled exception in the order handler, please fix'],
  Tests: ['Write unit tests for the pricing service with edge cases', 'Add jest tests covering the retry logic and mock the HTTP client', 'Increase coverage for the checkout reducer'],
  Refactor: ['Refactor the payment module to use dependency injection', 'Clean up this controller and rename the DTOs consistently', 'Simplify this reducer and optimise the selectors'],
  Docs: ['Update the README with local setup steps', 'Add docstrings to the public API of the client library'],
  DevOps: ['Create a GitHub Actions workflow that builds the docker image and deploys to staging', 'Fix the helm values for the ingress controller', 'Write a terraform module for the storage account'],
  Review: ['Review this diff for security issues', 'Write a commit message for the staged changes'],
  Explain: ['Explain how the saga orchestrator handles compensation', 'What does this regex do and why is it slow?', 'Walk me through the auth middleware flow'],
  Feature: ['Add an endpoint to list orders by customer with pagination', 'Implement a React component for the product gallery', 'Create a new CLI command to export invoices'],
};
const TAGS = Object.keys(PROMPTS);
const MODELS = [['copilot/claude-sonnet-4.5', 3], ['copilot/gpt-5', 2], ['copilot/claude-opus-4.5', 1], ['copilot/gpt-4.1', 1], ['copilot/claude-haiku-4.5', 1]];
const modelPick = () => { const t = MODELS.flatMap(([m, w]) => Array(w).fill(m)); return pick(t); };
const FILES = ['CartService.ts', 'order.controller.ts', 'pricing.test.ts', 'Dockerfile', 'main.tf', 'ProductGallery.tsx', 'README.md', 'values.yaml', 'checkout.reducer.ts', 'client.py'];

// Anchored to a fixed Wednesday noon UTC, then rolled forward in whole weeks so it never falls behind
// the real clock (which would otherwise push all synthetic data out of "the last 7 days" checks).
// Whole-week steps keep every session's weekday and time of day exactly as originally authored.
const ANCHOR = Date.UTC(2026, 9, 7, 12, 0, 0);
const WEEK = 7 * 86400000;
const NOW = ANCHOR + Math.ceil(Math.max(0, Date.now() - ANCHOR) / WEEK) * WEEK;
const DAY = 86400000;
const BILLING_START = Date.UTC(2026, 5, 1);

function buildSession(wsUri, startTs, nPrompts, withDebug) {
  const id = uuid();
  const requests = [];
  const dbgEvents = [];
  const titleEvents = [];
  let t = startTs;
  for (let i = 0; i < nPrompts; i++) {
    const tag = pick(TAGS);
    const text = pick(PROMPTS[tag]);
    const model = modelPick();
    t += Math.floor(60000 + rnd() * 600000);
    const resp = 'Here is how to approach it. '.repeat(10 + Math.floor(rnd() * 40));
    const agentMode = rnd() < 0.55;
    const parts = [{ kind: 'markdownContent', content: { value: resp } }];
    const nTools = agentMode ? Math.floor(rnd() * 8) : 0;
    for (let k = 0; k < nTools; k++) { parts.push({ kind: 'toolInvocationSerialized', toolId: pick(['copilot_readFile', 'copilot_replaceString', 'copilot_runInTerminal', 'copilot_findTextInFiles']) }); }
    if (agentMode && rnd() < 0.7) { parts.push({ kind: 'textEditGroup', uri: { fsPath: '/x/src/' + pick(FILES) } }); }
    const req = {
      requestId: 'request_' + uuid(), timestamp: t, modelId: model,
      message: { text, parts: [{ text }] }, agent: { id: agentMode ? 'github.copilot.editsAgent' : 'github.copilot.default' },
      variableData: { variables: [{ name: 'file:' + pick(FILES), value: { fsPath: '/x/' + pick(FILES) } }] },
      response: parts, result: { timings: { totalElapsed: 4000 + Math.floor(rnd() * 90000) }, details: model.replace('copilot/', '') + ' • 1x', metadata: {} },
    };
    requests.push(req);
    if (withDebug) {
      dbgEvents.push({ ts: t, type: 'user_message', attrs: { content: text } });
      const calls = agentMode ? 1 + Math.floor(rnd() * 6) : 1;
      let ctx = 6000 + Math.floor(rnd() * 20000);
      for (let c = 0; c < calls; c++) {
        const inT = ctx; const outT = 200 + Math.floor(rnd() * 2500); ctx += outT + 800;
        const cached = Math.floor(inT * (c ? 0.8 : 0.1));
        const rateIn = /opus/.test(model) ? 5 : /haiku/.test(model) ? 1 : /gpt-4\.1/.test(model) ? 0 : 3;
        const rateOut = /opus/.test(model) ? 25 : /haiku/.test(model) ? 5 : /gpt-4\.1/.test(model) ? 0 : 15;
        const usd = ((inT - cached) * rateIn + cached * rateIn * 0.1 + outT * rateOut) / 1e6;
        const attrs = { model: model.replace('copilot/', ''), inputTokens: inT, outputTokens: outT, cachedTokens: cached, maxTokens: 16000 };
        if (rnd() < 0.9) { attrs.copilotUsageNanoAiu = Math.round(usd * 1e11); }
        dbgEvents.push({ ts: t + 3000 + c * 4000, dur: 3000, type: 'llm_request', name: 'chat', attrs });
      }
      if (i === 0) { titleEvents.push({ ts: t + 9000, type: 'llm_request', name: 'title', attrs: { model: 'gpt-4o-mini', inputTokens: 400, outputTokens: 20, copilotUsageNanoAiu: 0 } }); }
    } else if (t >= BILLING_START && rnd() < 0.3) {
      // some builds keep tokens in result.metadata
      req.result.metadata = { promptTokens: 8000 + Math.floor(rnd() * 30000), outputTokens: 300 + Math.floor(rnd() * 3000) };
    }
  }
  const state = { version: 3, sessionId: id, creationDate: startTs, lastMessageDate: t, customTitle: rnd() < 0.6 ? requests[0].message.text.slice(0, 48) : undefined, requests };
  return { id, state, dbgEvents, titleEvents };
}

let wsIdx = 0;
for (const ws of WORKSPACES) {
  const hash = md5(ws.uri + (wsIdx++));
  const dir = path.join(USER, 'workspaceStorage', hash);
  fs.mkdirSync(path.join(dir, 'chatSessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(ws.kind === 'workspace' ? { workspace: ws.uri } : { folder: ws.uri }));
  const nSessions = ws.w * 14;
  for (let s = 0; s < nSessions; s++) {
    const daysAgo = Math.floor(Math.pow(rnd(), 1.3) * 125);
    const startTs = NOW - daysAgo * DAY - Math.floor(rnd() * 8) * 3600000;
    const withDebug = startTs >= BILLING_START && rnd() < 0.75;
    const sess = buildSession(ws.uri, startTs, 1 + Math.floor(rnd() * 9), withDebug);
    if (rnd() < 0.4) {
      // JSONL mutation-log format: initial state with first request, then pushes + sets
      const first = { ...sess.state, requests: sess.state.requests.slice(0, 1) };
      const lines = [JSON.stringify({ kind: 0, v: first })];
      const rest = sess.state.requests.slice(1);
      if (rest.length) { lines.push(JSON.stringify({ kind: 2, k: ['requests'], v: rest })); }
      lines.push(JSON.stringify({ kind: 1, k: ['customTitle'], v: sess.state.customTitle || 'Session ' + sess.id.slice(0, 4) }));
      fs.writeFileSync(path.join(dir, 'chatSessions', sess.id + '.jsonl'), lines.join('\n') + '\n');
    } else {
      fs.writeFileSync(path.join(dir, 'chatSessions', sess.id + '.json'), JSON.stringify(sess.state));
    }
    if (withDebug) {
      const dd = path.join(dir, 'GitHub.copilot-chat', 'debug-logs', sess.id);
      fs.mkdirSync(dd, { recursive: true });
      fs.writeFileSync(path.join(dd, 'main.jsonl'), sess.dbgEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');
      if (sess.titleEvents.length) { fs.writeFileSync(path.join(dd, 'title-' + sess.id.slice(0, 8) + '.jsonl'), sess.titleEvents.map((e) => JSON.stringify(e)).join('\n') + '\n'); }
    }
  }
}

// windows with no folder open
const emptyDir = path.join(USER, 'globalStorage', 'emptyWindowChatSessions');
fs.mkdirSync(emptyDir, { recursive: true });
for (let i = 0; i < 6; i++) {
  const s = buildSession('', NOW - Math.floor(rnd() * 90) * DAY, 1 + Math.floor(rnd() * 4), false);
  fs.writeFileSync(path.join(emptyDir, s.id + '.json'), JSON.stringify(s.state));
}
// a corrupt file must not break the scan
fs.writeFileSync(path.join(emptyDir, 'broken.json'), '{ not json');

console.log('fixture written to', ROOT);
