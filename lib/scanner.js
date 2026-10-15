'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { readLines, replayMutationLog } = require('./jsonl');
const P = require('./pricing');
const Stories = require('../media/story-core.js');

const CACHE_VERSION = 4;

/* ------------------------------------------------------------------ */
/* Locations                                                           */
/* ------------------------------------------------------------------ */

function defaultUserDirs() {
  const home = os.homedir();
  let base;
  if (process.platform === 'win32') { base = process.env.APPDATA || path.join(home, 'AppData', 'Roaming'); }
  else if (process.platform === 'darwin') { base = path.join(home, 'Library', 'Application Support'); }
  else { base = process.env.XDG_CONFIG_HOME || path.join(home, '.config'); }
  return ['Code', 'Code - Insiders', 'VSCodium', 'Code - OSS'].map((n) => path.join(base, n, 'User'));
}

function editionOf(userDir) {
  const s = userDir.toLowerCase();
  if (s.includes('insiders')) { return 'Insiders'; }
  if (s.includes('vscodium')) { return 'VSCodium'; }
  if (s.includes('code - oss')) { return 'Code OSS'; }
  return 'VS Code';
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/* ------------------------------------------------------------------ */
/* Workspace identity + git                                            */
/* ------------------------------------------------------------------ */

function baseName(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
}

function parseUri(u) {
  try {
    const url = new URL(u);
    const scheme = url.protocol.replace(':', '');
    let p = decodeURIComponent(url.pathname);
    if (scheme === 'file') {
      if (/^\/[A-Za-z]:/.test(p)) { p = p.slice(1); }
      if (process.platform === 'win32') { p = p.replace(/\//g, '\\'); }
      return { scheme, authority: '', fsPath: p, path: p };
    }
    return { scheme, authority: decodeURIComponent(url.hostname || ''), fsPath: null, path: p };
  } catch {
    return { scheme: 'unknown', authority: '', fsPath: null, path: String(u) };
  }
}

function remoteLabel(scheme, authority) {
  if (scheme === 'file') { return ''; }
  const a = authority || '';
  if (/^wsl\+/i.test(a)) { return 'WSL: ' + a.slice(4); }
  if (/^ssh-remote\+/i.test(a)) { return 'SSH: ' + a.slice(11); }
  if (/^(dev-container|attached-container)\+/i.test(a)) { return 'Container'; }
  if (/codespaces/i.test(a)) { return 'Codespace'; }
  return scheme === 'vscode-remote' ? 'Remote' : scheme;
}

function stripJsonc(s) {
  return s.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
}

function cleanRemote(url) {
  if (!url) { return ''; }
  let u = url.trim();
  const ssh = /^[\w.-]+@([^:]+):(.+)$/.exec(u);
  if (ssh) { u = ssh[1] + '/' + ssh[2]; }
  u = u.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, ''); // drop scheme + any credentials
  return u.replace(/\.git$/, '');
}

async function readGit(dir) {
  const gitPath = path.join(dir, '.git');
  let st;
  try { st = await fsp.stat(gitPath); } catch { return null; }
  let gitDir = gitPath;
  if (st.isFile()) {
    try {
      const m = /gitdir:\s*(.+)/.exec(await fsp.readFile(gitPath, 'utf8'));
      if (!m) { return null; }
      gitDir = path.resolve(dir, m[1].trim());
    } catch { return null; }
  }
  let branch = '';
  try {
    const head = (await fsp.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
    branch = head.startsWith('ref:') ? head.replace(/^ref:\s*refs\/heads\//, '') : head.slice(0, 7);
  } catch { /* ignore */ }
  let cfgDir = gitDir;
  try { cfgDir = path.resolve(gitDir, (await fsp.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim()); } catch { /* not a worktree */ }
  let remote = '';
  try {
    const cfg = await fsp.readFile(path.join(cfgDir, 'config'), 'utf8');
    const m = /\[remote "origin"\][^[]*?url\s*=\s*(.+)/.exec(cfg);
    if (m) { remote = cleanRemote(m[1]); }
  } catch { /* ignore */ }
  return { name: baseName(dir), path: dir, branch, remote };
}

async function reposIn(dir) {
  const root = await readGit(dir);
  if (root) { return [root]; }
  const out = [];
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries.slice(0, 80)) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') { continue; }
      const g = await readGit(path.join(dir, e.name));
      if (g) { out.push(g); }
      if (out.length >= 25) { break; }
    }
  } catch { /* unreadable folder */ }
  return out;
}

const wsInfoCache = new Map();

async function workspaceInfo(hashDir) {
  let j;
  try { j = JSON.parse(await fsp.readFile(path.join(hashDir, 'workspace.json'), 'utf8')); } catch { return null; }
  const uri = j.folder || j.workspace;
  if (!uri) { return null; }
  if (wsInfoCache.has(uri)) { return wsInfoCache.get(uri); }

  const u = parseUri(uri);
  const isMulti = !!j.workspace;
  const name = isMulti ? baseName(u.path).replace(/\.code-workspace$/i, '') : baseName(u.path);
  const info = {
    key: uri,
    kind: isMulti ? 'multi-root' : 'folder',
    name: name || uri,
    path: u.fsPath || u.path,
    local: u.scheme === 'file' && !!u.fsPath,
    remote: remoteLabel(u.scheme, u.authority),
    repos: [],
  };

  if (info.local) {
    try {
      if (isMulti) {
        const raw = JSON.parse(stripJsonc(await fsp.readFile(u.fsPath, 'utf8')));
        const base = path.dirname(u.fsPath);
        for (const f of (raw.folders || []).slice(0, 20)) {
          if (!f.path) { continue; }
          info.repos.push(...(await reposIn(path.resolve(base, f.path))));
        }
      } else {
        info.repos = await reposIn(u.fsPath);
      }
    } catch { /* workspace file gone */ }
  }
  wsInfoCache.set(uri, info);
  return info;
}

const EMPTY_WS = { key: '__empty__', kind: 'none', name: 'No folder open', path: '', local: false, remote: '', repos: [] };

/* ------------------------------------------------------------------ */
/* Prompt classification                                               */
/* ------------------------------------------------------------------ */

const TAGS = [
  ['Bug fix', /\b(fix|bug|error|exception|fails?|failing|crash(es|ed)?|broken|stack ?trace|not working|regression)\b/i],
  ['Tests', /\b(tests?|unit ?tests?|spec|jest|pytest|vitest|coverage|mocks?|assertions?)\b/i],
  ['Refactor', /\b(refactor|clean ?up|rename|restructure|simplif(y|ied)|optimi[sz]e|migrate|upgrade)\b/i],
  ['Docs', /\b(readme|docs?|documentation|docstring|jsdoc|comments?|changelog)\b/i],
  ['DevOps', /\b(docker(file)?|ci\/cd|ci|pipeline|deploy(ment)?|kubernetes|k8s|terraform|helm|github actions|workflow|yaml|bicep|arm template)\b/i],
  ['Review', /\b(review|pull request|pr|diff|commit message|code smell)\b/i],
  ['Explain', /\b(explain|what is|what does|why (is|does|do)|how (does|do|to)|understand|walk me through|summari[sz]e)\b/i],
  ['Feature', /\b(add|implement|create|build|generate|new|support|endpoint|component|scaffold)\b/i],
];

function classify(text) {
  for (const [tag, re] of TAGS) { if (re.test(text)) { return tag; } }
  return 'Other';
}

/* ------------------------------------------------------------------ */
/* Chat-session parsing                                                */
/* ------------------------------------------------------------------ */

const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

function textOf(msg) {
  if (!msg) { return ''; }
  if (typeof msg === 'string') { return msg; }
  if (typeof msg.text === 'string') { return msg.text; }
  if (Array.isArray(msg.parts)) { return msg.parts.map((p) => (p && p.text) || '').join(''); }
  return '';
}

function mdOf(part) {
  if (!part) { return ''; }
  const v = part.value;
  if (typeof v === 'string') { return v; }
  if (v && typeof v.value === 'string') { return v.value; }
  if (part.content && typeof part.content.value === 'string') { return part.content.value; }
  return '';
}

function uriName(u) {
  if (!u) { return null; }
  if (typeof u === 'string') { return baseName(u); }
  const p = u.fsPath || u.path || (u.uri && (u.uri.fsPath || u.uri.path));
  return p ? baseName(p) : null;
}

function toMs(v) {
  if (v == null) { return null; }
  if (typeof v === 'number') { return v < 1e11 ? v * 1000 : v; }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Look for token / cost fields wherever this Copilot Chat version put them. */
function findUsage(req) {
  const u = { inTok: null, outTok: null, nano: null, credits: null };
  const visit = (obj, depth) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 4) { return; }
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number') {
        if (/^(prompt|input)_?tokens$/i.test(k)) { u.inTok = u.inTok ?? v; }
        else if (/^(output|completion)_?tokens$/i.test(k)) { u.outTok = u.outTok ?? v; }
        else if (/nano_?aiu$/i.test(k)) { u.nano = u.nano ?? v; }
      } else if (v && typeof v === 'object') { visit(v, depth + 1); }
    }
  };
  visit(req.result, 0);
  visit(req.usage, 0);
  visit(req.modelMetrics, 0);
  for (const k of ['promptTokens', 'inputTokens']) { if (num(req[k]) != null) { u.inTok = u.inTok ?? req[k]; } }
  for (const k of ['outputTokens', 'completionTokens']) { if (num(req[k]) != null) { u.outTok = u.outTok ?? req[k]; } }
  // Copilot's own cost for this request, already worked out for the model and reasoning effort actually used
  if (num(req.copilotCredits) != null && req.copilotCredits >= 0) { u.credits = req.copilotCredits; }
  return u;
}

function modelFromDetails(details) {
  if (typeof details !== 'string') { return ''; }
  return details.split('•')[0].trim();
}

function agentLabel(req) {
  const a = req.agent;
  const id = String((a && (a.id || a.name)) || '');
  // Copilot's Plan agent (best effort: matched by name or id; if a version names it differently it simply shows as Ask/Agent)
  if (/(^|[^a-z])plan(ner)?($|[^a-z])/i.test(String((a && a.name) || '')) || /(^|[^a-z])plan(ner)?($|[^a-z])/i.test(id)) { return 'Plan'; }
  if (/edit|agent/i.test(id)) { return 'Agent'; }
  if (id) { return 'Ask'; }
  return '';
}

function buildPrompts(state, diag) {
  const reqs = Array.isArray(state && state.requests) ? state.requests : [];
  const out = [];
  reqs.forEach((req, i) => {
    if (!req || typeof req !== 'object') { return; }
    if (diag) {
      Object.keys(req).forEach((k) => diag.requestKeys.add(k));
      if (req.result && req.result.metadata) { Object.keys(req.result.metadata).forEach((k) => diag.metaKeys.add(k)); }
    }
    const text = textOf(req.message);
    let resp = '';
    let respChars = 0;
    let toolCalls = 0;
    const toolCount = {};
    const edited = new Set();
    const files = new Set();

    for (const part of Array.isArray(req.response) ? req.response : []) {
      if (!part) { continue; }
      if (part.kind === 'toolInvocationSerialized' || part.toolId) {
        toolCalls++;
        const id = String(part.toolId || 'tool').replace(/^copilot_/, '');
        toolCount[id] = (toolCount[id] || 0) + 1;
      } else if (part.kind === 'textEditGroup' || part.kind === 'notebookEditGroup') {
        const n = uriName(part.uri); if (n) { edited.add(n); }
      } else if (part.kind === 'inlineReference') {
        const n = uriName(part.inlineReference); if (n) { files.add(n); }
      } else {
        const v = mdOf(part);
        if (v) { respChars += v.length; if (resp.length < 400) { resp += v; } }
      }
    }
    const vars = req.variableData && req.variableData.variables;
    for (const v of Array.isArray(vars) ? vars : []) {
      const n = uriName(v.value) || (typeof v.name === 'string' ? v.name.replace(/^file:/, '') : null);
      if (n && n.length < 120) { files.add(n); }
    }

    const model = P.normModel(req.modelId) || modelFromDetails(req.result && req.result.details);
    const ts = toMs(req.timestamp);
    const timings = req.result && req.result.timings;

    out.push({
      i,
      ts,
      text: clip(text.trim(), 600),
      chars: text.length,
      resp: clip(resp.trim(), 260),
      respChars,
      model,
      agent: agentLabel(req),
      tag: classify(text),
      tools: Object.entries(toolCount).sort((a, b) => b[1] - a[1]).slice(0, 6),
      toolCalls,
      files: [...files].slice(0, 8),
      edited: [...edited].slice(0, 8),
      canceled: !!req.isCanceled,
      dur: timings && num(timings.totalElapsed),
      _chat: findUsage(req),
      _calls: [],
    });
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Debug logs (exact tokens + billed credits)                          */
/* ------------------------------------------------------------------ */

async function parseDebugDir(dir, diag) {
  const calls = [];
  const users = [];
  let files = [];
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl')); } catch { return { calls, users }; }
  for (const f of files) {
    let agent = 'main';
    if (/^runSubagent-/.test(f)) { agent = 'subagent'; }
    else if (/^title/i.test(f)) { agent = 'title'; }
    else if (f !== 'main.jsonl') { agent = f.replace(/\.jsonl$/, ''); }
    try {
      for await (const line of readLines(path.join(dir, f))) {
        const isLlm = line.includes('"llm_request"');
        const isUser = !isLlm && line.includes('"user_message"');
        if (!isLlm && !isUser) { continue; }
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        const a = ev.attrs || {};
        if (ev.type === 'llm_request') {
          if (diag) { Object.keys(a).forEach((k) => diag.debugAttrKeys.add(k)); }
          let nano = num(a.copilotUsageNanoAiu ?? a.copilot_usage_nano_aiu);
          if (nano == null && a.usage && typeof a.usage === 'object') { nano = num(a.usage.copilotUsageNanoAiu); }
          calls.push({
            ts: toMs(ev.ts),
            dur: num(ev.dur),
            model: P.normModel(a.model),
            inTok: num(a.inputTokens ?? a.input_tokens ?? a.promptTokens) || 0,
            outTok: num(a.outputTokens ?? a.output_tokens ?? a.completionTokens) || 0,
            cached: num(a.cachedTokens ?? a.cached_tokens ?? a.cacheReadTokens ?? a.cachedInputTokens) || 0,
            nano,
            agent,
          });
        } else if (ev.type === 'user_message') {
          users.push({ ts: toMs(ev.ts), text: typeof a.content === 'string' ? a.content : '' });
        }
      }
    } catch { /* unreadable log file */ }
  }
  calls.sort((x, y) => (x.ts || 0) - (y.ts || 0));
  users.sort((x, y) => (x.ts || 0) - (y.ts || 0));
  return { calls, users };
}

function assignCalls(prompts, debug) {
  const overhead = [];
  if (!debug.calls.length) { return overhead; }
  const useUserIdx = debug.users.length === prompts.length && debug.users.every((u) => u.ts != null);
  const hasPromptTs = prompts.length && prompts.every((p) => p.ts != null);
  for (const c of debug.calls) {
    let idx = -1;
    if (c.ts == null || c.agent === 'title') { overhead.push(c); continue; } // titles are background work, like VS Code's own panel
    if (useUserIdx) {
      for (let k = 0; k < debug.users.length; k++) { if (debug.users[k].ts <= c.ts + 1500) { idx = k; } else { break; } }
    } else if (hasPromptTs) {
      for (let k = 0; k < prompts.length; k++) { if (prompts[k].ts <= c.ts + 1500) { idx = k; } else { break; } }
    }
    if (idx < 0) { idx = prompts.length ? 0 : -1; }
    if (idx < 0) { overhead.push(c); } else { prompts[idx]._calls.push(c); }
  }
  return overhead;
}

/* ------------------------------------------------------------------ */
/* Finalising tokens and credits                                       */
/* ------------------------------------------------------------------ */

function finalizePrompts(prompts, pricing) {
  let hist = 0;
  for (const p of prompts) {
    const calls = p._calls;
    const chat = p._chat;
    if (calls.length) {
      let inTok = 0, outTok = 0, cached = 0, credits = 0, exact = 0, peak = 0, dur = 0;
      for (const c of calls) {
        inTok += c.inTok; outTok += c.outTok; cached += c.cached; dur += c.dur || 0;
        peak = Math.max(peak, c.inTok);
        if (c.nano != null) { credits += c.nano / P.NANO_PER_CREDIT; exact++; }
        else { credits += P.creditsFromTokens(c.model || p.model, Math.max(0, c.inTok - c.cached), c.cached, c.outTok, pricing); }
      }
      p.inTok = inTok; p.outTok = outTok; p.cached = cached; p.calls = calls.length; p.peak = peak;
      p.credits = credits;
      p.quality = exact === calls.length ? 'exact' : 'tokens';
      if (exact !== calls.length && chat.credits != null) { p.credits = chat.credits; p.quality = 'exact'; }
      if (!p.model) { p.model = calls.find((c) => c.model)?.model || ''; }
      if (!p.dur && dur) { p.dur = dur; }
    } else if (chat.inTok != null || chat.outTok != null || chat.nano != null || chat.credits != null) {
      const estIn = Math.round((hist + p.chars) / 4) + P.BASE_CONTEXT_TOKENS;
      p.inTok = chat.inTok != null ? chat.inTok : estIn;
      p.outTok = chat.outTok != null ? chat.outTok : P.estimateTokens(p.respChars);
      p.cached = 0; p.calls = 1; p.peak = p.inTok;
      if (chat.credits != null) { p.credits = chat.credits; p.quality = 'exact'; }
      else if (chat.nano != null) { p.credits = chat.nano / P.NANO_PER_CREDIT; p.quality = 'exact'; }
      else {
        p.credits = P.creditsFromTokens(p.model, p.inTok, 0, p.outTok, pricing);
        p.quality = chat.inTok != null && chat.outTok != null ? 'tokens' : 'estimated';
      }
    } else {
      p.inTok = Math.round((hist + p.chars) / 4) + P.BASE_CONTEXT_TOKENS;
      p.outTok = P.estimateTokens(p.respChars);
      p.cached = 0; p.calls = 0; p.peak = p.inTok;
      p.credits = P.creditsFromTokens(p.model, p.inTok, 0, p.outTok, pricing);
      p.quality = 'estimated';
    }
    hist += p.chars + p.respChars;
    delete p._chat; delete p._calls;
  }
}

/* ------------------------------------------------------------------ */
/* Scan                                                                */
/* ------------------------------------------------------------------ */

async function statSig(file) {
  try { const s = await fsp.stat(file); return `${s.size}:${Math.round(s.mtimeMs)}`; } catch { return '-'; }
}

async function dirSig(dir) {
  try {
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
    const parts = [];
    for (const f of files) { parts.push(f + ':' + (await statSig(path.join(dir, f)))); }
    return parts.join('|');
  } catch { return '-'; }
}

async function listSessionFiles(chatDir) {
  const map = new Map();
  let names = [];
  try { names = await fsp.readdir(chatDir); } catch { return map; }
  for (const n of names) {
    const m = /^(.+)\.(jsonl|json)$/.exec(n);
    if (!m) { continue; }
    const prev = map.get(m[1]);
    if (!prev || m[2] === 'jsonl') { map.set(m[1], { file: path.join(chatDir, n), format: m[2] }); } // .jsonl wins
  }
  return map;
}

/**
 * @param {{userDirs:string[], pricing?:object, cache?:object, onProgress?:(done:number,total:number,label:string)=>void}} opts
 */
async function scan(opts) {
  const pricing = opts.pricing || {};
  // part of every session's cache signature below, so editing aiDeliveryInsights.pricing invalidates cached credits on the next scan
  const pricingSig = JSON.stringify(Object.keys(pricing).sort().map((k) => [k, pricing[k]]));
  const cache = opts.cache || { version: CACHE_VERSION, entries: {} };
  if (cache.version !== CACHE_VERSION) { cache.version = CACHE_VERSION; cache.entries = {}; }
  const diag = {
    requestKeys: new Set(), metaKeys: new Set(), debugAttrKeys: new Set(),
    formats: { json: 0, jsonl: 0 }, errors: [], dirs: [], cacheHits: 0,
  };

  // 1) discover every (workspace, session) unit of work
  const units = [];
  const workspaces = {};
  const sources = [];
  for (const userDir of opts.userDirs) {
    if (!(await exists(userDir))) { continue; }
    const edition = editionOf(userDir);
    sources.push({ edition, dir: userDir });
    const wsRoot = path.join(userDir, 'workspaceStorage');
    let hashes = [];
    try { hashes = await fsp.readdir(wsRoot); } catch { /* none */ }
    for (const h of hashes) {
      const hashDir = path.join(wsRoot, h);
      const chatDir = path.join(hashDir, 'chatSessions');
      const dbgRoot = path.join(hashDir, 'GitHub.copilot-chat', 'debug-logs');
      const chatFiles = await listSessionFiles(chatDir);
      let dbgIds = [];
      try { dbgIds = await fsp.readdir(dbgRoot); } catch { /* none */ }
      if (!chatFiles.size && !dbgIds.length) { continue; }
      const info = (await workspaceInfo(hashDir)) || { ...EMPTY_WS, key: `__unknown__${h}`, name: `Unknown workspace (${h.slice(0, 6)})` };
      workspaces[info.key] = workspaces[info.key] || { ...info, editions: [] };
      if (!workspaces[info.key].editions.includes(edition)) { workspaces[info.key].editions.push(edition); }
      const ids = new Set([...chatFiles.keys(), ...dbgIds]);
      for (const id of ids) {
        units.push({ edition, hash: h, wsKey: info.key, id, chat: chatFiles.get(id) || null, dbgDir: dbgIds.includes(id) ? path.join(dbgRoot, id) : null });
      }
    }
    // windows opened without a folder
    const emptyDir = path.join(userDir, 'globalStorage', 'emptyWindowChatSessions');
    const emptyFiles = await listSessionFiles(emptyDir);
    if (emptyFiles.size) {
      workspaces[EMPTY_WS.key] = workspaces[EMPTY_WS.key] || { ...EMPTY_WS, editions: [] };
      if (!workspaces[EMPTY_WS.key].editions.includes(edition)) { workspaces[EMPTY_WS.key].editions.push(edition); }
      for (const [id, f] of emptyFiles) { units.push({ edition, hash: 'empty', wsKey: EMPTY_WS.key, id, chat: f, dbgDir: null }); }
    }
  }

  // 2) parse each session (with a signature-keyed cache)
  const sessions = [];
  let done = 0;
  for (const u of units) {
    const ckey = `${u.edition}|${u.hash}|${u.id}`;
    const sig = (u.chat ? await statSig(u.chat.file) : '-') + '#' + (u.dbgDir ? await dirSig(u.dbgDir) : '-') + '#' + pricingSig;
    const hit = cache.entries[ckey];
    if (hit && hit.sig === sig) {
      sessions.push(hit.session);
      diag.cacheHits++;
    } else {
      try {
        const s = await parseSession(u, pricing, diag);
        if (s) { sessions.push(s); cache.entries[ckey] = { sig, session: s }; }
      } catch (e) {
        if (diag.errors.length < 20) { diag.errors.push(`${u.chat ? u.chat.file : u.dbgDir}: ${e.message}`); }
      }
    }
    done++;
    if (opts.onProgress && (done % 5 === 0 || done === units.length)) {
      opts.onProgress(done, units.length, u.id);
      await new Promise((r) => setImmediate(r));
    }
  }
  // drop cache entries for sessions that no longer exist
  const live = new Set(units.map((u) => `${u.edition}|${u.hash}|${u.id}`));
  for (const k of Object.keys(cache.entries)) { if (!live.has(k)) { delete cache.entries[k]; } }

  sessions.sort((a, b) => (b.last || 0) - (a.last || 0));
  const cap = (s) => [...s].sort().slice(0, 80);
  return {
    version: 1,
    generatedAt: Date.now(),
    sources,
    workspaces,
    sessions,
    diagnostics: {
      units: units.length, cacheHits: diag.cacheHits, formats: diag.formats, errors: diag.errors,
      requestKeys: cap(diag.requestKeys), metaKeys: cap(diag.metaKeys), debugAttrKeys: cap(diag.debugAttrKeys),
      withDebugLogs: sessions.filter((s) => s.hasDebug).length,
    },
  };
}

async function parseSession(u, pricing, diag) {
  let state = null;
  if (u.chat) {
    diag.formats[u.chat.format]++;
    state = u.chat.format === 'jsonl'
      ? await replayMutationLog(readLines(u.chat.file))
      : JSON.parse(await fsp.readFile(u.chat.file, 'utf8'));
  }
  const debug = u.dbgDir ? await parseDebugDir(u.dbgDir, diag) : { calls: [], users: [] };

  let prompts = state ? buildPrompts(state, diag) : [];
  if (!prompts.length && debug.users.length) {
    // chat file missing/empty: rebuild prompts from the debug log alone
    prompts = debug.users.map((usr, i) => ({
      i, ts: usr.ts, text: clip(usr.text.trim(), 600), chars: usr.text.length, resp: '', respChars: 0, model: '',
      agent: '', tag: classify(usr.text), tools: [], toolCalls: 0, files: [], edited: [], canceled: false, dur: null,
      _chat: { inTok: null, outTok: null, nano: null, credits: null }, _calls: [],
    }));
  }
  if (!prompts.length && !debug.calls.length) { return null; }

  const overheadCalls = assignCalls(prompts, debug);
  finalizePrompts(prompts, pricing);
  const overhead = { calls: overheadCalls.length, inTok: 0, outTok: 0, credits: 0 };
  for (const c of overheadCalls) {
    overhead.inTok += c.inTok; overhead.outTok += c.outTok;
    overhead.credits += c.nano != null ? c.nano / P.NANO_PER_CREDIT : P.creditsFromTokens(c.model, Math.max(0, c.inTok - c.cached), c.cached, c.outTok, pricing);
  }

  const first = prompts.find((p) => p.ts != null);
  const lastP = [...prompts].reverse().find((p) => p.ts != null);
  const created = toMs(state && state.creationDate) || (first && first.ts) || (debug.calls[0] && debug.calls[0].ts) || null;
  const last = toMs(state && state.lastMessageDate) || (lastP && lastP.ts) || created;
  const title = (state && state.customTitle) || (prompts[0] && clip(prompts[0].text.replace(/\s+/g, ' '), 80)) || '(untitled)';
  return {
    id: u.id, wsKey: u.wsKey, edition: u.edition, title, created, last,
    file: u.chat ? u.chat.file : null, format: u.chat ? u.chat.format : 'debug-only',
    hasDebug: !!u.dbgDir, prompts, overhead: overhead.calls ? overhead : null,
  };
}

/* ------------------------------------------------------------------ */
/* Helpers for the extension host                                      */
/* ------------------------------------------------------------------ */

/** Totals since `sinceMs`. With `wsKey`, only that workspace's sessions. */
function summarize(data, sinceMs, wsKey) {
  let credits = 0, prompts = 0, tokens = 0;
  for (const s of data.sessions) {
    if (wsKey != null && s.wsKey !== wsKey) { continue; }
    for (const p of s.prompts) {
      const t = p.ts || s.created || 0;
      if (t >= sinceMs) { credits += p.credits; prompts++; tokens += p.inTok + p.outTok; }
    }
    if (s.overhead && (s.last || 0) >= sinceMs) { credits += s.overhead.credits; }
  }
  return { credits, prompts, tokens };
}

function csvCell(v) {
  const s = String(v == null ? '' : v).replace(/\r?\n/g, ' ');
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * Text that comes from chat content or from people (prompts, titles, names). A cell that starts with
 * = + - @ or a tab would be run as a formula by Excel and similar tools, so it gets a leading apostrophe.
 */
function csvText(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) { s = "'" + s; }
  return csvCell(s);
}

/**
 * @param {object} data scan result
 * @param {{from?:number|null, to?:number|null, store?:object, storyId?:string}} [range]
 *   from/to: inclusive ms bounds; omit/null = unbounded.
 *   store: story tags; adds the story columns.
 *   storyId: only that story's prompts, plus one row per session for its background calls, so the file adds up to the story total.
 */
function toCsv(data, range) {
  const r = range || {};
  const lo = Number.isFinite(r.from) ? r.from : null;
  const hi = Number.isFinite(r.to) ? r.to : null;
  const store = r.store || null;
  const only = typeof r.storyId === 'string' ? r.storyId : null;
  const head = ['date', 'workspace', 'repo', 'session', 'prompt', 'work_type', 'phase', 'phase_source', 'model', 'llm_calls', 'input_tokens', 'output_tokens', 'cached_tokens', 'credits', 'usd', 'data_quality', 'story_id', 'story_title', 'story_group'];
  const rows = [head.join(',')];
  const storyCells = (id) => {
    const st = id != null && store && Stories.hasOwn(store.stories, id) ? store.stories[id] : null;
    return [csvText(st ? st.id : ''), csvText(st ? st.title : ''), csvText(st ? st.group : '')];
  };
  for (const s of data.sessions) {
    const ws = data.workspaces[s.wsKey] || {};
    const repo = (ws.repos && ws.repos[0] && (ws.repos[0].remote || ws.repos[0].name)) || '';
    for (const p of s.prompts) {
      const when = p.ts || s.created || 0;
      if ((lo != null && when < lo) || (hi != null && when > hi)) { continue; }
      const row = { p, s, ov: false };
      const sid = store ? Stories.storyOf(store, row) : null;
      if (only != null && sid !== only) { continue; }
      rows.push([
        csvCell(new Date(when).toISOString()), csvText(ws.name), csvText(repo), csvText(s.title), csvText(clip(p.text, 200)), csvText(p.tag),
        csvText(Stories.phaseLabel(Stories.phaseOf(store, row))), csvCell(Stories.phaseSource(store, row)), csvText(p.model), csvCell(p.calls),
        csvCell(p.inTok), csvCell(p.outTok), csvCell(p.cached), csvCell(p.credits.toFixed(4)), csvCell((p.credits / 100).toFixed(4)), csvCell(p.quality),
        ...storyCells(sid),
      ].join(','));
    }
    if (only != null && s.overhead && store && Stories.storyOf(store, { s, ov: true }) === only) {
      const when = s.last || s.created || 0;
      if (!((lo != null && when < lo) || (hi != null && when > hi))) {
        const o = s.overhead;
        rows.push([
          csvCell(new Date(when).toISOString()), csvText(ws.name), csvText(repo), csvText(s.title), csvText('(background calls)'), csvText('Background'), csvText('Background'), csvCell(''), csvText(''), csvCell(o.calls),
          csvCell(o.inTok), csvCell(o.outTok), csvCell(0), csvCell(o.credits.toFixed(4)), csvCell((o.credits / 100).toFixed(4)), csvCell('exact'),
          ...storyCells(only),
        ].join(','));
      }
    }
  }
  return rows.join('\n');
}

function diagnoseText(data) {
  const d = data.diagnostics;
  const lines = [];
  lines.push('AI Delivery Insights diagnostics');
  lines.push('========================');
  lines.push('Data folders scanned:');
  data.sources.forEach((s) => lines.push(`  - ${s.edition}: ${s.dir}`));
  lines.push(`Workspaces with Copilot data: ${Object.keys(data.workspaces).length}`);
  lines.push(`Sessions parsed: ${data.sessions.length} (from ${d.units} units, ${d.cacheHits} from cache)`);
  lines.push(`Chat file formats: .json=${d.formats.json}, .jsonl=${d.formats.jsonl}`);
  lines.push(`Sessions with debug logs (exact tokens/credits): ${d.withDebugLogs}`);
  let q = { exact: 0, tokens: 0, estimated: 0 };
  data.sessions.forEach((s) => s.prompts.forEach((p) => { q[p.quality]++; }));
  lines.push(`Prompts by data quality: exact=${q.exact}, tokens=${q.tokens}, estimated=${q.estimated}`);
  lines.push('');
  lines.push('Field names seen (names only, no content):');
  lines.push('  request keys: ' + (d.requestKeys.join(', ') || '(none)'));
  lines.push('  result.metadata keys: ' + (d.metaKeys.join(', ') || '(none)'));
  lines.push('  debug llm_request attrs: ' + (d.debugAttrKeys.join(', ') || '(none)'));
  if (d.errors.length) { lines.push('', 'Errors:'); d.errors.forEach((e) => lines.push('  ' + e)); }
  return lines.join('\n');
}

module.exports = { scan, defaultUserDirs, summarize, toCsv, diagnoseText, classify };
