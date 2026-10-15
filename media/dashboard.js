/* AI Delivery Insights dashboard. Runs inside the VS Code webview; no network, no dependencies. */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const Core = window.StoryCore;
  const DAY = 86400000;
  const PALETTE = ['#7c8cff', '#35cdb0', '#f2a65a', '#e86f93', '#9acd5a', '#5ab7f2', '#b58cf3'];
  const OTHER = '#8b95a7';

  const saved = vscode.getState() || {};
  const S = Object.assign({
    range: 30, from: '', to: '', metric: 'credits', ws: 'all', model: 'all', tag: 'all', phase: 'all', q: '', tab: 'sessions',
    storyWin: 'all', sSort: 'credits', sGroup: 'all', sQ: '', uWs: 'all', adoBoards: {},
  }, saved);
  if (!S.adoBoards || typeof S.adoBoards !== 'object' || Array.isArray(S.adoBoards)) { S.adoBoards = {}; }
  if (S.phase !== 'all' && !Core.validPhase(S.phase)) { S.phase = 'all'; }
  S.route = Core.normalizeRoute(S.route) || { name: 'dash' };
  S.hist = (Array.isArray(S.hist) ? S.hist : []).map(Core.normalizeRoute).filter(Boolean).slice(-7);
  // A page that reads from Azure DevOps, or starts git to read a repository, only starts when someone opens it by clicking, never
  // because a window was restored.
  if (S.route.name === 'sync' || S.route.name === 'effort') { S.route = { name: 'story', id: S.route.id }; } else if (S.route.name === 'import') { S.route = { name: 'stories' }; }
  S.hist = S.hist.filter((r) => r.name !== 'sync' && r.name !== 'import' && r.name !== 'effort');
  if (S.route.name !== 'dash' && !S.hist.length) { S.hist = [{ name: 'dash' }]; }
  // transient (never saved): list length, open form, selection, message, pending edit
  S.shown = 25; S.uShown = 25; S.form = null; S.sel = new Set(); S.toast = null; S.bulk = ''; S.confirmDelete = ''; S.bQ = '';
  const expanded = new Set();
  const openPrompts = new Set();

  // Custom From/To is edited here first; nothing is filtered until "Show data" (or Enter) commits it into S.from/S.to.
  let dateDraft = { from: S.from, to: S.to };

  let STORE = Core.emptyStore();
  let SESS = new Map();
  let BY_SESSION = new Map();
  let AFTER = null; // runs after a page is drawn (charts)
  let RID = Math.floor(Math.random() * 1e9) * 1000; let PENDING = 0;

  let DATA = null;
  let ROWS = [];
  let CURRENT = { uris: [], paths: [] };
  let ALLOWANCE = 0;
  let SCANNING = null;
  let wsRank = [];
  let EARLIEST = Date.now();

  const $ =(s, el) => (el || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- formatting ---------- */
  const fmtN = (n) => {
    if (n >= 1e9) { return (n / 1e9).toFixed(1) + 'B'; }
    if (n >= 1e6) { return (n / 1e6).toFixed(1) + 'M'; }
    if (n >= 1e4) { return Math.round(n / 1e3) + 'k'; }
    if (n >= 1e3) { return (n / 1e3).toFixed(1) + 'k'; }
    return String(Math.round(n));
  };
  const fmtC = (c) => (c >= 1000 ? Math.round(c).toLocaleString() : c >= 100 ? c.toFixed(0) : c >= 10 ? c.toFixed(1) : c.toFixed(2));
  const usd = (c) => '$' + (c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtV = (v) => (S.metric === 'credits' ? fmtC(v) : fmtN(v));
  const unitName = () => (S.metric === 'credits' ? 'credits' : S.metric === 'tokens' ? 'tokens' : 'prompts');
  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dkey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
  /** Calendar-safe day arithmetic: adding 24h blocks drifts by an hour across daylight-saving changes. */
  const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d.getTime(); };
  /** 'YYYY-MM-DD' (what <input type="date"> gives) to local midnight, or null if empty/invalid. */
  const parseDay = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null; };
  const inputVal = (t) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const fDate = (t, o) => new Date(t).toLocaleDateString(undefined, o || { month: 'short', day: 'numeric' });
  const fTime = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const niceMax = (v) => {
    if (v <= 0) { return 1; }
    const e = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / e;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
  };
  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
  };

  /* ---------- data prep ---------- */
  function prepare(data) {
    const built = Core.buildRows(data);
    ROWS = built.rows;
    const totals = built.wsTotals;
    SESS = new Map(); BY_SESSION = new Map();
    for (const sess of data.sessions) { SESS.set(sess.id, sess); }
    for (const r of ROWS) { const a = BY_SESSION.get(r.s.id); if (a) { a.push(r); } else { BY_SESSION.set(r.s.id, [r]); } }
    wsRank = Object.keys(data.workspaces).sort((a, b) => (totals[b] || 0) - (totals[a] || 0));
    EARLIEST = ROWS.reduce((m, r) => (r.ts && r.ts < m ? r.ts : m), Date.now());
  }

  const wsColor = (k) => { const i = wsRank.indexOf(k); return i >= 0 && i < PALETTE.length ? PALETTE[i] : OTHER; };
  const wsOf = (k) => (DATA.workspaces[k] || { name: 'Unknown', repos: [] });
  const repoLine = (w) => {
    const r = w.repos && w.repos[0];
    if (!r) { return w.remote ? w.remote : w.path || ''; }
    return r.remote || r.name;
  };

  function val(r) {
    if (S.metric === 'credits') { return r.p.credits; }
    if (S.metric === 'tokens') { return r.p.inTok + r.p.outTok; }
    return r.ov ? 0 : 1;
  }

  function matches(r, q) {
    if (!q) { return true; }
    const w = wsOf(r.ws);
    const hay = [r.p.text, r.s.title, w.name, repoLine(w), r.p.tag, r.p.model, (r.p.files || []).join(' '), (r.p.edited || []).join(' ')].join(' ').toLowerCase();
    return q.split(/\s+/).every((t) => hay.includes(t));
  }

  /**
   * The active date window, as whole local days.
   *  - custom: a From and/or To is set. "To" is optional and defaults to today.
   *    If only To is set, the window starts at the earliest recorded prompt.
   *    If From is after To the two are swapped. Dates after today are clamped to today.
   *  - otherwise the quick range (7/30/90 days, or all time).
   * from/to are local midnight of the first/last day; end is the exclusive upper bound.
   */
  function getWindow() {
    const today = startOfDay(Date.now());
    const f = parseDay(S.from), t = parseDay(S.to);
    let from, to, custom = false, openEnded = false;
    if (f != null || t != null) {
      custom = true;
      from = f != null ? f : startOfDay(EARLIEST);
      to = t != null ? t : today;
      openEnded = t == null;
      if (from > to) { const x = from; from = to; to = x; }
      to = Math.min(to, today);
      from = Math.min(from, to);
    } else if (S.range > 0) {
      from = addDays(today, -(S.range - 1)); to = today;
    } else {
      from = Math.min(startOfDay(EARLIEST), today); to = today;
    }
    // "All time" also keeps the rare prompt that has no timestamp at all
    return { from, to, end: addDays(to, 1), custom, openEnded, all: !custom && !(S.range > 0) };
  }

  function windowLabel(w) {
    const o = { month: 'short', day: 'numeric', year: 'numeric' };
    if (w.custom) { return `${fDate(w.from, o)} to ${w.openEnded ? 'today' : fDate(w.to, o)}`; }
    return S.range > 0 ? `last ${S.range} days` : 'all time';
  }

  function filtered(ignoreRange) {
    const q = S.q.trim().toLowerCase();
    const w = ignoreRange ? null : getWindow();
    return ROWS.filter((r) =>
      (ignoreRange || w.all || (r.ts >= w.from && r.ts < w.end)) &&
      (S.ws === 'all' || r.ws === S.ws) &&
      (S.model === 'all' || r.ov || r.p.model === S.model) &&
      (S.tag === 'all' || r.ov || r.p.tag === S.tag) &&
      (S.phase === 'all' || r.ov || Core.phaseOf(STORE, r) === S.phase) &&
      matches(r, q));
  }

  /* ---------- rendering ---------- */
  function render(opts) {
    const app = $('#app');
    const active = document.activeElement;
    const fid = (active && active.dataset && active.dataset.fid) || null;
    AFTER = null;
    if (!DATA) { app.innerHTML = skeleton(); } else {
      const r = S.route;
      app.innerHTML = r.name === 'stories' ? storiesPage()
        : r.name === 'story' ? storyPage(r.id)
          : r.name === 'session' ? sessionPage(r.id)
            : r.name === 'prompt' ? promptPage(r.id, r.key)
              : r.name === 'connect' ? connectPage()
                : r.name === 'import' ? importPage()
                  : r.name === 'effort' ? effortPage(r.id)
                    : r.name === 'sync' ? syncPage(r.id)
                      : dashPage();
    }
    bindTop();
    if (AFTER) { AFTER(); }
    ensureLoaded();
    if (opts && opts.focusTitle) {
      const t = $('#page-title'); if (t) { t.focus(); }
      announce(pageName(S.route));
    } else if (fid) {
      const again = [...document.querySelectorAll('[data-fid]')].find((el) => el.dataset.fid === fid);
      if (again) { again.focus(); }
    }
  }

  function announce(text) { let el = $('#live'); if (!el) { el = document.createElement('div'); el.id = 'live'; el.className = 'sr'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); } el.textContent = text; }

  function dashPage() {
    const rows = filtered(false);
    const real = rows.filter((r) => !r.ov);

    if (!DATA.sessions.length) { return header() + emptyState(); }

    const win = getWindow();
    AFTER = () => { drawChart(rows, win); drawHeat(filtered(true)); };
    return header() + toastHtml() + controls() + band(rows, real) + notice(real) +
      `<section class="panel"><h2>Activity <span>${esc(windowLabel(win))}, by workspace, ${esc(unitName())} per ${chartStep(win) === 7 ? 'week' : 'day'}</span></h2><div class="chartbox" id="chart"></div><div class="legend" id="legend"></div></section>` +
      `<div class="grid2"><section class="panel"><h2>Workspaces and repos <span>${esc(unitName())}</span></h2>${workspaces(rows, true)}</section>` +
      `<section class="panel"><h2>What the work was <span>${esc(unitName())}, by prompt type</span></h2>${workTypes(rows, true)}</section></div>` +
      `<section class="panel"><h2>Lifecycle <span>${esc(unitName())}, by phase of the software lifecycle</span></h2>${phasePanel(rows, true)}</section>` +
      `<div class="grid2"><section class="panel heat"><h2>Daily rhythm <span>${esc(unitName())}, last months</span></h2><div id="heat"></div></section>` +
      `<section class="panel"><h2>Models <span>${esc(unitName())}</span></h2>${models(rows, true)}</section></div>` +
      storiesPanel() +
      explorer(rows);
  }

  function skeleton() {
    return header() + `<div class="empty"><h3>Reading your Copilot history</h3><p class="scan-msg">${SCANNING ? `${SCANNING.done} of ${SCANNING.total} sessions` : 'Starting scan'}</p></div>`;
  }

  function header() {
    const sub = DATA
      ? `${DATA.sessions.length} sessions across ${Object.keys(DATA.workspaces).length} workspaces, scanned ${ago(DATA.generatedAt)}`
      : 'Scanning local Copilot logs';
    const onDash = S.route.name === 'dash';
    const title = onDash ? '<h1 id="page-title" tabindex="-1">AI Delivery Insights</h1>' : '<div class="brandname">AI Delivery Insights</div>';
    const acts = (S.route.name !== 'stories' ? '<button class="btn" data-act="nav" data-name="stories">Stories</button>' : '') +
      (S.route.name !== 'connect' ? '<button class="btn" data-act="nav" data-name="connect">Azure DevOps</button>' : '') +
      (onDash ? '<button class="btn" data-act="export">Export CSV</button>' : '') +
      '<button class="btn primary" data-act="rescan">Rescan</button>';
    return `<header class="top"><div class="brand">
      <svg class="logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="7.5"/><path d="M16 16l5.5 5.5"/><path d="M7.5 13v-2M10.5 13V8M13.5 13v-3.5" stroke-width="2"/></svg>
      <div>${title}<p class="sub">${esc(sub)}</p></div></div>
      <div class="actions">${acts}</div></header>${onDash || !DATA ? '' : crumbs()}`;
  }

  function controls() {
    const applied = !!(parseDay(S.from) != null || parseDay(S.to) != null);
    const draftSet = !!(parseDay(dateDraft.from) != null || parseDay(dateDraft.to) != null);
    const dirty = dateDraft.from !== S.from || dateDraft.to !== S.to;
    const todayStr = inputVal(Date.now());
    // quick ranges are shown as inactive while a custom From/To is in force
    const seg = (key, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button data-set="${key}" data-v="${v}" aria-pressed="${!(key === 'range' && applied) && String(S[key]) === String(v)}">${l}</button>`).join('')}</div>`;
    const dates = `<div class="daterange ${applied ? 'on' : ''}" role="group" aria-label="Custom date range">
      <label>From <input class="field" type="date" data-date="from" value="${esc(dateDraft.from)}" max="${todayStr}" /></label>
      <label title="Optional. Leave empty to include everything up to today.">To <input class="field" type="date" data-date="to" value="${esc(dateDraft.to)}" max="${todayStr}" /></label>
      <button class="btn small primary" data-act="applydates" ${draftSet && dirty ? '' : 'disabled'} title="Apply the From/To dates above">Show data</button>
      ${draftSet ? `<button class="btn small" data-act="cleardates">Clear</button>` : '<span class="hint">To is optional</span>'}
      ${applied && !dirty ? `<span class="hint">${S.to ? '' : 'up to today'}</span>` : ''}
    </div>`;
    const wsOpts = wsRank.map((k) => `<option value="${esc(k)}" ${S.ws === k ? 'selected' : ''}>${esc(wsOf(k).name)}</option>`).join('');
    const modelSet = [...new Set(ROWS.filter((r) => !r.ov && r.p.model).map((r) => r.p.model))].sort();
    const mOpts = modelSet.map((m) => `<option value="${esc(m)}" ${S.model === m ? 'selected' : ''}>${esc(m)}</option>`).join('');
    const here = currentKey();
    return `<section class="controls">
      ${seg('range', [[7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'All time']])}
      ${dates}
      ${seg('metric', [['credits', 'Credits'], ['tokens', 'Tokens'], ['prompts', 'Prompts']])}
      <select class="field" data-sel="ws" aria-label="Workspace"><option value="all">All workspaces</option>${wsOpts}</select>
      <select class="field" data-sel="model" aria-label="Model"><option value="all">All models</option>${mOpts}</select>
      ${here ? `<button class="btn ${S.ws === here ? 'chip-on' : ''}" data-act="here" data-key="${esc(here)}" title="Show only this window's workspace: ${esc(wsOf(here).name)}">This workspace <span class="ws-name">${esc(wsOf(here).name)}</span></button>`
        : Core.hasWorkspace(CURRENT) ? `<button class="btn" data-act="here" disabled title="Copilot has no saved chats for this window's workspace yet, so there is nothing to filter to. Other windows' chats are under their own workspaces.">This workspace <span class="ws-name">no chats yet</span></button>` : ''}
      <input class="field" id="q" type="search" placeholder="Search prompts, repos, files" value="${esc(S.q)}" aria-label="Search" />
      ${S.tag !== 'all' ? `<button class="btn chip-on" data-act="cleartag">Type: ${esc(S.tag)} ✕</button>` : ''}
      ${S.phase !== 'all' ? `<button class="btn chip-on" data-act="clearphase">Phase: ${esc(Core.phaseLabel(S.phase))} ✕</button>` : ''}
    </section>`;
  }

  /** The scanned workspace that is THIS window (see StoryCore.currentWorkspaceKey for the rules), or null. */
  function currentKey() { return DATA ? Core.currentWorkspaceKey(DATA.workspaces, CURRENT) : null; }

  function band(rows, real) {
    let credits = 0, inT = 0, outT = 0;
    rows.forEach((r) => { credits += r.p.credits; inT += r.p.inTok; outT += r.p.outTok; });
    const prompts = real.length;
    const sessions = new Set(real.map((r) => r.s.id)).size;
    const avg = prompts ? credits / prompts : 0;
    let meter = '';
    if (ALLOWANCE > 0) {
      const now = new Date();
      const from = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      let used = 0;
      ROWS.forEach((r) => { if (r.ts >= from) { used += r.p.credits; } });
      const pct = Math.min(100, (used / ALLOWANCE) * 100);
      meter = `<div class="meter ${used > ALLOWANCE ? 'over' : ''}"><span class="l" style="color:var(--mute)">This month: ${fmtC(used)} of ${fmtC(ALLOWANCE)} included credits (${Math.round((used / ALLOWANCE) * 100)}%), all workspaces</span><div class="bar"><i style="width:${pct}%"></i></div></div>`;
    }
    return `<section class="band">
      <div class="hero"><div class="big">${fmtC(credits)}<span class="unit">credits</span></div><div class="usd">about ${usd(credits)}</div></div>
      <div class="stat"><div class="v">${prompts.toLocaleString()}</div><div class="l">prompts</div><div class="d">${sessions.toLocaleString()} sessions</div></div>
      <div class="stat"><div class="v">${fmtN(inT + outT)}</div><div class="l">tokens</div><div class="d">${fmtN(inT)} in, ${fmtN(outT)} out</div></div>
      <div class="stat"><div class="v">${fmtC(avg)}</div><div class="l">credits per prompt</div><div class="d">${prompts ? usd(avg) : '-'} each</div></div>
      ${meter}</section>`;
  }

  function notice(real) {
    if (!real.length) { return ''; }
    const q = { exact: 0, tokens: 0, estimated: 0 };
    real.forEach((r) => { q[r.p.quality]++; });
    if (q.exact === real.length) { return ''; }
    const pct = Math.round((q.exact / real.length) * 100);
    return `<div class="notice"><p><b>${pct}% of these prompts have billed data.</b> ${q.tokens} have real token counts priced from model rates, and ${q.estimated} are estimated from text length (shown with ~).</p>
      <details><summary>How are these numbers calculated?</summary><ul>
        <li><b>Billed</b>: Copilot recorded the credits this request cost, already worked out for the model and reasoning effort used (from the chat log, or its debug log). This is the number to trust.</li>
        <li><b>Tokens</b>: token counts exist but no billed cost, so credits are priced from model rates (editable in settings).</li>
        <li><b>Estimated</b>: only the chat text was saved. Tokens are guessed from text length plus conversation history, so treat these as rough what-if figures. Before June 1, 2026 Copilot billed premium requests rather than credits.</li></ul></details></div>`;
  }

  /* --- workspace / type / model lists --- */
  function aggregate(rows, keyFn) {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      if (k == null) { continue; }
      const e = m.get(k) || { k, v: 0, n: 0 };
      e.v += val(r); if (!r.ov) { e.n++; }
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.v - a.v);
  }

  const itemOpen = (inter, act, key, on) => (inter ? `<button class="item ${on ? 'on' : ''}" data-act="${act}" data-key="${esc(key)}">` : '<div class="item static">');
  const itemClose = (inter) => (inter ? '</button>' : '</div>');

  function workspaces(rows, inter) {
    const agg = aggregate(rows, (r) => r.ws);
    if (!agg.length) { return '<div class="empty">No data in this range.</div>'; }
    const max = agg[0].v || 1;
    return `<div class="list">${agg.slice(0, 8).map((e) => {
      const w = wsOf(e.k);
      const repos = w.repos || [];
      const first = repos[0];
      const branches = repos.slice(0, 2).map((r) => r.branch ? `<span class="branch">${esc(r.branch)}</span>` : '').join(' ');
      const meta = [first ? (first.remote || first.name) : (w.remote || w.path || ''), repos.length > 1 ? `+${repos.length - 1} more repo${repos.length > 2 ? 's' : ''}` : ''].filter(Boolean).join(', ');
      return `${itemOpen(inter, 'ws', e.k, S.ws === e.k)}
        <span class="name"><i class="dot" style="background:${wsColor(e.k)}"></i><span class="t">${esc(w.name)}</span>${w.remote ? `<span class="pill">${esc(w.remote)}</span>` : ''} ${branches}</span>
        <span class="val">${fmtV(e.v)}</span>
        <span class="meta">${esc(meta)}${meta ? ', ' : ''}${np(e.n, 'prompt')}</span>
        <span class="track"><i style="width:${(e.v / max) * 100}%;background:${wsColor(e.k)}"></i></span>${itemClose(inter)}`;
    }).join('')}${agg.length > 8 ? `<div class="more" style="color:var(--mute)">${agg.length - 8} smaller workspaces not shown. Use the workspace filter above.</div>` : ''}</div>`;
  }

  function workTypes(rows, inter) {
    const agg = aggregate(rows.filter((r) => !r.ov), (r) => r.p.tag);
    if (!agg.length) { return '<div class="empty">No data in this range.</div>'; }
    const max = agg[0].v || 1;
    return `<div class="list">${agg.map((e) => `${itemOpen(inter, 'tag', e.k, S.tag === e.k)}
      <span class="name"><span class="t">${esc(e.k)}</span></span><span class="val">${fmtV(e.v)}</span>
      <span class="meta">${np(e.n, 'prompt')}</span><span class="track"><i style="width:${(e.v / max) * 100}%;background:var(--accent)"></i></span>${itemClose(inter)}`).join('')}</div>`;
  }

  /* ---------- lifecycle phase ---------- */
  const PHASE_COLOR = { analysis: '#5ab7f2', plan: '#b58cf3', build: '#7c8cff', test: '#35cdb0', bugfix: '#e86f93', review: '#f2a65a', refactor: '#9acd5a', docs: '#d4b24c', release: '#e07b53', other: OTHER };

  function phasePill(r) {
    const k = Core.phaseOf(STORE, r);
    if (!k) { return ''; }
    const manual = Core.phaseSource(STORE, r) === 'manual';
    return `<span class="pill phase ${manual ? 'manual' : ''}" title="${manual ? 'Lifecycle phase, set by you' : 'Lifecycle phase, guessed from the prompt (a rule of thumb). Change it on the prompt page.'}">${esc(Core.phaseLabel(k))}${manual ? ' •' : ''}</span>`;
  }

  /** The lifecycle, in order: a stacked bar and one row per phase. Click a row (dashboard) to filter. */
  function phasePanel(rows, inter) {
    const by = Core.byPhase(rows.filter((r) => !r.ov), STORE);
    if (!by.length) { return '<div class="empty">No data in this range.</div>'; }
    const v = (e) => (S.metric === 'credits' ? e.credits : S.metric === 'tokens' ? e.tokens : e.prompts);
    const total = by.reduce((a, e) => a + v(e), 0) || 1;
    const max = Math.max(...by.map(v)) || 1;
    return `<div class="stackbar" role="img" aria-label="${esc(by.map((e) => `${e.label} ${Math.round((v(e) / total) * 100)}%`).join(', '))}">${by.map((e) => `<i title="${esc(e.label)}" style="width:${(v(e) / total) * 100}%;background:${PHASE_COLOR[e.k] || OTHER}"></i>`).join('')}</div>
      <div class="list">${by.map((e) => `${itemOpen(inter, 'phase', e.k, S.phase === e.k)}
        <span class="name"><i class="dot" style="background:${PHASE_COLOR[e.k] || OTHER}"></i><span class="t">${esc(e.label)}</span></span><span class="val">${fmtV(v(e))}</span>
        <span class="meta">${np(e.prompts, 'prompt')}, ${Math.round((v(e) / total) * 100)}% of ${esc(unitName())}</span><span class="track"><i style="width:${(v(e) / max) * 100}%;background:${PHASE_COLOR[e.k] || OTHER}"></i></span>${itemClose(inter)}`).join('')}</div>
      <p class="hint">Phases are guessed from the prompt's wording and Copilot's Plan agent, so treat them as a rule of thumb. A dot after a phase means you set it yourself.</p>`;
  }

  /** A <select> of phases. ctx: 'prompt' | 'session'. value: a phase key, '__auto__' or ''. */
  function phaseSelect(o) {
    const opts = [];
    if (o.placeholder) { opts.push(['', o.placeholder]); }
    opts.push(['__auto__', o.autoLabel || 'Automatic']);
    Core.PHASES.forEach(([k, l]) => opts.push([k, l]));
    return `<select class="field small" data-sel-phase data-ctx="${esc(o.ctx)}" data-sid="${esc(o.sid)}" data-pk="${esc(o.pk || '')}" data-fid="${esc(o.fid)}" aria-label="${esc(o.label || 'Lifecycle phase')}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === o.value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  }

  function onPhaseChoice(sel) {
    const sid = sel.dataset.sid, v = sel.value;
    if (!v) { return; }
    const phase = v === '__auto__' ? 'auto' : v;
    if (sel.dataset.ctx === 'prompt') { sendOp({ type: 'tagPhase', sessionId: sid, keys: [sel.dataset.pk], phase }); return; }
    const keys = (BY_SESSION.get(sid) || []).filter((r) => !r.ov).map((r) => Core.promptKey(r.p));
    if (keys.length) { sendOp({ type: 'tagPhase', sessionId: sid, keys, phase }); }
  }

  function models(rows, inter) {
    const agg = aggregate(rows.filter((r) => !r.ov && r.p.model), (r) => r.p.model);
    if (!agg.length) { return '<div class="empty">No model data.</div>'; }
    const total = agg.reduce((a, e) => a + e.v, 0) || 1;
    const col = (i) => (i < PALETTE.length ? PALETTE[i] : OTHER);
    return `<div class="stackbar">${agg.map((e, i) => `<i title="${esc(e.k)}" style="width:${(e.v / total) * 100}%;background:${col(i)}"></i>`).join('')}</div>
      <div class="list">${agg.slice(0, 8).map((e, i) => `${itemOpen(inter, 'model', e.k, S.model === e.k)}
        <span class="name"><i class="dot" style="background:${col(i)}"></i><span class="t">${esc(e.k)}</span></span><span class="val">${fmtV(e.v)}</span>
        <span class="meta">${np(e.n, 'prompt')}, ${Math.round((e.v / total) * 100)}% of ${esc(unitName())}</span>${itemClose(inter)}`).join('')}</div>`;
  }

  function agents(rows) {
    const agg = aggregate(rows.filter((r) => !r.ov && r.p.agent), (r) => r.p.agent);
    if (!agg.length) { return '<div class="empty">No agent data.</div>'; }
    const max = agg[0].v || 1;
    return `<div class="list">${agg.slice(0, 8).map((e) => `<div class="item static"><span class="name"><span class="t">${esc(e.k)}</span></span><span class="val">${fmtV(e.v)}</span>
      <span class="meta">${np(e.n, 'prompt')}</span><span class="track"><i style="width:${(e.v / max) * 100}%;background:var(--accent)"></i></span></div>`).join('')}</div>`;
  }

  /* --- session explorer --- */
  function explorer(rows) {
    const body = S.tab === 'sessions' ? sessionList(rows) : costliest(rows);
    return `<section class="panel"><div class="tabs" role="tablist">
      <button role="tab" data-act="tab" data-key="sessions" aria-selected="${S.tab === 'sessions'}">Sessions</button>
      <button role="tab" data-act="tab" data-key="top" aria-selected="${S.tab === 'top'}">Costliest prompts</button></div>${body}</section>`;
  }

  const qBadge = (p) => {
    const t = { exact: ['billed', 'Credits come from Copilot\'s own per-call billing record.'], tokens: ['tokens', 'Real token counts, credits priced from model rates.'], estimated: ['~ est.', 'Estimated from text length. Rough figure.'] }[p.quality];
    return `<span class="pill q-${p.quality}" title="${esc(t[1])}">${t[0]}</span>`;
  };

  function sessionList(rows) {
    const by = new Map();
    for (const r of rows) {
      let g = by.get(r.s.id);
      if (!g) { g = { s: r.s, rows: [], credits: 0, tokens: 0, prompts: 0, est: false }; by.set(r.s.id, g); }
      g.rows.push(r); g.credits += r.p.credits; g.tokens += r.p.inTok + r.p.outTok;
      if (!r.ov) { g.prompts++; if (r.p.quality === 'estimated') { g.est = true; } }
    }
    const groups = [...by.values()].filter((g) => g.prompts).sort((a, b) => (b.s.last || 0) - (a.s.last || 0));
    if (!groups.length) { return '<div class="empty">No sessions match these filters.</div>'; }
    const out = groups.slice(0, S.shown).map((g) => {
      const open = expanded.has(g.s.id);
      const w = wsOf(g.s.wsKey);
      const when = g.s.last ? fDate(g.s.last, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      return `<div class="sess ${open ? 'open' : ''}">
        <button class="head" data-act="sess" data-key="${esc(g.s.id)}" aria-expanded="${open}">
          <span class="chev">▸</span>
          <span class="stitle"><div class="t">${esc(g.s.title)}</div><div class="m"><i class="dot" style="background:${wsColor(g.s.wsKey)}"></i>${esc(w.name)}<span>${esc(when)}</span>${sessionPill(g.s)}</div></span>
          <span class="num hide-s">${np(g.prompts, 'prompt')}</span><span class="num hide-s">${fmtN(g.tokens)} tokens</span>
          <span class="num c">${g.est ? '~' : ''}${fmtC(g.credits)} cr</span><span class="hide-s">${g.est ? '<span class="pill q-estimated">~ est.</span>' : '<span class="pill q-exact">billed</span>'}</span>
        </button>${open ? sessionBody(g, w) : ''}</div>`;
    }).join('');
    const more = groups.length > S.shown ? `<button class="btn more" data-act="more">Show ${Math.min(25, groups.length - S.shown)} more of ${groups.length - S.shown} remaining</button>` : '';
    return out + more;
  }

  function sessionBody(g, w) {
    const rows = g.rows.slice().sort((a, b) => a.ts - b.ts);
    const actions = `<div class="sactions"><button class="btn small" data-act="nav" data-name="session" data-id="${esc(g.s.id)}">Open session page</button>
      <label class="inl">Story ${storySelect({ ctx: 'session', sid: g.s.id, value: sessionValue(g.s), fid: 'ss-' + g.s.id })}</label>
      ${w.local ? `<button class="btn small" data-act="open-ws" data-path="${esc(w.path)}">Open workspace folder</button>` : ''}
      ${g.s.file ? `<button class="btn small" data-act="reveal" data-path="${esc(g.s.file)}">Reveal session file</button>` : ''}
      <span>${esc(g.s.edition)}${w.repos && w.repos.length ? ', ' + esc(w.repos.map((r) => r.name + (r.branch ? ' @ ' + r.branch : '')).slice(0, 3).join(', ')) : ''}</span></div>`;
    return `<div class="body">${actions}${rows.map((r) => promptHtml(r)).join('')}</div>`;
  }

  function promptHtml(r, opts) {
    const p = r.p;
    const o = opts || {};
    if (r.ov) {
      return `<div class="prompt"><div><div class="when">Background calls</div><div style="color:var(--mute)">Session titles and any model calls that could not be matched to a prompt (${p.calls} in this session).</div></div>
        <div class="pnum"><div class="c">${fmtC(p.credits)} cr</div><div class="s">${fmtN(p.inTok)} in, ${fmtN(p.outTok)} out</div></div></div>`;
    }
    const id = r.s.id + ':' + p.i;
    const files = (p.files || []).slice(0, 4).map((f) => `<span class="file">${esc(f)}</span>`).join('');
    const edited = (p.edited || []).slice(0, 4).map((f) => `<span class="file edit" title="Edited by Copilot">${esc(f)}</span>`).join('');
    const tools = p.toolCalls ? `<span>${p.toolCalls} tool calls: ${esc(p.tools.map((t) => t[0] + (t[1] > 1 ? ' \u00d7' + t[1] : '')).slice(0, 4).join(', '))}</span>` : '';
    const est = p.quality === 'estimated' ? '~' : '';
    return `<div class="prompt"><div>
      <div class="when"><span>${r.ts ? fDate(r.ts) + ', ' + fTime(r.ts) : ''}</span><span class="pill tag">${esc(p.tag)}</span>${phasePill(r)}${p.model ? `<span class="pill">${esc(p.model)}</span>` : ''}${p.agent ? `<span class="pill">${esc(p.agent)}</span>` : ''}${p.canceled ? '<span class="pill">canceled</span>' : ''}${storyPill(r)}<button class="linkish" data-act="nav" data-name="prompt" data-id="${esc(r.s.id)}" data-key="${esc(Core.promptKey(p))}">Details</button></div>
      <div class="ptext ${openPrompts.has(id) ? 'open' : ''}" data-act="ptext" data-key="${esc(id)}">${esc(p.text) || '<i style="color:var(--mute)">(empty prompt)</i>'}</div>
      <div class="pmeta">${edited}${files}${tools}</div>${o.controls ? `<div class="ptag"><label class="inl">Story ${storySelect({ ctx: 'prompt', sid: r.s.id, pk: Core.promptKey(p), value: promptValue(r), fid: 'ps-' + r.s.id + '-' + Core.promptKey(p), inherit: true })}</label><label class="inl">Phase ${phaseSelect({ ctx: 'prompt', sid: r.s.id, pk: Core.promptKey(p), value: Core.phaseSource(STORE, r) === 'manual' ? Core.phaseOf(STORE, r) : '__auto__', fid: 'pp-' + r.s.id + '-' + Core.promptKey(p), autoLabel: 'Automatic (' + Core.phaseLabel(Core.autoPhase(p)) + ')' })}</label></div>` : ''}</div>
      <div class="pnum"><div class="c">${est}${fmtC(p.credits)} cr</div><div class="s">${fmtN(p.inTok)} in, ${fmtN(p.outTok)} out</div><div class="s">${p.calls ? p.calls + (p.calls === 1 ? ' model call' : ' model calls') : 'no call data'}${p.dur ? ', ' + (p.dur / 1000).toFixed(0) + 's' : ''}</div><div style="margin-top:3px">${qBadge(p)}</div></div></div>`;
  }

  function costliest(rows) {
    const top = rows.filter((r) => !r.ov).sort((a, b) => b.p.credits - a.p.credits).slice(0, 25);
    if (!top.length) { return '<div class="empty">No prompts match these filters.</div>'; }
    return top.map(costRow).join('');
  }

  function emptyState() {
    const src = (DATA.sources || []).map((s) => `<code>${esc(s.dir)}</code>`).join('<br>');
    return `<div class="empty"><h3>No Copilot chat history found</h3>
      <p>AI Delivery Insights looked in:</p><p>${src || 'no VS Code data folders were found'}</p>
      <p>Run <code>AI Delivery Insights: Diagnose</code> from the Command Palette to see what was found.</p></div>`;
  }

  /* ---------- charts ---------- */
  const spanDays = (w) => Math.round((w.to - w.from) / DAY) + 1;
  /** Daily bars up to ~20 weeks, weekly bars beyond that. */
  function chartStep(win) { return spanDays(win || getWindow()) > 140 ? 7 : 1; }

  function drawChart(rows, win) {
    const box = $('#chart');
    if (!box) { return; }
    const W = Math.max(320, box.clientWidth || 800), H = 236;
    const pad = { l: 46, r: 6, t: 8, b: 24 };
    const from = win.from;
    const days = spanDays(win);
    const step = chartStep(win);
    const n = Math.max(1, Math.ceil(days / step));

    const totals = {};
    rows.forEach((r) => { totals[r.ws] = (totals[r.ws] || 0) + val(r); });
    const keys = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
    const top = keys.slice(0, 6);
    const stackKeys = keys.length > 6 ? [...top, '__other'] : top;
    const bs = Array.from({ length: n }, (_, i) => ({ t: addDays(from, i * step), by: {}, total: 0 }));
    for (const r of rows) {
      const i = Math.floor(Math.round((startOfDay(r.ts) - from) / DAY) / step);
      if (i < 0 || i >= n) { continue; }
      const k = top.includes(r.ws) ? r.ws : '__other';
      const v = val(r);
      bs[i].by[k] = (bs[i].by[k] || 0) + v; bs[i].total += v;
    }
    const max = niceMax(Math.max(...bs.map((b) => b.total), 0));
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const bw = iw / n, gap = Math.min(4, Math.max(1, bw * 0.2));
    const barW = Math.min(Math.max(1, bw - gap), 64); // a one-day chart must not become one slab
    const y = (v) => pad.t + ih - (v / max) * ih;

    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Usage over time">`;
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      svg += `<g class="grid"><line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/></g><g class="axis"><text x="${pad.l - 8}" y="${y(v) + 3.5}" text-anchor="end">${fmtV(v)}</text></g>`;
    }
    const every = Math.max(1, Math.ceil(n / Math.floor(iw / 62)));
    bs.forEach((b, i) => {
      let acc = 0;
      const x = pad.l + i * bw + (bw - barW) / 2;
      for (const k of stackKeys) {
        const v = b.by[k]; if (!v) { continue; }
        const h = (v / max) * ih;
        svg += `<rect x="${x.toFixed(1)}" y="${(y(acc + v)).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" rx="1.5" fill="${k === '__other' ? OTHER : wsColor(k)}"/>`;
        acc += v;
      }
      if (i % every === 0) { svg += `<g class="axis"><text x="${(x + barW / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle">${fDate(b.t)}</text></g>`; }
    });
    svg += `<rect id="hov" x="0" y="${pad.t}" width="${bw}" height="${ih}" fill="var(--accent)" fill-opacity="0.10" visibility="hidden"/></svg><div class="tip" id="tip" hidden></div>`;
    box.innerHTML = svg;

    $('#legend').innerHTML = stackKeys.map((k) => `<span><i class="dot" style="background:${k === '__other' ? OTHER : wsColor(k)}"></i>${esc(k === '__other' ? 'Other workspaces' : wsOf(k).name)}</span>`).join('');

    const svgEl = $('svg', box), hov = $('#hov'), tip = $('#tip');
    svgEl.addEventListener('mousemove', (ev) => {
      const rect = svgEl.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W;
      const i = Math.floor((px - pad.l) / bw);
      if (i < 0 || i >= n) { hov.setAttribute('visibility', 'hidden'); tip.hidden = true; return; }
      const b = bs[i];
      hov.setAttribute('x', pad.l + i * bw); hov.setAttribute('width', bw); hov.setAttribute('visibility', 'visible');
      const label = step === 1 ? fDate(b.t, { weekday: 'short', month: 'short', day: 'numeric' }) : `${fDate(b.t)} to ${fDate(addDays(b.t, step - 1))}`;
      tip.innerHTML = `<b>${esc(label)}</b>` + (b.total ? stackKeys.filter((k) => b.by[k]).map((k) => `<div class="row"><i class="dot" style="background:${k === '__other' ? OTHER : wsColor(k)}"></i><span>${esc(k === '__other' ? 'Other' : wsOf(k).name)}</span><span>${fmtV(b.by[k])}</span></div>`).join('') + `<div class="row" style="margin-top:4px"><span>Total</span><span><b style="display:inline">${fmtV(b.total)} ${esc(unitName())}</b></span></div>` : '<div style="color:var(--mute)">No activity</div>');
      tip.hidden = false;
      const bx = ev.clientX - box.getBoundingClientRect().left;
      tip.style.left = Math.min(Math.max(0, bx + 14), box.clientWidth - tip.offsetWidth) + 'px';
      tip.style.top = '8px';
    });
    svgEl.addEventListener('mouseleave', () => { hov.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  }

  function drawHeat(rows) {
    const box = $('#heat');
    if (!box) { return; }
    const cell = 12, gap = 3, left = 26, top = 16;
    const avail = Math.max(260, box.clientWidth || 600);
    const weeks = Math.max(12, Math.min(53, Math.floor((avail - left) / (cell + gap))));
    const today = startOfDay(Date.now());
    const dow = new Date(today).getDay();
    const start = addDays(today, -dow - (weeks - 1) * 7);
    const map = new Map();
    for (const r of rows) {
      const k = dkey(r.ts); const e = map.get(k) || { v: 0, n: 0 };
      e.v += val(r); if (!r.ov) { e.n++; }
      map.set(k, e);
    }
    const vals = [...map.values()].map((e) => e.v).filter((v) => v > 0).sort((a, b) => a - b);
    const q = (f) => vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * f))] : 0;
    const t1 = q(0.25), t2 = q(0.5), t3 = q(0.8);
    let svg = `<svg width="${left + weeks * (cell + gap)}" height="${top + 7 * (cell + gap)}" role="img" aria-label="Daily activity heatmap">`;
    ['Mon', 'Wed', 'Fri'].forEach((d, i) => { svg += `<text x="0" y="${top + (i * 2 + 1) * (cell + gap) + cell - 2}">${d}</text>`; });
    let lastMonth = -1, lastYear = -1;
    for (let c = 0; c < weeks; c++) {
      const d0 = addDays(start, c * 7);
      const dt0 = new Date(d0);
      const m = dt0.getMonth(), y = dt0.getFullYear();
      if (m !== lastMonth) {
        // the year shows next to the first month on the grid, and again whenever the grid crosses into a new year
        const label = y !== lastYear ? fDate(d0, { month: 'short', year: 'numeric' }) : fDate(d0, { month: 'short' });
        svg += `<text x="${left + c * (cell + gap)}" y="9">${label}</text>`; lastMonth = m; lastYear = y;
      }
      for (let r = 0; r < 7; r++) {
        const day = addDays(d0, r);
        if (day > today) { continue; }
        const e = map.get(dkey(day));
        const v = e ? e.v : 0;
        const lvl = !v ? 0 : v <= t1 ? 1 : v <= t2 ? 2 : v <= t3 ? 3 : 4;
        svg += `<rect class="cell${lvl ? '-l' + lvl : '0'}" x="${left + c * (cell + gap)}" y="${top + r * (cell + gap)}" width="${cell}" height="${cell}" rx="3"><title>${esc(fDate(day, { weekday: 'short', month: 'short', day: 'numeric' }))}: ${v ? fmtV(v) + ' ' + unitName() + ', ' + e.n + ' prompts' : 'no activity'}</title></rect>`;
      }
    }
    box.innerHTML = svg + '</svg>';
  }

  /* ====================================================================== */
  /* Stories: tagging prompts with user stories, per-story totals, pages     */
  /* ====================================================================== */

  const storyList = () => Object.values(STORE.stories);
  const storyById = (id) => (typeof id === 'string' && Core.hasOwn(STORE.stories, id) ? STORE.stories[id] : null);
  const byId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });
  const pct = (x) => Math.round(x * 100) + '%';
  const np = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

  /** Rows the story pages count: everything, or only the dashboard's date window. Other dashboard filters never apply. */
  function scopeRows() {
    if (S.storyWin !== 'dash') { return ROWS; }
    const w = getWindow();
    return w.all ? ROWS : ROWS.filter((r) => r.ts >= w.from && r.ts < w.end);
  }

  function storyPill(r) {
    const st = storyById(Core.storyOf(STORE, r));
    if (!st) { return ''; }
    const own = Core.sourceOf(STORE, r) === 'override';
    return `<span class="pill story" title="${esc(st.title)}${own ? ' (set on this prompt)' : ''}">${esc(st.id)}${own ? ' •' : ''}</span>`;
  }
  function sessionPill(s) {
    const st = Core.hasOwn(STORE.sessionTags, s.id) ? storyById(STORE.sessionTags[s.id]) : null;
    return st ? `<span class="pill story" title="${esc(st.title)}">${esc(st.id)}</span>` : '';
  }
  const sessionValue = (s) => (Core.hasOwn(STORE.sessionTags, s.id) ? STORE.sessionTags[s.id] : '__none__');
  function promptValue(r) {
    if (Core.sourceOf(STORE, r) !== 'override') { return '__inherit__'; }
    const id = Core.storyOf(STORE, r);
    return id == null ? '__none__' : id;
  }

  /** A <select> of stories. ctx: 'session' | 'prompt' | 'bulk'. */
  function storySelect(o) {
    const opts = [];
    if (o.placeholder) { opts.push(['', o.placeholder]); }
    if (o.inherit) { opts.push(['__inherit__', 'Same as session']); }
    if (!o.noNone) { opts.push(['__none__', 'No story']); }
    storyList().sort(byId).forEach((st) => opts.push([st.id, clip(`${st.id}  ${st.title}`, 60)]));
    opts.push(['__new__', '+ New story…']);
    return `<select class="field small" data-sel-story data-ctx="${esc(o.ctx)}" data-sid="${esc(o.sid || '')}" data-pk="${esc(o.pk || '')}" data-fid="${esc(o.fid)}" aria-label="${esc(o.label || 'Story')}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === o.value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  }

  const toastHtml = () => (S.toast ? `<div class="toast ${S.toast.ok ? 'ok' : 'err'}" role="status"><span>${esc(S.toast.text)}</span><button class="linkish" data-act="toastx" aria-label="Dismiss message">Dismiss</button></div>` : '');

  const segHtml = (key, opts, cur) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button data-set="${key}" data-v="${v}" aria-pressed="${String(cur) === String(v)}">${l}</button>`).join('')}</div>`;

  /* ---------- navigation ---------- */
  const sameRoute = (a, b) => !!a && !!b && a.name === b.name && a.id === b.id && a.key === b.key;

  function pageName(r) {
    if (r.name === 'stories') { return 'Stories'; }
    if (r.name === 'story') { const st = storyById(r.id); return st ? `Story ${st.id}: ${st.title}` : 'Story not found'; }
    if (r.name === 'session') { const s = SESS.get(r.id); return s ? `Session: ${s.title}` : 'Session not found'; }
    if (r.name === 'prompt') { return 'Prompt details'; }
    if (r.name === 'connect') { return 'Azure DevOps connection'; }
    if (r.name === 'import') { return 'Import stories from Azure DevOps'; }
    if (r.name === 'effort') { const st = storyById(r.id); return st ? `Effort without AI: story ${st.id}` : 'Story not found'; }
    if (r.name === 'sync') { const st = storyById(r.id); return st ? `Sync story ${st.id} to Azure DevOps` : 'Story not found'; }
    return 'Dashboard';
  }
  function crumbLabel(r) {
    if (r.name === 'dash') { return 'Dashboard'; }
    if (r.name === 'stories') { return 'Stories'; }
    if (r.name === 'story') { return 'Story ' + r.id; }
    if (r.name === 'connect') { return 'Azure DevOps'; }
    if (r.name === 'import') { return 'Import'; }
    if (r.name === 'effort') { return 'Effort'; }
    if (r.name === 'sync') { return 'Sync'; }
    if (r.name === 'session') { const s = SESS.get(r.id); return s ? clip(s.title, 32) : 'Session'; }
    return 'Prompt';
  }

  function crumbs() {
    const trail = S.hist.concat([S.route]);
    const items = trail.map((r, i) => (i === trail.length - 1
      ? `<li aria-current="page">${esc(crumbLabel(r))}</li>`
      : `<li><button class="linkish" data-act="crumb" data-i="${i}">${esc(crumbLabel(r))}</button></li>`)).join('<li class="sep" aria-hidden="true">›</li>');
    return `<nav class="crumbs" aria-label="Breadcrumb"><button class="btn small" data-act="back" title="Back (Esc or Alt+Left)">← Back</button><ol>${items}</ol></nav>`;
  }

  /** Move to a page. Going to a page already in the trail returns to it instead of growing the trail. */
  function go(route, opts) {
    const r = Core.normalizeRoute(route);
    if (!r) { return; }
    if (r.name === 'dash') { S.hist = []; S.route = r; } else if (!sameRoute(r, S.route)) {
      const at = S.hist.findIndex((x) => sameRoute(x, r));
      if (at >= 0) { S.hist = S.hist.slice(0, at); } else if (!(opts && opts.replace)) { S.hist = S.hist.concat([S.route]).slice(-7); }
      S.route = r;
    }
    afterNav();
  }
  function back() {
    if (!S.hist.length) { if (S.route.name !== 'dash') { go({ name: 'dash' }); } return; }
    S.route = S.hist[S.hist.length - 1]; S.hist = S.hist.slice(0, -1);
    afterNav();
  }
  function goCrumb(i) {
    const r = S.hist[i]; if (!r) { return; }
    S.hist = S.hist.slice(0, i); S.route = r;
    afterNav();
  }
  function afterNav() {
    S.toast = null; S.form = null; S.sel = new Set(); S.confirmDelete = ''; S.shown = 25; S.uShown = 25;
    resetAdoPages();
    persist(); render({ focusTitle: true }); window.scrollTo(0, 0);
  }

  /* ---------- editing ---------- */
  function sendOp(op) { PENDING = ++RID; vscode.postMessage({ type: 'story', rid: PENDING, op }); }

  function openForm(f) {
    S.form = Object.assign({ mode: 'new', id: '', title: '', points: '', budget: '', group: '', adoId: '', err: '', apply: null, label: '' }, f);
    render();
    const el = [...document.querySelectorAll('[data-fid]')].find((x) => x.dataset.fid === (S.form.mode === 'edit' ? 'f-title' : 'f-id'));
    if (el) { el.focus(); }
    window.scrollTo(0, 0);
  }

  function formHtml() {
    const f = S.form; if (!f) { return ''; }
    const groups = [...new Set(storyList().map((x) => x.group).filter(Boolean))].sort();
    return `<form class="sform panel" data-form="story" novalidate aria-labelledby="form-h">
      <h2 id="form-h">${f.mode === 'edit' ? 'Edit story' : 'New story'}<span>${esc(f.label || '')}</span></h2>
      <div class="fgrid">
        <label>Story ID<input class="field" data-fid="f-id" data-f="id" value="${esc(f.id)}" ${f.mode === 'edit' ? 'readonly' : ''} maxlength="40" placeholder="1234 or AB#1234" autocomplete="off"></label>
        <label class="wide">Title<input class="field" data-fid="f-title" data-f="title" value="${esc(f.title)}" maxlength="120" autocomplete="off"></label>
        <label>Story points <small>optional</small><input class="field" data-fid="f-points" data-f="points" value="${esc(f.points)}" inputmode="decimal" autocomplete="off"></label>
        <label>Credit budget <small>optional</small><input class="field" data-fid="f-budget" data-f="budget" value="${esc(f.budget)}" inputmode="decimal" autocomplete="off"></label>
        <label>Group <small>sprint, feature or epic; optional</small><input class="field" data-fid="f-group" data-f="group" value="${esc(f.group)}" maxlength="60" list="groups" autocomplete="off"></label>
        <label>Azure DevOps number <small>optional; the story ID is used if it is just a number</small><input class="field" data-fid="f-ado" data-f="adoId" value="${esc(f.adoId)}" inputmode="numeric" maxlength="9" autocomplete="off"></label>
        <datalist id="groups">${groups.map((g) => `<option value="${esc(g)}"></option>`).join('')}</datalist>
      </div>
      ${f.err ? `<p class="ferr" role="alert">${esc(f.err)}</p>` : ''}
      <div class="factions"><button type="submit" class="btn primary" data-fid="f-save">Save</button><button type="button" class="btn" data-act="formcancel">Cancel</button></div>
    </form>`;
  }

  function submitForm() {
    const f = S.form; if (!f) { return; }
    const r = Core.normalizeStory({ id: f.id, title: f.title, points: f.points, budget: f.budget, group: f.group, adoId: f.adoId });
    if (!r.ok) { f.err = r.error; render(); return; }
    if (f.mode === 'new' && storyById(r.story.id)) { f.err = `A story with ID ${r.story.id} already exists.`; render(); return; }
    f.err = '';
    sendOp({ type: 'saveStory', mode: f.mode, story: r.story, apply: f.apply || undefined });
  }

  /** The person chose a story in a <select>. */
  function onStoryChoice(sel) {
    const ctx = sel.dataset.ctx, sid = sel.dataset.sid, pk = sel.dataset.pk, v = sel.value;
    if (ctx === 'bulk') {
      if (v === '__new__') {
        if (!S.sel.size) { S.toast = { ok: false, text: 'Tick the sessions first, then create the story.' }; render(); return; }
        openForm({ label: `will tag ${S.sel.size} session${S.sel.size === 1 ? '' : 's'}`, apply: { kind: 'sessions', ids: [...S.sel], onlyUntagged: true } }); return;
      }
      S.bulk = v; render(); return;
    }
    if (ctx === 'session') {
      if (v === '__new__') { openForm({ label: 'will tag this session', apply: { kind: 'sessions', ids: [sid] } }); return; }
      sendOp({ type: 'tagSessions', ids: [sid], storyId: v === '__none__' ? null : v }); return;
    }
    if (ctx === 'prompt') {
      if (v === '__new__') { openForm({ label: 'will tag this prompt', apply: { kind: 'prompt', sessionId: sid, key: pk } }); return; }
      let value = v === '__inherit__' ? 'inherit' : v === '__none__' ? 'none' : v;
      if (value !== 'inherit' && value !== 'none' && Core.hasOwn(STORE.sessionTags, sid) && STORE.sessionTags[sid] === value) { value = 'inherit'; }
      sendOp({ type: 'tagPrompt', sessionId: sid, key: pk, value });
    }
  }

  function onStories(m) {
    STORE = Core.normalizeStore(m.store);
    const res = m.result;
    let toast = null;
    if (res && PENDING && res.rid === PENDING) {
      PENDING = 0;
      if (res.ok) { toast = { ok: true, text: res.message }; S.form = null; S.sel = new Set(); S.confirmDelete = ''; if (ADO.effort) { ADO.effort.manual = ''; ADO.effort.note = ''; ADO.effort.merr = ''; } } else if (S.form) { S.form.err = res.error; } else { toast = { ok: false, text: res.error }; }
    }
    if (DATA && S.route.name === 'story' && !storyById(S.route.id) && toast && toast.ok) { go({ name: 'stories' }); }
    if (toast) { S.toast = toast; announce(toast.text); }
    if (DATA) { render(); }
  }

  /** Sessions in the current view that have no session-level story, newest first. */
  function untaggedList() {
    const bySess = new Map();
    for (const r of scopeRows()) { const a = bySess.get(r.s.id); if (a) { a.push(r); } else { bySess.set(r.s.id, [r]); } }
    const out = [];
    for (const [sid, rs] of bySess) {
      if (Core.hasOwn(STORE.sessionTags, sid)) { continue; }
      const s = SESS.get(sid); if (!s || !rs.some((r) => !r.ov)) { continue; }
      out.push({ s, rs, t: Core.totals(rs) });
    }
    return out.sort((x, y) => (y.s.last || 0) - (x.s.last || 0));
  }

  /* ---------- shared bits for story pages ---------- */

  function notFound(kind) {
    return header() + `<section class="panel"><div class="empty"><h3 id="page-title" tabindex="-1">That ${esc(kind)} was not found</h3><p>It may have been deleted, or it is not in the history that was scanned. Try Rescan, or go back.</p><button class="btn" data-act="back">← Back</button></div></section>`;
  }

  function qualityLine(t) {
    if (!t.credits) { return ''; }
    const p = (c) => Math.round((c / t.credits) * 100);
    return `${p(t.q.exact.c + t.bgCredits)}% billed, ${p(t.q.tokens.c)}% priced from token counts, ${p(t.q.estimated.c)}% estimated`;
  }

  function budgetMeter(st, credits) {
    const b = Core.budgetState(st, credits);
    if (b.state === 'none') { return ''; }
    return `<div class="budget ${b.state}"><div class="bar" role="img" aria-label="Budget used ${Math.round(b.pct * 100)} percent"><i style="width:${Math.min(100, b.pct * 100)}%"></i></div>
      <span>${fmtC(credits)} of ${fmtC(st.budget)} credits (${Math.round(b.pct * 100)}%)${b.state === 'over' ? ', over budget' : b.state === 'warn' ? ', nearly used up' : ''}. Counts all time.</span></div>`;
  }

  function suggestionsHtml(s, compact) {
    if (Core.hasOwn(STORE.sessionTags, s.id)) { return ''; }
    const sug = Core.suggestForSession(s, STORE);
    if (!sug.length) { return ''; }
    return `<div class="sugg ${compact ? 'compact' : ''}"><span>${compact ? 'Mentions' : 'This session mentions'}</span>${sug.map((x) => {
      const what = x.strong ? `AB#${x.number}` : `#${x.number}`;
      return x.storyId
        ? `<button class="chip" data-act="sugtag" data-sid="${esc(s.id)}" data-story="${esc(x.storyId)}" title="Found ${esc(what)} in ${x.count} prompt${x.count === 1 ? '' : 's'}">${esc(what)}: tag as ${esc(x.storyId)}</button>`
        : `<button class="chip" data-act="sugnew" data-sid="${esc(s.id)}" data-num="${esc(x.number)}" title="Found ${esc(what)} in ${x.count} prompt${x.count === 1 ? '' : 's'}">${esc(what)}: create story ${esc(x.number)}</button>`;
    }).join('')}</div>`;
  }

  /** Table of "name, prompts, credits per prompt, tokens per prompt" ranked cheapest first. */
  function effTable(list, label) {
    if (!list.length) { return `<p class="hint">Not enough ${esc(label.toLowerCase())} data yet (needs 3 or more prompts each).</p>`; }
    const max = Math.max(...list.map((e) => e.perPrompt)) || 1;
    return `<table class="tbl compact"><thead><tr><th scope="col">${esc(label)}</th><th class="r" scope="col">Prompts</th><th class="r" scope="col">Credits / prompt</th><th class="r hide-s" scope="col">Tokens / prompt</th></tr></thead><tbody>${list.slice(0, 8).map((e) =>
      `<tr><td>${esc(e.k)}</td><td class="r">${e.prompts}</td><td class="r"><span class="inbar"><i style="width:${(e.perPrompt / max) * 100}%"></i></span>${fmtC(e.perPrompt)}</td><td class="r hide-s">${fmtN(e.tokensPerPrompt)}</td></tr>`).join('')}</tbody></table>`;
  }

  function wastePanel(mine) {
    const w = Core.wasteSignals(mine);
    const lowCache = w.cache.share != null && w.cache.base >= 100000 && w.cache.share < 0.2;
    const retryLinks = w.retries.rows.slice(0, 3).map((r) => `<button class="linkish" data-act="nav" data-name="prompt" data-id="${esc(r.s.id)}" data-key="${esc(Core.promptKey(r.p))}">${esc(clip(r.p.text || '(empty)', 40))}</button>`).join(', ');
    return `<section class="panel"><h2>Possible waste <span>rules of thumb, not verdicts</span></h2><ul class="signals">
      <li><b>${w.canceled.n}</b> cancelled prompt${w.canceled.n === 1 ? '' : 's'}${w.canceled.n ? ` (${fmtC(w.canceled.credits)} credits)` : ''}</li>
      <li><b>${w.retries.n}</b> possible retr${w.retries.n === 1 ? 'y' : 'ies'}${w.retries.n ? ` (${fmtC(w.retries.credits)} credits): ${retryLinks}` : ''}<div class="hint">A prompt followed within 10 minutes, in the same session, by one that shares at least 60% of its words.</div></li>
      <li>Cached input: <b>${w.cache.share == null ? 'no data' : pct(w.cache.share)}</b>${lowCache ? ' <span class="pill q-tokens">low</span> Long sessions re-send context; shorter, focused sessions often reuse more of it.' : ''}</li>
      <li>Background calls (session titles and unmatched calls): <b>${pct(w.background.share)}</b> of credits</li></ul></section>`;
  }

  /** A compact row for a prompt (used for "costliest" lists). */
  function costRow(r) {
    const w = wsOf(r.ws);
    return `<div class="prompt"><div><div class="when"><i class="dot" style="background:${wsColor(r.ws)}"></i><span>${esc(w.name)}</span><span>${r.ts ? fDate(r.ts, { month: 'short', day: 'numeric', year: 'numeric' }) : ''}</span><span class="pill tag">${esc(r.p.tag)}</span>${phasePill(r)}${storyPill(r)}<button class="linkish" data-act="nav" data-name="prompt" data-id="${esc(r.s.id)}" data-key="${esc(Core.promptKey(r.p))}">Details</button></div>
      <div class="ptext ${openPrompts.has('t' + r.s.id + r.p.i) ? 'open' : ''}" data-act="ptext" data-key="${esc('t' + r.s.id + r.p.i)}">${esc(r.p.text)}</div>
      <div class="pmeta"><span>Session: ${esc(r.s.title)}</span></div></div>
      <div class="pnum"><div class="c">${r.p.quality === 'estimated' ? '~' : ''}${fmtC(r.p.credits)} cr</div><div class="s">${fmtN(r.p.inTok)} in, ${fmtN(r.p.outTok)} out</div><div style="margin-top:3px">${qBadge(r.p)}</div></div></div>`;
  }

  function storyControls() {
    const note = S.storyWin === 'dash' ? `Showing ${esc(windowLabel(getWindow()))}, the dashboard's date range. Budgets always count all time.` : 'All time. Dashboard filters do not apply here.';
    return `<section class="controls">${segHtml('storyWin', [['all', 'All time'], ['dash', 'Dashboard date range']], S.storyWin)}${S.route.name === 'story' ? segHtml('metric', [['credits', 'Credits'], ['tokens', 'Tokens'], ['prompts', 'Prompts']], S.metric) : ''}<span class="hint">${note}</span></section>`;
  }

  /* ---------- dashboard panel ---------- */
  function storiesPanel() {
    const all = storyList();
    if (!all.length) {
      return `<section class="panel"><h2>Stories <span>cost per user story</span></h2><div class="empty slim"><p>Tag sessions with the user story they belong to, then see credits and tokens per story.</p><button class="btn primary" data-act="nav" data-name="stories">Set up stories</button></div></section>`;
    }
    const g = Core.groupByStory(scopeRows(), STORE);
    const top = all.map((st) => ({ st, t: Core.totals(g.byStory.get(st.id) || []) })).sort((a, b) => b.t.credits - a.t.credits).slice(0, 5);
    const max = top[0].t.credits || 1;
    const untaggedCr = Core.totals(g.untagged).credits;
    return `<section class="panel"><h2>Stories <span>top ${top.length} by credits${S.storyWin === 'dash' ? ', ' + esc(windowLabel(getWindow())) : ', all time'}</span></h2><div class="list">${top.map((e) => `<button class="item" data-act="nav" data-name="story" data-id="${esc(e.st.id)}">
      <span class="name"><span class="t">${esc(e.st.id)} ${esc(e.st.title)}</span></span><span class="val">${fmtC(e.t.credits)}</span>
      <span class="meta">${np(e.t.prompts, 'prompt')}, ${fmtN(e.t.inTok + e.t.outTok)} tokens${e.st.budget ? ', ' + pct(e.t.credits / e.st.budget) + ' of budget' : ''}</span>
      <span class="track"><i style="width:${(e.t.credits / max) * 100}%;background:var(--accent)"></i></span></button>`).join('')}</div>
      <div class="panelfoot"><span class="hint">${fmtC(untaggedCr)} credits are not on any story.</span><button class="btn small" data-act="nav" data-name="stories">All stories</button></div></section>`;
  }

  /* ====================== Stories list page ====================== */
  /** The Azure DevOps column: the work item, its state, and when this machine last synced it. */
  function adoCell(st) {
    const num = Core.adoIdOf(st);
    if (num == null) { return '-'; }
    const link = adoLink(st.id);
    return `#${num}${link && link.state ? ` <span class="pill">${esc(link.state)}</span>` : ''}${link && link.syncedAt ? `<div class="m">synced ${esc(ago(link.syncedAt))}</div>` : ''}`;
  }

  function storiesPage() {
    const rows = scopeRows();
    const g = Core.groupByStory(rows, STORE);
    const life = S.storyWin === 'dash' ? Core.groupByStory(ROWS, STORE) : g;
    const all = storyList();
    const entries = all.map((st) => { const rs = g.byStory.get(st.id) || []; return { story: st, rows: rs, t: Core.totals(rs), life: Core.totals(life.byStory.get(st.id) || []) }; });
    const groups = [...new Set(all.map((x) => x.group).filter(Boolean))].sort();
    const q = S.sQ.trim().toLowerCase();
    const list = entries.filter((e) => (S.sGroup === 'all' || (S.sGroup === '__none__' ? !e.story.group : e.story.group === S.sGroup)) &&
      (!q || `${e.story.id} ${e.story.title} ${e.story.group}`.toLowerCase().includes(q)));
    const perPt = (e) => (e.story.points ? e.t.credits / e.story.points : -1);
    const sorters = {
      credits: (a, b) => b.t.credits - a.t.credits,
      tokens: (a, b) => (b.t.inTok + b.t.outTok) - (a.t.inTok + a.t.outTok),
      recent: (a, b) => b.t.last - a.t.last,
      perpoint: (a, b) => perPt(b) - perPt(a),
      budget: (a, b) => (b.story.budget ? b.life.credits / b.story.budget : -1) - (a.story.budget ? a.life.credits / a.story.budget : -1),
      id: (a, b) => byId(a.story, b.story),
    };
    list.sort(sorters[S.sSort] || sorters.credits);

    const tagged = Core.totals(entries.reduce((a, e) => a.concat(e.rows), []));
    const untagged = Core.totals(g.untagged);
    const total = tagged.credits + untagged.credits;
    const active = entries.filter((e) => e.t.prompts).length;

    const taggedRows = entries.reduce((a, e) => a.concat(e.rows), []);
    const sortOpts = [['credits', 'Most credits'], ['tokens', 'Most tokens'], ['recent', 'Most recent'], ['perpoint', 'Credits per point'], ['budget', 'Budget used'], ['id', 'ID']];
    const table = !all.length
      ? `<div class="empty slim"><p>No stories yet. Create one, then tag sessions to it below or from any session page.</p></div>`
      : !list.length ? '<div class="empty slim"><p>No stories match.</p></div>'
        : `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Story</th><th class="r" scope="col">Credits</th><th class="r" scope="col">Tokens</th><th class="r hide-s" scope="col">Prompts</th><th class="r hide-s" scope="col">Sessions</th><th class="r hide-s" scope="col">Credits / point</th><th class="hide-s" scope="col">Budget</th><th class="hide-s" scope="col">Last active</th><th class="r hide-s" scope="col">Without AI</th><th class="hide-s" scope="col">Azure DevOps</th></tr></thead><tbody>${list.map((e) => {
          const st = e.story; const est = e.t.q.estimated.n > 0 ? '~' : '';
          const b = Core.budgetState(st, e.life.credits);
          return `<tr class="rowlink" data-act="nav" data-name="story" data-id="${esc(st.id)}" data-story="${esc(st.id)}" data-credits="${e.t.credits.toFixed(4)}" data-tokens="${e.t.inTok + e.t.outTok}" data-prompts="${e.t.prompts}" data-sessions="${e.t.sessions}"><td><button class="linkish strong" data-act="nav" data-name="story" data-id="${esc(st.id)}">${esc(st.id)}</button> <span class="ttl">${esc(st.title)}</span>${st.group ? ` <span class="pill">${esc(st.group)}</span>` : ''}</td>
            <td class="r"><b>${est}${fmtC(e.t.credits)}</b></td><td class="r">${fmtN(e.t.inTok + e.t.outTok)}</td><td class="r hide-s">${e.t.prompts}</td><td class="r hide-s">${e.t.sessions}</td>
            <td class="r hide-s">${st.points ? fmtC(e.t.credits / st.points) : '-'}</td>
            <td class="hide-s">${b.state === 'none' ? '-' : `<span class="budget ${b.state} mini"><span class="bar"><i style="width:${Math.min(100, b.pct * 100)}%"></i></span>${Math.round(b.pct * 100)}%</span>`}</td>
            <td class="hide-s">${e.t.last ? fDate(e.t.last, { month: 'short', day: 'numeric', year: 'numeric' }) : '-'}</td>
            <td class="r hide-s" data-k="effort">${effortOf(st.id) ? esc(fmtH(effortOf(st.id).hours)) : '-'}</td>
            <td class="hide-s" data-k="ado">${adoCell(st)}</td></tr>`;
        }).join('')}</tbody></table></div>`;

    // group roll-up
    const roll = Core.rollupByGroup(entries.map((e) => ({ story: e.story, t: e.t })));
    const rollPanel = groups.length ? `<section class="panel"><h2>By group <span>sprint, feature or epic, as you typed it</span></h2><div class="tbl-wrap"><table class="tbl compact"><thead><tr><th scope="col">Group</th><th class="r" scope="col">Stories</th><th class="r" scope="col">Credits</th><th class="r" scope="col">Tokens</th><th class="r hide-s" scope="col">Points</th><th class="r hide-s" scope="col">Credits / point</th></tr></thead><tbody>${roll.map((r) => `<tr><td>${r.group ? `<button class="linkish" data-act="grp" data-key="${esc(r.group)}">${esc(r.group)}</button>` : '<span class="hint">(no group)</span>'}</td><td class="r">${r.stories}</td><td class="r"><b>${fmtC(r.credits)}</b></td><td class="r">${fmtN(r.tokens)}</td><td class="r hide-s">${r.points || '-'}</td><td class="r hide-s">${r.perPoint == null ? '-' : fmtC(r.perPoint)}</td></tr>`).join('')}</tbody></table></div></section>` : '';

    // untagged sessions
    const sessionsUntagged = untaggedList();
    const uWsKeys = [...new Set(sessionsUntagged.map((x) => x.s.wsKey))].sort((a, b) => wsRank.indexOf(a) - wsRank.indexOf(b));
    if (S.uWs !== 'all' && !uWsKeys.includes(S.uWs)) { S.uWs = 'all'; }
    const ushow = sessionsUntagged.filter((x) => S.uWs === 'all' || x.s.wsKey === S.uWs);
    const allTicked = ushow.length > 0 && ushow.every((x) => S.sel.has(x.s.id));
    const unt = !sessionsUntagged.length
      ? '<div class="empty slim"><p>Every session in this view has a story.</p></div>'
      : `<div class="bulk"><label class="inl"><input type="checkbox" data-act="selall" data-fid="selall" ${allTicked ? 'checked' : ''}> Select all ${ushow.length}</label>
          <label class="inl">Workspace <select class="field small" data-sel="uWs" data-fid="uws" aria-label="Workspace">${'<option value="all">All workspaces</option>' + uWsKeys.map((k) => `<option value="${esc(k)}" ${S.uWs === k ? 'selected' : ''}>${esc(wsOf(k).name)}</option>`).join('')}</select></label>
          <label class="inl">Tag ${S.sel.size} selected as ${storySelect({ ctx: 'bulk', value: S.bulk, fid: 'bulk', placeholder: 'Choose a story…', noNone: true, label: 'Story for selected sessions' })}</label>
          <button class="btn primary small" data-act="bulkapply" ${S.sel.size && S.bulk ? '' : 'disabled'}>Apply</button></div>
        <div class="ulist">${ushow.slice(0, S.uShown).map((x) => `<div class="urow"><input type="checkbox" data-act="selrow" data-key="${esc(x.s.id)}" data-fid="sel-${esc(x.s.id)}" ${S.sel.has(x.s.id) ? 'checked' : ''} aria-label="Select ${esc(x.s.title)}">
          <div class="utitle"><button class="linkish strong" data-act="nav" data-name="session" data-id="${esc(x.s.id)}">${esc(x.s.title)}</button><div class="m"><i class="dot" style="background:${wsColor(x.s.wsKey)}"></i>${esc(wsOf(x.s.wsKey).name)} <span>${x.s.last ? fDate(x.s.last, { month: 'short', day: 'numeric', year: 'numeric' }) : ''}</span></div>${suggestionsHtml(x.s, true)}</div>
          <div class="num">${np(x.t.prompts, 'prompt')}</div><div class="num c">${fmtC(x.t.credits)} cr</div></div>`).join('')}</div>
        ${ushow.length > S.uShown ? `<button class="btn more" data-act="umore">Show ${Math.min(25, ushow.length - S.uShown)} more of ${ushow.length - S.uShown} remaining</button>` : ''}`;

    // efficiency (tagged work only)
    const eff = taggedRows.length ? `<section class="panel"><h2>What works cheaply <span>tagged work only, cheapest first</span></h2>
      <div class="grid2 even"><div><h3 class="sub3">By model</h3>${effTable(Core.efficiency(taggedRows, (r) => r.p.model || null), 'Model')}</div><div><h3 class="sub3">By agent</h3>${effTable(Core.efficiency(taggedRows, (r) => r.p.agent || null), 'Agent')}</div></div>
      <div class="grid2 even"><div><h3 class="sub3">By work type</h3>${effTable(Core.efficiency(taggedRows, (r) => r.p.tag), 'Work type')}</div>
      <div><h3 class="sub3">By lifecycle phase</h3>${effTable(Core.efficiency(taggedRows, (r) => Core.phaseLabel(Core.phaseOf(STORE, r)) || null), 'Phase')}</div></div>
      <div><h3 class="sub3">Models for the same work type</h3>${Core.modelByType(taggedRows).slice(0, 4).map((t) => `<p class="mbt"><b>${esc(t.type)}</b>: ${t.models.slice(0, 3).map((m) => `${esc(m.model)} ${fmtC(m.perPrompt)}`).join(' &lt; ')} <span class="hint">credits per prompt</span></p>`).join('') || '<p class="hint">No work type has two models with 3 or more prompts yet.</p>'}</div>
      <p class="hint">Work types are guessed from keywords and prompts differ in size, so read these as hints. A row needs 3 or more prompts.</p></section>` : '';

    return header() + toastHtml() + formHtml() +
      `<div class="phead"><div><h1 class="ptitle" id="page-title" tabindex="-1">Stories</h1><p class="sub">Credits and tokens per user story. You tag sessions or single prompts; tags are stored on this machine.</p></div>
        <div class="actions">${adoChip()}<button class="btn" data-act="nav" data-name="${adoOn() ? 'import' : 'connect'}">${adoOn() ? 'Import from Azure DevOps' : 'Connect Azure DevOps'}</button><button class="btn primary" data-act="newstory">New story</button></div></div>` +
      storyControls() +
      `<section class="band"><div class="hero"><div class="big" data-v="${tagged.credits.toFixed(4)}">${fmtC(tagged.credits)}<span class="unit">credits</span></div><div class="usd">on stories, about ${usd(tagged.credits)}</div></div>
        <div class="stat"><div class="v">${total ? pct(tagged.credits / total) : '-'}</div><div class="l">of all credits are on a story</div><div class="d">${fmtC(untagged.credits)} credits untagged</div></div>
        <div class="stat"><div class="v">${all.length}</div><div class="l">stories</div><div class="d">${active} with activity</div></div>
        <div class="stat"><div class="v">${fmtN(tagged.inTok + tagged.outTok)}</div><div class="l">tokens on stories</div><div class="d">${fmtN(tagged.inTok)} in, ${fmtN(tagged.outTok)} out</div></div></section>` +
      `<section class="panel"><h2>All stories <span>${list.length} shown</span></h2>
        <div class="toolbar"><input class="field" id="sq" type="search" placeholder="Search stories" value="${esc(S.sQ)}" aria-label="Search stories">
          <select class="field" data-sel="sGroup" data-fid="sgroup" aria-label="Group"><option value="all">All groups</option>${groups.map((x) => `<option value="${esc(x)}" ${S.sGroup === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}<option value="__none__" ${S.sGroup === '__none__' ? 'selected' : ''}>(no group)</option></select>
          <select class="field" data-sel="sSort" data-fid="ssort" aria-label="Sort by">${sortOpts.map(([v, l]) => `<option value="${v}" ${S.sSort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>${table}</section>` +
      rollPanel +
      `<section class="panel"><h2>Sessions without a story <span>${sessionsUntagged.length} in this view</span></h2>${unt}</section>` +
      eff +
      `<section class="panel"><h2>Back up <span>stories and tags, no prompt text</span></h2><p class="hint">Save your stories and tags to a file, or restore them from one.</p><div class="factions"><button class="btn" data-act="cmd" data-cmd="exportTags">Back up to file…</button><button class="btn" data-act="cmd" data-cmd="importTags">Restore from file…</button></div></section>`;
  }

  /* ====================== Story page ====================== */
  function storyChartWindow(rows) {
    if (S.storyWin === 'dash') { return getWindow(); }
    const today = startOfDay(Date.now());
    let lo = 0, hi = 0;
    for (const r of rows) { if (r.ts) { if (!lo || r.ts < lo) { lo = r.ts; } if (r.ts > hi) { hi = r.ts; } } }
    if (!lo) { return { from: today, to: today, end: addDays(today, 1) }; }
    const from = startOfDay(lo), to = Math.max(from, startOfDay(hi));
    return { from, to, end: addDays(to, 1) };
  }

  function storyPage(id) {
    const st = storyById(id);
    if (!st) { return notFound('story'); }
    const mine = Core.groupByStory(scopeRows(), STORE).byStory.get(id) || [];
    const t = Core.totals(mine);
    const lifeRows = S.storyWin === 'dash' ? (Core.groupByStory(ROWS, STORE).byStory.get(id) || []) : mine;
    const life = Core.totals(lifeRows);
    const real = mine.filter((r) => !r.ov);
    const win = storyChartWindow(mine);
    AFTER = () => drawChart(mine, win);
    const est = t.q.estimated.n > 0 ? '~' : '';
    const cachedShare = t.cachedBase > 0 ? pct(t.cachedKnown / t.cachedBase) : '-';

    const actions = `<div class="actions"><button class="btn" data-act="editstory" data-key="${esc(id)}">Edit</button><button class="btn" data-act="exportstory" data-key="${esc(id)}">Export CSV</button><button class="btn" data-act="newtab">Open in new tab</button>${
      S.confirmDelete === id
        ? `<span class="confirm" role="group" aria-label="Confirm delete">Delete ${esc(id)} and remove it from its sessions? <button class="btn small danger" data-act="deldo" data-key="${esc(id)}">Delete</button><button class="btn small" data-act="delcancel">Keep</button></span>`
        : `<button class="btn" data-act="delask" data-key="${esc(id)}">Delete</button>`}</div>`;
    const head = `<div class="phead"><div><h1 class="ptitle" id="page-title" tabindex="-1"><span class="sid">${esc(st.id)}</span> ${esc(st.title)}</h1>
      <div class="pchips">${st.group ? `<span class="pill">${esc(st.group)}</span>` : ''}${st.points ? `<span class="pill">${st.points} points</span>` : ''}${st.budget ? `<span class="pill">budget ${fmtC(st.budget)} credits</span>` : ''}</div></div>${actions}</div>`;

    if (!mine.length) {
      return header() + toastHtml() + formHtml() + head + storyAdoPanels(st) + storyControls() +
        `<section class="panel"><div class="empty slim"><h3>Nothing is tagged to this story${S.storyWin === 'dash' ? ' in this date range' : ' yet'}</h3><p>Tag a whole session from its page, or tag many at once under Stories, then Sessions without a story.</p><button class="btn" data-act="nav" data-name="stories">Go to Stories</button></div></section>`;
    }

    const bySess = new Map();
    for (const r of mine) { let e = bySess.get(r.s.id); if (!e) { e = { s: r.s, rows: [] }; bySess.set(r.s.id, e); } e.rows.push(r); }
    const sess = [...bySess.values()].map((e) => ({ ...e, t: Core.totals(e.rows) })).sort((a, b) => b.t.last - a.t.last);
    const sessTable = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Session</th><th class="hide-s" scope="col">Last active</th><th class="r" scope="col">Prompts</th><th class="r" scope="col">Credits</th><th class="r hide-s" scope="col">Tokens</th><th class="hide-s" scope="col">Tagged</th></tr></thead><tbody>${sess.map((e) => {
      const whole = Core.hasOwn(STORE.sessionTags, e.s.id) && STORE.sessionTags[e.s.id] === id;
      return `<tr class="rowlink" data-act="nav" data-name="session" data-id="${esc(e.s.id)}"><td><button class="linkish strong" data-act="nav" data-name="session" data-id="${esc(e.s.id)}">${esc(e.s.title)}</button><div class="m"><i class="dot" style="background:${wsColor(e.s.wsKey)}"></i>${esc(wsOf(e.s.wsKey).name)}</div></td>
        <td class="hide-s">${e.t.last ? fDate(e.t.last, { month: 'short', day: 'numeric', year: 'numeric' }) : ''}</td><td class="r">${e.t.prompts}${whole ? '' : ` of ${e.s.prompts.length}`}</td><td class="r"><b>${e.t.q.estimated.n ? '~' : ''}${fmtC(e.t.credits)}</b></td><td class="r hide-s">${fmtN(e.t.inTok + e.t.outTok)}</td><td class="hide-s">${whole ? 'whole session' : 'some prompts'}</td></tr>`;
    }).join('')}</tbody></table></div>`;

    const costly = Core.wasteSignals(mine).costliest;
    return header() + toastHtml() + formHtml() + head + storyControls() +
      `<section class="band"><div class="hero"><div class="big" data-v="${t.credits.toFixed(4)}">${est}${fmtC(t.credits)}<span class="unit">credits</span></div><div class="usd">about ${usd(t.credits)}</div></div>
        <div class="stat"><div class="v" data-k="prompts" data-v="${real.length}">${real.length}</div><div class="l">prompts</div><div class="d">${t.sessions} session${t.sessions === 1 ? '' : 's'}</div></div>
        <div class="stat"><div class="v" data-k="tokens" data-v="${t.inTok + t.outTok}">${fmtN(t.inTok + t.outTok)}</div><div class="l">tokens</div><div class="d">${fmtN(t.inTok)} in, ${fmtN(t.outTok)} out${t.cached ? ', ' + fmtN(t.cached) + ' cached' : ''}</div></div>
        <div class="stat"><div class="v" data-k="perprompt">${real.length ? fmtC(t.credits / real.length) : '-'}</div><div class="l">credits per prompt</div><div class="d">cached input ${cachedShare}</div></div>
        ${st.points ? `<div class="stat"><div class="v" data-k="perpoint" data-v="${(t.credits / st.points).toFixed(4)}">${fmtC(t.credits / st.points)}</div><div class="l">credits per point</div><div class="d">${st.points} points</div></div>` : ''}
        ${st.budget ? `<div class="meter-wrap">${budgetMeter(st, life.credits)}</div>` : ''}</section>
        <p class="hint qline">Data quality: ${esc(qualityLine(t))}.</p>` +
      storyAdoPanels(st) +
      `<section class="panel"><h2>Activity <span>${esc(S.storyWin === 'dash' ? windowLabel(getWindow()) : 'this story, by workspace')}, ${esc(unitName())} per ${chartStep(win) === 7 ? 'week' : 'day'}</span></h2><div class="chartbox" id="chart"></div><div class="legend" id="legend"></div></section>` +
      `<div class="grid2"><section class="panel"><h2>Workspaces and repos <span>${esc(unitName())}</span></h2>${workspaces(mine, false)}</section>` +
      `<section class="panel"><h2>What the work was <span>${esc(unitName())}, by prompt type</span></h2>${workTypes(mine, false)}</section></div>` +
      `<section class="panel"><h2>Lifecycle <span>${esc(unitName())}, by phase</span></h2>${phasePanel(mine, false)}</section>` +
      `<div class="grid2 even"><section class="panel"><h2>Models <span>${esc(unitName())}</span></h2>${models(mine, false)}</section>` +
      `<section class="panel"><h2>Agents <span>${esc(unitName())}</span></h2>${agents(mine)}</section></div>` +
      `<section class="panel"><h2>Sessions <span>${sess.length}</span></h2>${sessTable}</section>` +
      `<section class="panel"><h2>Costliest prompts <span>top ${costly.length}</span></h2>${costly.map(costRow).join('')}</section>` +
      wastePanel(mine);
  }

  /* ====================== Session page ====================== */
  function sessionPage(id) {
    const s = SESS.get(id);
    if (!s) { return notFound('session'); }
    const rows = (BY_SESSION.get(id) || []).slice().sort((a, b) => a.ts - b.ts);
    const t = Core.totals(rows);
    const w = wsOf(s.wsKey);
    const overrides = Core.hasOwn(STORE.promptTags, id) ? Object.keys(STORE.promptTags[id]).length : 0;
    const tagged = Core.hasOwn(STORE.sessionTags, id) ? STORE.sessionTags[id] : null;
    const est = t.q.estimated.n > 0 ? '~' : '';
    const when = s.created ? `${fDate(s.created, { month: 'short', day: 'numeric', year: 'numeric' })}${s.last && dkey(s.last) !== dkey(s.created) ? ' to ' + fDate(s.last, { month: 'short', day: 'numeric', year: 'numeric' }) : ''}` : '';
    const repos = w.repos && w.repos.length ? w.repos.map((r) => r.name + (r.branch ? ' @ ' + r.branch : '')).slice(0, 3).join(', ') : '';
    return header() + toastHtml() + formHtml() +
      `<div class="phead"><div><h1 class="ptitle" id="page-title" tabindex="-1">${esc(s.title)}</h1>
        <div class="pchips"><span><i class="dot" style="background:${wsColor(s.wsKey)}"></i> ${esc(w.name)}</span>${repos ? `<span>${esc(repos)}</span>` : ''}<span>${esc(when)}</span><span>${esc(s.edition)}</span></div></div>
        <div class="actions">${w.local ? `<button class="btn" data-act="open-ws" data-path="${esc(w.path)}">Open workspace folder</button>` : ''}${s.file ? `<button class="btn" data-act="reveal" data-path="${esc(s.file)}">Reveal session file</button>` : ''}<button class="btn" data-act="newtab">Open in new tab</button></div></div>` +
      `<section class="band"><div class="hero"><div class="big" data-v="${t.credits.toFixed(4)}">${est}${fmtC(t.credits)}<span class="unit">credits</span></div><div class="usd">about ${usd(t.credits)}</div></div>
        <div class="stat"><div class="v">${t.prompts}</div><div class="l">prompts</div><div class="d">${t.calls} model calls</div></div>
        <div class="stat"><div class="v">${fmtN(t.inTok + t.outTok)}</div><div class="l">tokens</div><div class="d">${fmtN(t.inTok)} in, ${fmtN(t.outTok)} out</div></div>
        <div class="stat"><div class="v">${t.prompts ? fmtC((t.credits - t.bgCredits) / t.prompts) : '-'}</div><div class="l">credits per prompt</div><div class="d">${t.bgCredits ? fmtC(t.bgCredits) + ' background' : 'no background calls'}</div></div></section>` +
      `<section class="panel"><h2>Story <span>which user story this session was for</span></h2>
        <div class="tagrow"><label class="inl">Story ${storySelect({ ctx: 'session', sid: id, value: tagged || '__none__', fid: 'ss-top', label: 'Story for this session' })}</label>
        ${overrides ? `<span class="hint">${overrides} prompt${overrides === 1 ? ' is' : 's are'} set individually.</span><button class="btn small" data-act="clearov" data-sid="${esc(id)}">Make them follow the session</button>` : ''}
        ${tagged && storyById(tagged) ? `<button class="btn small" data-act="nav" data-name="story" data-id="${esc(tagged)}">Open story ${esc(tagged)}</button>` : ''}</div>
        ${suggestionsHtml(s, false)}</section>` +
      `<section class="panel"><h2>Lifecycle <span>${esc(unitName())}, by phase</span></h2>${phasePanel(rows, false)}
        <div class="tagrow"><label class="inl">Set every prompt in this session to ${phaseSelect({ ctx: 'session', sid: id, value: '', placeholder: 'Choose a phase…', fid: 'sp-top', autoLabel: 'Automatic (guess each one)', label: 'Phase for all prompts in this session' })}</label></div></section>` +
      `<section class="panel"><h2>Prompts <span>${t.prompts}, oldest first. Change a prompt's story or phase if it was guessed wrong.</span></h2>${rows.map((r) => promptHtml(r, { controls: true })).join('')}</section>`;
  }

  /* ====================== Prompt page ====================== */
  function promptPage(sid, key) {
    const s = SESS.get(sid);
    const list = s ? (BY_SESSION.get(sid) || []).filter((r) => !r.ov).sort((a, b) => a.ts - b.ts) : [];
    const idx = list.findIndex((r) => Core.promptKey(r.p) === key);
    if (idx < 0) { return notFound('prompt'); }
    const r = list[idx], p = r.p, w = wsOf(r.ws);
    const prev = list[idx - 1], next = list[idx + 1];
    const nav = (x, label) => (x ? `<button class="btn small" data-act="nav" data-replace="1" data-name="prompt" data-id="${esc(sid)}" data-key="${esc(Core.promptKey(x.p))}">${label}</button>` : `<button class="btn small" disabled>${label}</button>`);
    const kv = (k, v) => `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`;
    const tools = p.toolCalls ? esc(p.tools.map((x) => x[0] + (x[1] > 1 ? ' \u00d7' + x[1] : '')).join(', ')) : 'none';
    return header() + toastHtml() + formHtml() +
      `<div class="phead"><div><h1 class="ptitle" id="page-title" tabindex="-1">Prompt ${idx + 1} of ${list.length}</h1>
        <div class="pchips"><span>${r.ts ? fDate(r.ts, { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' + fTime(r.ts) : ''}</span><span class="pill tag">${esc(p.tag)}</span>${phasePill(r)}${qBadge(p)}${p.canceled ? '<span class="pill">canceled</span>' : ''}</div></div>
        <div class="actions">${nav(prev, '← Previous')}${nav(next, 'Next →')}<button class="btn small" data-act="nav" data-name="session" data-id="${esc(sid)}">Open session</button></div></div>` +
      `<section class="panel"><h2>What was asked <span>first 600 characters</span></h2><div class="fulltext">${esc(p.text) || '<i class="hint">(empty prompt)</i>'}</div></section>` +
      `<div class="grid2 even"><section class="panel"><h2>Cost <span>${p.quality === 'estimated' ? 'estimated from text length' : p.quality === 'tokens' ? 'priced from token counts' : 'billed by Copilot'}</span></h2><dl class="kvs">
        ${kv('Credits', `${p.quality === 'estimated' ? '~' : ''}${fmtC(p.credits)} (about ${usd(p.credits)})`)}
        ${kv('Tokens in', fmtN(p.inTok))}${kv('Tokens out', fmtN(p.outTok))}${kv('Cached input', p.cached ? fmtN(p.cached) : '-')}
        ${kv('Model calls', p.calls || 'no call data')}${kv('Took', p.dur ? (p.dur / 1000).toFixed(0) + ' s' : '-')}${p.peak ? kv('Largest single request', fmtN(p.peak) + ' tokens') : ''}</dl></section>
        <section class="panel"><h2>Where <span>and with what</span></h2><dl class="kvs">
        ${kv('Workspace', `<i class="dot" style="background:${wsColor(r.ws)}"></i> ${esc(w.name)}`)}${kv('Session', `<button class="linkish" data-act="nav" data-name="session" data-id="${esc(sid)}">${esc(s.title)}</button>`)}
        ${kv('Model', esc(p.model || '-'))}${kv('Agent', esc(p.agent || '-'))}${kv('Tools used', tools)}</dl></section></div>` +
      `<section class="panel"><h2>Story <span>${Core.sourceOf(STORE, r) === 'override' ? 'set on this prompt' : Core.storyOf(STORE, r) ? 'from the session' : 'not tagged'}</span></h2>
        <div class="tagrow"><label class="inl">Story ${storySelect({ ctx: 'prompt', sid, pk: key, value: promptValue(r), fid: 'ps-top', inherit: true, label: 'Story for this prompt' })}</label>
        ${storyById(Core.storyOf(STORE, r)) ? `<button class="btn small" data-act="nav" data-name="story" data-id="${esc(Core.storyOf(STORE, r))}">Open story</button>` : ''}</div></section>` +
      `<section class="panel"><h2>Lifecycle phase <span>${Core.phaseSource(STORE, r) === 'manual' ? 'set by you' : 'guessed from the prompt'}</span></h2>
        <div class="tagrow"><label class="inl">Phase ${phaseSelect({ ctx: 'prompt', sid, pk: key, value: Core.phaseSource(STORE, r) === 'manual' ? Core.phaseOf(STORE, r) : '__auto__', fid: 'pp-top', autoLabel: 'Automatic (' + Core.phaseLabel(Core.autoPhase(p)) + ')', label: 'Lifecycle phase for this prompt' })}</label>
        <span class="hint">Analysis, planning, building, testing and so on. Correct the guess if it is wrong.</span></div></section>` +
      ((p.files && p.files.length) || (p.edited && p.edited.length) ? `<section class="panel"><h2>Files <span>names only</span></h2><div class="pmeta">${(p.edited || []).map((f) => `<span class="file edit" title="Edited by Copilot">${esc(f)}</span>`).join('')}${(p.files || []).map((f) => `<span class="file">${esc(f)}</span>`).join('')}</div></section>` : '');
  }

  /* ====================== Azure DevOps and effort pages ====================== */
  // Everything here is state the page was TOLD by the extension: a status, a backlog list, a commit list, a sync preview.
  // The page never holds a token, never builds an address and never decides what is written to Azure DevOps: it asks, and the
  // extension answers (and, for a sync, only writes what the person confirmed in a preview it keeps itself).
  const ADO = { status: null, statusErr: '', busy: false, wait: new Map(), test: null, testBusy: false, backlog: null, effort: null, sync: null, confirmClear: '' };

  function askAdo(op, extra) {
    const rid = ++RID;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { ADO.wait.delete(rid); resolve({ ok: false, error: 'The extension did not answer in time. Try again.' }); }, 180000);
      ADO.wait.set(rid, (m) => { clearTimeout(timer); resolve(m); });
      vscode.postMessage(Object.assign({}, extra, { type: 'ado', rid, op }));
    });
  }

  const adoOn = () => !!(ADO.status && ADO.status.enabled && ADO.status.trusted);
  const fmtH = (h) => (Math.round(h * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' h';
  const adoLink = (id) => (Core.hasOwn(STORE.ado, id) ? STORE.ado[id] : null);
  const effortOf = (id) => (Core.hasOwn(STORE.efforts, id) ? STORE.efforts[id] : null);

  function loadStatus() {
    if (ADO.busy) { return; }
    ADO.busy = true;
    askAdo('status').then((r) => {
      ADO.busy = false;
      if (r && r.ok) { ADO.status = r; ADO.statusErr = ''; } else { ADO.status = null; ADO.statusErr = (r && r.error) || 'Could not read the Azure DevOps settings.'; }
      if (DATA) { render(); }
    });
  }

  function resetAdoPages() { ADO.backlog = null; ADO.effort = null; ADO.sync = null; ADO.test = null; ADO.testBusy = false; ADO.confirmClear = ''; S.bQ = ''; }

  /** Start whatever the current page needs. Each loader sets its state first, so this never runs a request twice. */
  function ensureLoaded() {
    const r = S.route;
    if (!DATA) { return; }
    if (r.name === 'effort' && storyById(r.id) && !ADO.effort) { loadEffort(r.id); }
    if (!ADO.status) { return; }
    if (r.name === 'import' && adoOn() && !ADO.backlog) { loadBacklog(); }
    if (r.name === 'sync' && storyById(r.id) && adoOn() && !ADO.sync) { loadPreview(r.id); }
  }

  const toastNow = (ok, text) => { S.toast = { ok, text }; announce(text); render(); };

  /* ---------- connection page ---------- */

  function gatePanel() {
    const s = ADO.status;
    if (!s) { return `<section class="panel"><div class="empty slim"><p>${esc(ADO.statusErr || 'Checking the Azure DevOps settings...')}</p></div></section>`; }
    if (!s.trusted) { return '<section class="panel"><div class="empty slim"><h3>This window is in Restricted Mode</h3><p>Azure DevOps and reading git are off until you trust this workspace.</p></div></section>'; }
    if (!s.enabled) {
      return '<section class="panel"><div class="empty slim"><h3>Azure DevOps is turned off</h3><p>Nothing is sent anywhere until you connect. Connecting asks for your organisation and how to sign in, and shows exactly what is sent before it turns on.</p><button class="btn primary" data-act="nav" data-name="connect">Connect to Azure DevOps</button></div></section>';
    }
    return '';
  }

  function connectPage() {
    const s = ADO.status;
    const head = '<div class="phead"><div><h1 class="ptitle" id="page-title" tabindex="-1">Azure DevOps</h1><p class="sub">Import stories from your backlog and keep one usage Task per story up to date.</p></div></div>';
    const kv = (k, v) => `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`;
    let state;
    if (!s) {
      state = `<p class="hint">${esc(ADO.statusErr || 'Checking the settings...')}</p>`;
    } else if (!s.trusted) {
      state = '<div class="notice"><p>This window is in Restricted Mode, so Azure DevOps and reading git are switched off. Trust the workspace to use them.</p></div>';
    } else if (!s.enabled) {
      state = '<p><span class="pill">Off</span> Nothing is sent to Azure DevOps. Connecting lets you choose the organisation and how to sign in, and shows what is sent first.</p>' +
        '<div class="factions"><button class="btn primary" data-act="cmd" data-cmd="adoConnect" data-fid="connect">Connect...</button></div>';
    } else {
      const pat = s.authMethod === 'pat';
      state = `<dl class="kvs">${kv('Status', '<span class="pill story">On</span>')}${kv('Organisation', esc(s.organization))}${kv('Default project', s.project ? esc(s.project) : '<span class="hint">not chosen</span>')}` +
        `${kv('Sign-in', pat ? 'Personal access token' : 'Microsoft account')}${kv('Signed in', s.signedIn ? 'Yes' + (s.user && s.user.name ? ' as ' + esc(s.user.name) : '') : (pat ? 'No token is stored' : 'Not yet'))}</dl>` +
        '<div class="factions"><button class="btn primary" data-act="atest" data-fid="atest"' + (ADO.testBusy ? ' disabled' : '') + '>Test connection</button>' +
        '<button class="btn" data-act="nav" data-name="import">Import stories</button>' +
        '<button class="btn" data-act="cmd" data-cmd="adoConnect">Change connection...</button>' +
        (pat ? '<button class="btn" data-act="cmd" data-cmd="adoSetToken">Set token...</button><button class="btn" data-act="cmd" data-cmd="adoClearToken">Remove stored token</button>' : '') +
        '<button class="btn" data-act="cmd" data-cmd="adoDisconnect">Disconnect</button></div>';
    }
    let test = '';
    if (ADO.testBusy) { test = '<p class="hint" role="status">Testing...</p>'; } else if (ADO.test) {
      test = ADO.test.ok
        ? `<p role="status"><b>Connected</b> to ${esc(ADO.test.organization)}${ADO.test.user ? ' as ' + esc(ADO.test.user.name) : ''}. ${ADO.test.projectsListed === false ? `This sign-in cannot list projects (a personal access token needs "Project and Team: Read" for that), so the project <b>${esc(ADO.test.projects[0] || '')}</b> from the settings is used.` : ADO.test.projects.length ? `You can see ${np(ADO.test.projects.length, 'project')}: ${esc(ADO.test.projects.slice(0, 12).join(', '))}${ADO.test.projects.length > 12 ? ', ...' : ''}.` : 'No projects are visible to this account.'}</p>`
        : `<p class="ferr" role="alert">${esc(ADO.test.error)}</p>`;
    }
    const effort = s && s.effort ? s.effort : null;
    return header() + toastHtml() + head +
      `<section class="panel"><h2>Connection <span>${s && s.enabled ? 'on' : 'off'}</span></h2>${state}${test}</section>` +
      '<section class="panel"><h2>What is sent <span>and what never is</span></h2><ul class="signals">' +
      '<li>AI Delivery Insights contacts only <b>https://dev.azure.com/&lt;your organisation&gt;</b>. Nothing else, and nothing at all while this is off.</li>' +
      '<li><b>It reads:</b> stories on your backlog (number, title, type, state, points, iteration), your display name, and its own tracking Task.</li>' +
      '<li><b>It writes:</b> one Task under each story you sync. The Task description holds counts, credits, tokens, model and agent names, lifecycle phases, dates and the traditional effort.</li>' +
      '<li><b>It never sends</b> prompts, responses, session titles, file names or paths. Your name is sent only if you turn that on in settings.</li></ul></section>' +
      '<section class="panel"><h2>Signing in <span>how access is kept</span></h2><ul class="signals">' +
      '<li><b>Microsoft account (recommended):</b> VS Code keeps the sign-in. AI Delivery Insights asks for a short-lived token for each request and never stores one.</li>' +
      '<li><b>Personal access token (fallback):</b> kept in VS Code secret storage, which is encrypted with your operating system keychain. It is never written to a settings file, to the stored stories, or shown on a page. Give it the <b>Work Items (Read &amp; write)</b> scope and a short expiry. <b>Project and Team (Read)</b> is optional: it lets AI Delivery Insights list your projects, and without it you type the project name once.</li></ul></section>' +
      (effort ? `<section class="panel"><h2>Effort rates <span>used for the estimate without AI</span></h2><dl class="kvs">${kv('Production lines a day', effort.prodLinesPerDay)}${kv('Test lines a day', effort.testLinesPerDay)}${kv('Hours in a working day', effort.hoursPerDay)}${kv('Overhead', effort.overheadPercent + '%')}${kv('Hours per story point', effort.hoursPerPoint > 0 ? effort.hoursPerPoint : 'not used')}</dl><p class="hint">These are assumptions, not measurements. Change them in Settings (search for "AI Delivery Insights effort").</p></section>` : '');
  }

  function runTest() {
    ADO.testBusy = true; ADO.test = null; render();
    const mine = ADO;
    askAdo('test').then((r) => { if (mine !== ADO) { return; } ADO.testBusy = false; ADO.test = r; if (r.ok) { loadStatus(); } render(); });
  }

  /* ---------- import page ---------- */

  function loadBacklog() {
    const b = ADO.backlog = { project: '', projects: [], boards: [], board: '', boardsErr: false, items: null, loading: true, err: '', truncated: false, sel: new Set(), importing: false };
    askAdo('test').then((t) => {
      if (ADO.backlog !== b) { return; }
      if (!t.ok) { b.loading = false; b.err = t.error; render(); return; }
      b.projects = t.projects.slice();
      const want = ADO.status && ADO.status.project;
      b.project = b.projects.includes(want) ? want : (b.projects[0] || '');
      if (!b.project) { b.loading = false; b.err = 'This account cannot see any project in the organisation.'; render(); return; }
      startBacklog(b);
    });
  }

  const savedBoard = (project) => (Core.hasOwn(S.adoBoards, project) && typeof S.adoBoards[project] === 'string' ? S.adoBoards[project] : '');

  /** A project was chosen: read its boards (a failure only hides the filter), pick the one used last time, then read the backlog. */
  function startBacklog(b) {
    const project = b.project;
    b.boards = []; b.board = ''; b.boardsErr = false; b.items = null; b.sel = new Set(); b.loading = true; b.err = ''; render();
    askAdo('boards', { project }).then((r) => {
      if (ADO.backlog !== b || b.project !== project) { return; }
      if (r.ok) {
        b.boards = r.boards;
        const last = savedBoard(project);
        b.board = r.boards.some((x) => x.id === last) ? last : '';
      } else { b.boardsErr = true; }
      fetchBacklog(b);
    });
  }

  function fetchBacklog(b) {
    const project = b.project, board = b.board;
    b.loading = true; b.err = ''; render();
    askAdo('backlog', { project, board }).then((r) => {
      if (ADO.backlog !== b || b.project !== project || b.board !== board) { return; }
      b.loading = false;
      if (r.ok) { b.items = r.items; b.truncated = !!r.truncated; b.sel = new Set([...b.sel].filter((id) => r.items.some((x) => x.id === id && !x.imported))); } else { b.err = r.error; b.items = b.items || []; }
      render();
    });
  }

  function importPage() {
    const b = ADO.backlog;
    const head = '<div class="phead"><div><h1 class="ptitle" id="page-title" tabindex="-1">Import stories</h1><p class="sub">Choose stories from your Azure DevOps backlog to track here. Nothing is changed in Azure DevOps.</p></div></div>';
    const gate = gatePanel();
    if (gate) { return header() + toastHtml() + head + gate; }
    if (!b || (b.loading && !b.items)) { return header() + toastHtml() + head + '<section class="panel"><div class="empty slim" role="status"><h3>Reading your backlog</h3><p>Asking Azure DevOps for the stories you can see.</p></div></section>'; }
    if (b.err && !(b.items && b.items.length)) {
      return header() + toastHtml() + head + `<section class="panel"><div class="empty slim"><h3>Could not read the backlog</h3><p role="alert">${esc(b.err)}</p><button class="btn" data-act="bretry">Try again</button></div></section>`;
    }
    const q = (S.bQ || '').trim().toLowerCase();
    const items = (b.items || []).filter((x) => !q || `${x.id} ${x.title} ${x.type} ${x.state} ${x.iteration}`.toLowerCase().includes(q));
    const pick = items.filter((x) => !x.imported);
    const allTicked = pick.length > 0 && pick.every((x) => b.sel.has(x.id));
    const n = b.sel.size;
    const boardName = (b.boards.find((x) => x.id === b.board) || {}).name || '';
    const table = !items.length
      ? `<div class="empty slim"><p>${(b.items || []).length ? 'No story matches.' : boardName ? 'No stories were found on this board, of the types set in Settings. Stories belong to a board by the area paths of its team.' : 'No stories were found on this project, of the types set in Settings.'}</p></div>`
      : `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col"><span class="sr">Choose</span></th><th scope="col">ID</th><th scope="col">Title</th><th class="hide-s" scope="col">Type</th><th class="hide-s" scope="col">State</th><th class="r hide-s" scope="col">Points</th><th class="hide-s" scope="col">Iteration</th><th scope="col">Here</th></tr></thead><tbody>${items.map((x) => `<tr>
          <td><input type="checkbox" data-act="bsel" data-key="${Number(x.id)}" data-fid="b-${Number(x.id)}" ${b.sel.has(x.id) ? 'checked' : ''} ${x.imported ? 'disabled' : ''} aria-label="Choose ${Number(x.id)} ${esc(x.title)}"></td>
          <td><b>${Number(x.id)}</b></td><td>${esc(x.title)}</td><td class="hide-s">${esc(x.type)}</td><td class="hide-s">${esc(x.state)}</td><td class="r hide-s">${x.points == null ? '-' : x.points}</td><td class="hide-s">${esc(x.iteration)}</td>
          <td>${x.imported ? '<span class="pill story">Already here</span>' : '<span class="hint">New</span>'}</td></tr>`).join('')}</tbody></table></div>`;
    return header() + toastHtml() + head +
      `<section class="panel"><h2>Backlog <span>${(b.items || []).length} stories${boardName ? ' on ' + esc(boardName) : ''}${b.truncated ? ', the first ' + (b.items || []).length + ' only' : ''}</span></h2>
        <div class="toolbar"><label class="inl">Project <select class="field" data-ado-project data-fid="bproj" aria-label="Project">${b.projects.map((p) => `<option value="${esc(p)}" ${p === b.project ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
          ${b.boards.length ? `<label class="inl">Board <select class="field" data-ado-board data-fid="bboard" aria-label="Board"><option value="">All boards</option>${b.boards.map((x) => `<option value="${esc(x.id)}" ${x.id === b.board ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>`
            : b.boardsErr ? '<span class="hint" title="Listing boards needs the Project and Team: Read permission.">Boards unavailable</span>' : ''}
          <input class="field" id="bq" type="search" placeholder="Search the backlog" value="${esc(S.bQ || '')}" aria-label="Search the backlog">
          <label class="inl"><input type="checkbox" data-act="ball" data-fid="ball" ${allTicked ? 'checked' : ''} ${pick.length ? '' : 'disabled'}> Choose all ${pick.length} new</label>
          <button class="btn primary" data-act="bimport" data-fid="bimport" ${n && !b.importing ? '' : 'disabled'}>${b.importing ? 'Importing...' : `Import ${n} chosen`}</button></div>
        ${b.err ? `<p class="ferr" role="alert">${esc(b.err)}</p>` : ''}${b.loading ? '<p class="hint" role="status">Reading...</p>' : ''}${table}
        ${b.truncated ? '<p class="hint">Only the first stories are shown. Narrow the story types in Settings, or import in rounds.</p>' : ''}
        <div class="panelfoot"><span class="hint">Imported stories keep their Azure DevOps number, title and points. You can edit them later.</span><button class="btn small" data-act="nav" data-name="stories">Go to Stories</button></div></section>`;
  }

  function doImport() {
    const b = ADO.backlog; if (!b || !b.sel.size || b.importing) { return; }
    b.importing = true; render();
    askAdo('import', { ids: [...b.sel] }).then((r) => {
      if (ADO.backlog !== b) { return; }
      b.importing = false;
      if (r.ok) { b.sel = new Set(); S.toast = { ok: true, text: r.message }; announce(r.message); fetchBacklog(b); } else { toastNow(false, r.error); }
    });
  }

  /* ---------- effort page ---------- */

  function loadEffort(storyId) {
    const e = ADO.effort = { storyId, loading: true, err: '', res: null, selected: new Set(), est: null, computing: false, seq: 0, confirm: false, saving: false, manual: '', note: '', merr: '', serr: '' };
    askAdo('effortFind', { storyId }).then((r) => {
      if (ADO.effort !== e) { return; }
      e.loading = false;
      if (r.ok) { e.res = r; e.selected = new Set(r.selected); e.est = r.estimate; } else { e.err = r.error; }
      render();
    });
  }

  function recompute() {
    const e = ADO.effort; if (!e || !e.res) { return; }
    const seq = ++e.seq; e.computing = true; e.serr = ''; render();
    askAdo('effortCompute', { storyId: e.storyId, cacheId: e.res.cacheId, selected: [...e.selected] }).then((r) => {
      if (ADO.effort !== e || e.seq !== seq) { return; }
      e.computing = false;
      if (r.ok) { e.est = r.estimate; } else { e.est = { ok: false, reason: r.error }; e.stale = true; }
      render();
    });
  }

  function saveEstimate(confirmed) {
    const e = ADO.effort; if (!e || !e.res || !e.est || !e.est.ok || e.saving) { return; }
    const cur = effortOf(e.storyId);
    if (cur && cur.source === 'manual' && !confirmed) { e.confirm = true; render(); return; }
    e.confirm = false; e.saving = true; e.serr = ''; render();
    askAdo('effortSave', { storyId: e.storyId, cacheId: e.res.cacheId, selected: [...e.selected] }).then((r) => {
      if (ADO.effort !== e) { return; }
      e.saving = false;
      if (r.ok) { go({ name: 'story', id: e.storyId }); toastNow(true, r.message); } else { e.serr = r.error; render(); }
    });
  }

  function saveManual() {
    const e = ADO.effort; if (!e) { return; }
    const v = Core.normalizeEffort({ hours: e.manual, source: 'manual' });
    if (!v.ok) { e.merr = v.error; render(); return; }
    e.merr = '';
    sendOp({ type: 'saveEffort', storyId: e.storyId, hours: v.effort.hours, note: e.note });
  }

  const MATCH = { id: ['story number', 'q-exact'], branch: ['branch name', 'q-exact'], time: ['time only', 'q-tokens'] };

  function effortCurrent(st) {
    const cur = effortOf(st.id);
    if (!cur) { return '<section class="panel"><h2>Saved effort <span>none yet</span></h2><p class="hint">Nothing is saved for this story. Calculate it below, or enter the hours by hand.</p></section>'; }
    const how = cur.source === 'manual' ? 'Entered by hand' : `Estimated from the code, ${cur.confidence} confidence`;
    return `<section class="panel"><h2>Saved effort <span>${esc(how)}</span></h2><div class="effrow"><div class="effbig" data-k="effort" data-v="${cur.hours}">${esc(fmtH(cur.hours))}</div>
      <div class="hint">${cur.low != null ? `Range ${esc(fmtH(cur.low))} to ${esc(fmtH(cur.high))}. ` : ''}${cur.setAt ? 'Saved ' + esc(ago(cur.setAt)) + '. ' : ''}${esc(cur.note || '')}</div>
      ${ADO.confirmClear === st.id
    ? `<span class="confirm" role="group" aria-label="Confirm remove">Remove the saved effort? <button class="btn small danger" data-act="eclear" data-key="${esc(st.id)}">Remove</button><button class="btn small" data-act="eclearcancel">Keep</button></span>`
    : `<button class="btn small" data-act="eclearask" data-key="${esc(st.id)}">Remove</button>`}</div></section>`;
  }

  function effortPage(id) {
    const st = storyById(id);
    if (!st) { return notFound('story'); }
    const e = ADO.effort;
    const head = `<div class="phead"><div><h1 class="ptitle" id="page-title" tabindex="-1"><span class="sid">${esc(st.id)}</span> Effort without AI</h1><p class="sub">How long this story would have taken without AI, for ${esc(st.title)}.</p></div></div>`;
    const how = `<section class="panel"><h2>How it is worked out <span>method size-v1</span></h2><details open><summary>Read the method</summary><ol class="signals">
      <li><b>Find the commits.</b> In the git repository of the workspace the story's sessions ran in, it takes commits that mention the story number, commits on a branch named after it, and commits made while you were working in those sessions. The first two are strong evidence; "time only" is weak.</li>
      <li><b>Size the change.</b> It counts lines added plus half the lines deleted, in code files and in test files separately. Documentation, lock files, generated or vendored code, build output, images and other binary files are not counted.</li>
      <li><b>Turn size into hours.</b> Lines divided by a typical number of lines a day, separately for code and tests, then multiplied by the hours in a working day. A fixed time is added for each file touched, and then an overhead for clarifying the story, review and rework.</li>
      <li><b>Show a range.</b> A rule of thumb is not precise, so the answer comes with a low and a high figure and a confidence level.</li></ol>
      <p class="hint">This is an estimate of the effort, not a measurement, and the rates are assumptions you can change in Settings. Untick commits that do not belong, or enter the hours by hand if you know better.</p></details></section>`;
    if (!e || e.loading) { return header() + toastHtml() + head + effortCurrent(st) + how + '<section class="panel"><div class="empty slim" role="status"><h3>Looking at the repository</h3><p>Reading git history on this machine. Nothing is sent anywhere.</p></div></section>' + manualPanel(st, e); }

    let commits = '';
    if (e.err) {
      commits = `<section class="panel"><h2>Commits <span>none to show</span></h2><div class="notice"><p role="alert">${esc(e.err)}</p></div><div class="factions"><button class="btn" data-act="ereload">Try again</button></div></section>`;
    } else {
      const r = e.res;
      const bad = r.repos.filter((x) => !x.ok);
      const list = r.commits;
      const rows = list.map((c) => {
        const m = MATCH[c.match] || ['time only', 'q-tokens'];
        const when = Date.parse(c.date);
        return `<tr><td><input type="checkbox" data-act="csel" data-key="${esc(c.key)}" data-fid="c-${esc(c.key)}" ${e.selected.has(c.key) ? 'checked' : ''} aria-label="Count commit ${esc(c.short)}"></td>
          <td><code>${esc(c.short)}</code> ${esc(c.subject)}<div class="m">${esc(c.repo)}${when ? ' &middot; ' + esc(fDate(when, { month: 'short', day: 'numeric', year: 'numeric' })) : ''}</div></td>
          <td><span class="pill ${m[1]}">${m[0]}</span></td><td class="r hide-s">${fmtN(c.prodLines)}</td><td class="r hide-s">${fmtN(c.testLines)}</td><td class="r hide-s">${c.files}${c.ignored ? ` <span class="hint">+${c.ignored} not counted</span>` : ''}</td></tr>`;
      }).join('');
      commits = `<section class="panel"><h2>Commits <span>${e.selected.size} of ${list.length} counted</span></h2>
        ${r.notes && r.notes.length ? `<div class="notice"><ul>${r.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        ${bad.length ? `<p class="hint">Could not read ${esc(bad.map((x) => x.label).join(', '))}: ${esc(bad[0].error || 'unknown error')}.</p>` : ''}
        ${list.length ? `<div class="bulk"><button class="btn small" data-act="call">Count all</button><button class="btn small" data-act="cnone">Count none</button><span class="hint">Untick anything that is not part of this story, such as a bulk import or a reformat.</span></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col"><span class="sr">Count</span></th><th scope="col">Commit</th><th scope="col">Found by</th><th class="r hide-s" scope="col">Code lines</th><th class="r hide-s" scope="col">Test lines</th><th class="r hide-s" scope="col">Files</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<div class="empty slim"><p>No commits were found for this story. Enter the hours by hand below.</p></div>'}</section>`;
    }

    let est = '';
    if (e.res) {
      const x = e.est;
      if (x && x.ok) {
        est = `<section class="panel"><h2>Estimate <span>${e.computing ? 'recalculating...' : np(x.inputs.commits, 'commit') + ' counted'}</span></h2>
          <div class="band flat"><div class="hero"><div class="big" data-k="estimate" data-v="${x.hours}">${esc(fmtH(x.hours))}</div><div class="usd">range ${esc(fmtH(x.low))} to ${esc(fmtH(x.high))}</div></div>
            <div class="stat"><div class="v"><span class="pill ${x.confidence === 'high' ? 'q-exact' : x.confidence === 'low' ? 'q-estimated' : 'q-tokens'}">${esc(x.confidence)}</span></div><div class="l">confidence</div><div class="d">${x.counts.byId} by number or branch, ${x.counts.byTime} by time</div></div></div>
          <h3 class="sub3">The arithmetic</h3><div class="tbl-wrap"><table class="tbl compact"><thead><tr><th scope="col">Step</th><th class="r" scope="col">Hours</th><th scope="col">How</th></tr></thead><tbody>${x.steps.map((s) => `<tr><td>${esc(s.label)}</td><td class="r">${s.value == null ? '' : esc(s.value.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' h')}</td><td class="hint">${esc(s.detail)}</td></tr>`).join('')}</tbody></table></div>
          <p class="hint">${x.counts.prodFiles} code files and ${x.counts.testFiles} test files counted; ${x.counts.ignoredFiles} documentation, lock, generated or build files and ${x.counts.binaryFiles} binary files left out.</p>
          ${x.notes.length ? `<ul class="signals">${x.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}${x.pointsCheck && x.pointsCheck.note ? `<p class="hint">${esc(x.pointsCheck.note)}</p>` : ''}
          ${e.serr ? `<p class="ferr" role="alert">${esc(e.serr)}</p>` : ''}
          ${e.confirm ? `<div class="notice" role="alert"><p>This will replace the ${esc(fmtH(effortOf(st.id).hours))} you entered by hand.</p><div class="factions"><button class="btn primary" data-act="esave2" data-fid="esave2">Replace it</button><button class="btn" data-act="esavecancel">Keep mine</button></div></div>`
    : `<div class="factions"><button class="btn primary" data-act="esave" data-fid="esave" ${e.computing || e.saving ? 'disabled' : ''}>${e.saving ? 'Saving...' : 'Save this estimate'}</button></div>`}</section>`;
      } else {
        est = `<section class="panel"><h2>Estimate <span>${e.computing ? 'recalculating...' : 'not available'}</span></h2><div class="notice"><p role="status">${esc(x ? x.reason : 'No estimate yet.')}</p></div>${e.stale ? '<div class="factions"><button class="btn" data-act="ereload">Reload the commits</button></div>' : ''}</section>`;
      }
    }
    return header() + toastHtml() + head + effortCurrent(st) + how + commits + est + manualPanel(st, e);
  }

  function manualPanel(st, e) {
    const v = e || { manual: '', note: '', merr: '' };
    return `<section class="panel"><h2>Enter the hours by hand <span>when nothing can be calculated, or you know better</span></h2>
      <form data-form="effort" novalidate><div class="fgrid"><label>Hours without AI<input class="field" data-ef="manual" data-fid="e-hours" value="${esc(v.manual)}" inputmode="decimal" autocomplete="off" placeholder="for example 12.5"></label>
      <label class="wide">Note (optional)<input class="field" data-ef="note" data-fid="e-note" value="${esc(v.note)}" maxlength="200" autocomplete="off"></label></div>
      ${v.merr ? `<p class="ferr" role="alert">${esc(v.merr)}</p>` : ''}
      <div class="factions"><button type="submit" class="btn primary" data-fid="e-save">Save hours</button></div></form>
      <p class="hint">A number you type is kept as it is, and it wins over an estimate when a story is synced.</p></section>`;
  }

  /* ---------- sync page ---------- */

  function loadPreview(storyId) {
    const sy = ADO.sync = { storyId, loading: true, err: '', info: null, prev: null, applying: false, result: null, aerr: null };
    askAdo('syncPreview', { storyId }).then((r) => {
      if (ADO.sync !== sy) { return; }
      sy.loading = false;
      if (!r.ok) { sy.err = r.error; } else if (r.nothing) { sy.info = r.message; } else { sy.prev = r; }
      render();
    });
  }

  function applySync() {
    const sy = ADO.sync; if (!sy || !sy.prev || sy.applying || sy.result) { return; }
    sy.applying = true; sy.aerr = null; render();
    askAdo('syncApply', { storyId: sy.storyId, planId: sy.prev.planId }).then((r) => {
      if (ADO.sync !== sy) { return; }
      sy.applying = false;
      if (r.ok) { sy.result = r; announce(r.message); } else { sy.aerr = r; }
      render();
    });
  }

  function syncPage(id) {
    const st = storyById(id);
    if (!st) { return notFound('story'); }
    const head = `<div class="phead"><div><h1 class="ptitle" id="page-title" tabindex="-1"><span class="sid">${esc(st.id)}</span> Sync to Azure DevOps</h1><p class="sub">Preview what will be written, then confirm. ${esc(st.title)}</p></div></div>`;
    const gate = gatePanel();
    if (gate) { return header() + toastHtml() + head + gate; }
    const sy = ADO.sync;
    if (!sy || sy.loading) { return header() + toastHtml() + head + '<section class="panel"><div class="empty slim" role="status"><h3>Checking Azure DevOps</h3><p>Reading the story and its tracking Task, and working out what would change. Nothing is written yet.</p></div></section>'; }
    if (sy.err) { return header() + toastHtml() + head + `<section class="panel"><div class="empty slim"><h3>Cannot sync this story yet</h3><p role="alert">${esc(sy.err)}</p><div class="factions"><button class="btn" data-act="sagain">Try again</button><button class="btn" data-act="editstory" data-key="${esc(st.id)}">Edit the story</button></div></div></section>`; }
    if (sy.info) { return header() + toastHtml() + head + `<section class="panel"><div class="empty slim"><h3>Nothing to sync</h3><p>${esc(sy.info)}</p><div class="factions"><button class="btn" data-act="back">&larr; Back</button></div></div></section>`; }
    const p = sy.prev, t = p.totals, c = p.changes;
    const row = (label, n, why) => `<tr><td>${label}</td><td class="r"><b data-k="${esc(label.toLowerCase().replace(/[^a-z]+/g, '-'))}">${n}</b></td><td class="hint">${why}</td></tr>`;
    const effText = { none: 'No traditional effort is recorded yet, so none is written.', added: 'The traditional effort will be added.', updated: 'The traditional effort will be updated.', unchanged: 'The traditional effort is already there and unchanged.' }[p.effortChange] || '';
    const done = sy.result;
    const warn = [];
    if (p.target.duplicates && p.target.duplicates.length) { warn.push(`More than one AI Delivery Insights task exists under this story (${p.target.duplicates.map((d) => '#' + d).join(', ')} besides #${p.target.taskId}). Only #${p.target.taskId} is updated; the others are left alone.`); }
    if (p.replacesUnreadable) { warn.push('The existing task description is not an AI Delivery Insights report, so syncing will replace it. Copy anything you want to keep first.'); }
    let result = '';
    if (done) {
      result = `<section class="panel"><h2>Done <span>${done.noop ? 'nothing changed' : done.created ? 'task created' : 'task updated'}</span></h2><p role="status"><b>${esc(done.message)}</b></p>
        <div class="factions">${done.taskId ? `<button class="btn primary" data-act="aopen" data-key="${esc(st.id)}" data-kind="task">Open the task in Azure DevOps</button>` : ''}<button class="btn" data-act="back">&larr; Back to the story</button></div></section>`;
    } else if (sy.aerr) {
      const a = sy.aerr;
      result = `<section class="panel"><h2>Not synced <span>nothing was written</span></h2><p class="ferr" role="alert">${esc(a.error)}</p><div class="factions">${a.expired || a.replan ? '<button class="btn primary" data-act="sagain">Review again</button>' : '<button class="btn" data-act="sagain">Start over</button>'}</div></section>`;
    }
    const actions = done || sy.aerr ? '' : `<div class="factions">${p.changed
      ? `<button class="btn primary" data-act="sapply" data-fid="sapply" ${sy.applying ? 'disabled' : ''}>${sy.applying ? 'Syncing...' : p.creating ? 'Create the task' : 'Update the task'}</button>`
      : '<button class="btn primary" data-act="sapply" data-fid="sapply" disabled>Already up to date</button>'}<button class="btn" data-act="back">Cancel</button></div>`;
    // once it has been written the preview is no longer news: show the outcome, the numbers and the report as previewed
    return header() + toastHtml() + head + result + (done ? '' :
      `<section class="panel"><h2>Target <span>${p.creating ? 'a new task will be created' : 'the existing task will be updated'}</span></h2><dl class="kvs">
        <div class="kv"><dt>Story</dt><dd>#${p.target.adoId} ${esc(p.target.title)} <span class="hint">${esc(p.target.type)}, ${esc(p.target.state)}, ${esc(p.target.project)}</span></dd></div>
        <div class="kv"><dt>Task</dt><dd>${p.creating ? 'A child Task titled "Copilot Lens usage" will be created under the story.' : `Task #${p.target.taskId} under the story. Its description is replaced; nothing is added twice.`}</dd></div></dl>
        ${warn.length ? `<div class="notice" role="alert"><ul>${warn.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}</section>`) +
      `<section class="band flat"><div class="hero"><div class="big" data-k="credits" data-v="${t.credits}">${fmtC(t.credits)}<span class="unit">credits</span></div><div class="usd">about ${usd(t.credits)}</div></div>
        <div class="stat"><div class="v" data-k="sessions" data-v="${t.session_count}">${t.session_count}</div><div class="l">sessions</div><div class="d">${t.user_initiated_interaction_count} prompts</div></div>
        <div class="stat"><div class="v">${fmtN(t.input_tokens + t.output_tokens)}</div><div class="l">tokens</div><div class="d">${fmtN(t.input_tokens)} in, ${fmtN(t.output_tokens)} out</div></div>
        <div class="stat"><div class="v">${p.effort ? esc(fmtH(p.effort.hours)) : '-'}</div><div class="l">without AI</div><div class="d">${p.effort ? (p.effort.source === 'manual' ? 'entered by hand' : esc(p.effort.confidence) + ' confidence') : 'not recorded'}</div></div></section>` +
      (done ? '' : `<section class="panel"><h2>What will change <span>sessions are matched by their ID, so none is counted twice</span></h2><div class="tbl-wrap"><table class="tbl compact"><thead><tr><th scope="col">Sessions</th><th class="r" scope="col">Count</th><th scope="col">Meaning</th></tr></thead><tbody>
        ${row('New', c.added, 'Tagged to this story here, not yet in the task.')}${row('Updated', c.updated, 'Already in the task, with new numbers because you kept using the session.')}${row('Unchanged', c.unchanged, 'Already in the task, same numbers.')}${row('Removed', c.removed, 'Synced from this machine before, and since untagged from this story.')}${row('From other people', c.others, 'Synced from other machines. They are kept exactly as they are.')}</tbody></table></div>
        <p class="hint">${esc(effText)}${p.contributors.length > 1 ? ` The task has ${np(p.contributors.length, 'contributor')}.` : ''}</p></section>`) +
      (actions ? `<section class="panel"><h2>Confirm <span>${p.creating ? 'creates one Task' : 'replaces one Task description'}</span></h2><p class="hint">Only the report below is written, to the Task. Your story and everything else in Azure DevOps stay as they are.</p>${actions}</section>` : '') +
      `<section class="panel"><h2>The JSON <span>${p.json.length.toLocaleString()} characters${p.jsonTruncated ? ' shown, the rest is cut for display only' : ''}${done ? ', as previewed' : ''}</span></h2><details><summary>${done ? 'Show what was written to the task' : 'Show what will be written to the task'}</summary><pre class="json" tabindex="0" aria-label="Report JSON">${esc(p.json)}</pre></details>
        <p class="hint">Counts, credits, tokens, model and agent names, phases and dates. No prompt text, session titles, file names or paths.</p></section>`;
  }

  /* ---------- story page pieces ---------- */

  function storyAdoPanels(st) {
    const eff = effortOf(st.id);
    const num = Core.adoIdOf(st);
    const link = adoLink(st.id);
    const left = eff
      ? `<div class="effrow"><div class="effbig" data-k="effort" data-v="${eff.hours}">${esc(fmtH(eff.hours))}</div><div class="hint">${eff.source === 'manual' ? 'Entered by hand' : `Estimated from the code, ${esc(eff.confidence)} confidence`}${eff.low != null ? `. Range ${esc(fmtH(eff.low))} to ${esc(fmtH(eff.high))}` : ''}${eff.setAt ? '. Saved ' + esc(ago(eff.setAt)) : ''}.</div></div>`
      : '<p>Not captured yet. This is how long the work would have taken without AI.</p>';
    const leftBtns = `<button class="btn ${eff ? '' : 'primary'}" data-act="nav" data-name="effort" data-id="${esc(st.id)}">${eff ? 'Recalculate or change' : 'Capture effort without AI'}</button>`;
    let right;
    if (num == null) {
      right = '<p>This story has no Azure DevOps number yet. Edit the story and enter the work item number to sync it.</p><div class="factions"><button class="btn" data-act="editstory" data-key="' + esc(st.id) + '">Edit the story</button></div>';
    } else {
      const kv = (k, v) => `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`;
      right = `<dl class="kvs">${kv('Work item', '#' + num + (link && link.type ? ' ' + esc(link.type) : ''))}${link && link.state ? kv('State', esc(link.state)) : ''}${link && link.project ? kv('Project', esc(link.project)) : ''}${link && link.iteration ? kv('Iteration', esc(link.iteration)) : ''}` +
        `${kv('Tracking task', link && link.taskId ? '#' + link.taskId : 'none yet')}${kv('Last synced', link && link.syncedAt ? `${esc(fDate(link.syncedAt, { month: 'short', day: 'numeric', year: 'numeric' }))} (${esc(ago(link.syncedAt))}), ${np(link.sessions.length, 'session')}` : 'never')}</dl>` +
        `<div class="factions"><button class="btn primary" data-act="nav" data-name="sync" data-id="${esc(st.id)}">Sync to Azure DevOps</button>` +
        (adoOn() ? `<button class="btn" data-act="aopen" data-key="${esc(st.id)}" data-kind="story">Open work item</button>${link && link.taskId ? `<button class="btn" data-act="aopen" data-key="${esc(st.id)}" data-kind="task">Open task</button>` : ''}<button class="btn" data-act="arefresh" data-key="${esc(st.id)}">Refresh</button>` : '') + '</div>' +
        (ADO.status && !adoOn() ? '<p class="hint">Azure DevOps is off. <button class="linkish" data-act="nav" data-name="connect">Connect</button> to sync.</p>' : '');
    }
    return `<div class="grid2 even"><section class="panel"><h2>Effort without AI <span>traditional</span></h2>${left}<div class="factions">${leftBtns}</div></section><section class="panel"><h2>Azure DevOps <span>${num == null ? 'not linked' : '#' + num}</span></h2>${right}</section></div>`;
  }

  function adoChip() {
    if (!ADO.status) { return ''; }
    const s = ADO.status;
    return s.enabled && s.trusted ? `<span class="pill story" title="Connected to ${esc(s.organization)}">Azure DevOps: ${esc(s.organization)}</span>` : '<span class="pill">Azure DevOps: off</span>';
  }

  /* ---------- events ---------- */
  function persist() { const { shown, uShown, form, sel, toast, bulk, confirmDelete, bQ, ...rest } = S; vscode.setState(rest); }

  function bindTop() { bindSearch('#q', 'q'); bindSearch('#sq', 'sQ'); bindSearch('#bq', 'bQ'); }

  function bindSearch(sel, key) {
    const q = $(sel);
    if (!q) { return; }
    q.addEventListener('input', () => {
      S[key] = q.value; S.shown = 25; S.uShown = 25; persist();
      clearTimeout(bindSearch.t);
      bindSearch.t = setTimeout(() => { const pos = q.selectionStart; render(); const nq = $(sel); if (nq) { nq.focus(); nq.setSelectionRange(pos, pos); } }, 180);
    });
  }

  document.addEventListener('input', (e) => {
    const f = e.target.closest && e.target.closest('[data-f]');
    if (f && S.form) { S.form[f.dataset.f] = f.value; }
    const ef = e.target.closest && e.target.closest('[data-ef]');
    if (ef && ADO.effort && (ef.dataset.ef === 'manual' || ef.dataset.ef === 'note')) { ADO.effort[ef.dataset.ef] = ef.value; ADO.effort.merr = ''; }
  });

  document.addEventListener('submit', (e) => {
    if (e.target.closest && e.target.closest('[data-form="story"]')) { e.preventDefault(); submitForm(); }
    if (e.target.closest && e.target.closest('[data-form="effort"]')) { e.preventDefault(); saveManual(); }
  });

  function applyDates() {
    S.from = dateDraft.from; S.to = dateDraft.to; S.shown = 25; persist(); render();
  }

  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.closest && e.target.closest('[data-date]') && e.key === 'Enter') { e.preventDefault(); applyDates(); return; }
    if (S.route.name === 'dash' && !S.form) { return; }
    const tag = (e.target && e.target.tagName) || '';
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || !!(e.target && e.target.isContentEditable);
    if (e.key === 'Escape' && S.form) { e.preventDefault(); S.form = null; render(); return; }
    if (S.route.name === 'dash') { return; }
    if ((e.altKey && e.key === 'ArrowLeft') || (e.key === 'Escape' && !typing)) { e.preventDefault(); back(); }
  });

  document.addEventListener('change', (e) => {
    const dt = e.target.closest('[data-date]');
    if (dt) {
      const which = dt.dataset.date;
      dateDraft[which] = parseDay(dt.value) != null ? dt.value : '';
      // Keep the pair ordered without surprising the person: the date they just edited wins and the
      // other one follows it (so moving From past To gives a one-day window they can then widen).
      if (dateDraft.from && dateDraft.to && dateDraft.from > dateDraft.to) { if (which === 'from') { dateDraft.to = dateDraft.from; } else { dateDraft.from = dateDraft.to; } }
      render();
      const again = $(`[data-date="${which}"]`); if (again) { again.focus(); }
      return;
    }
    const ss = e.target.closest('[data-sel-story]');
    if (ss) { onStoryChoice(ss); return; }
    const sp = e.target.closest('[data-sel-phase]');
    if (sp) { onPhaseChoice(sp); return; }
    const ap = e.target.closest('[data-ado-project]');
    if (ap) { if (ADO.backlog && ADO.backlog.projects.includes(ap.value)) { ADO.backlog.project = ap.value; startBacklog(ADO.backlog); } return; }
    const ab = e.target.closest('[data-ado-board]');
    if (ab) {
      const b = ADO.backlog;
      if (b && (ab.value === '' || b.boards.some((x) => x.id === ab.value))) {
        b.board = ab.value; S.adoBoards[b.project] = ab.value; persist(); b.sel = new Set(); fetchBacklog(b);
      }
      return;
    }
    const sel = e.target.closest('[data-sel]');
    if (!sel) { return; }
    S[sel.dataset.sel] = sel.value; S.shown = 25; S.uShown = 25; persist(); render();
  });

  document.addEventListener('click', (e) => {
    const setBtn = e.target.closest('[data-set]');
    if (setBtn) {
      const k = setBtn.dataset.set; S[k] = k === 'range' ? Number(setBtn.dataset.v) : setBtn.dataset.v;
      if (k === 'range') { S.from = ''; S.to = ''; dateDraft = { from: '', to: '' }; } // picking a quick range replaces any custom dates
      S.shown = 25; persist(); render(); return;
    }
    const a = e.target.closest('[data-act]');
    if (!a) { return; }
    const key = a.dataset.key;
    switch (a.dataset.act) {
      case 'nav': go({ name: a.dataset.name, id: a.dataset.id, key: a.dataset.key }, { replace: a.dataset.replace === '1' }); break;
      case 'back': back(); break;
      case 'crumb': goCrumb(Number(a.dataset.i)); break;
      case 'toastx': S.toast = null; render(); break;
      case 'newstory': openForm({}); break;
      case 'editstory': { const st = storyById(key); if (st) { openForm({ mode: 'edit', id: st.id, title: st.title, points: st.points == null ? '' : String(st.points), budget: st.budget == null ? '' : String(st.budget), group: st.group, adoId: st.adoId == null ? '' : String(st.adoId) }); } break; }
      case 'formcancel': S.form = null; render(); break;
      case 'delask': S.confirmDelete = key; render(); break;
      case 'delcancel': S.confirmDelete = ''; render(); break;
      case 'deldo': sendOp({ type: 'deleteStory', id: key }); break;
      case 'exportstory': { const w = S.storyWin === 'dash' ? getWindow() : null; vscode.postMessage({ type: 'export', storyId: key, from: w && !w.all ? w.from : null, to: w && !w.all ? w.end - 1 : null }); break; }
      case 'newtab': vscode.postMessage({ type: 'newTab', route: S.route }); break;
      case 'cmd': if (['exportTags', 'importTags', 'adoConnect', 'adoSetToken', 'adoClearToken', 'adoDisconnect'].includes(a.dataset.cmd)) { vscode.postMessage({ type: 'command', name: a.dataset.cmd }); } break;
      case 'atest': runTest(); break;
      case 'aopen': askAdo('open', { storyId: key, kind: a.dataset.kind === 'task' ? 'task' : 'story' }).then((r) => { if (!r.ok) { toastNow(false, r.error); } }); break;
      case 'arefresh': askAdo('refresh', { storyId: key }).then((r) => { toastNow(!!r.ok, r.ok ? `Refreshed from Azure DevOps: ${r.item.type} ${r.item.id} is ${r.item.state}.` : r.error); }); break;
      case 'bretry': ADO.backlog = null; render(); break;
      case 'bsel': { const b = ADO.backlog, id = Number(key); if (b) { if (b.sel.has(id)) { b.sel.delete(id); } else { b.sel.add(id); } render(); } break; }
      case 'ball': {
        const b = ADO.backlog; if (!b) { break; }
        const q = (S.bQ || '').trim().toLowerCase();
        const ids = (b.items || []).filter((x) => !x.imported && (!q || `${x.id} ${x.title} ${x.type} ${x.state} ${x.iteration}`.toLowerCase().includes(q))).map((x) => x.id);
        if (ids.length && ids.every((id) => b.sel.has(id))) { ids.forEach((id) => b.sel.delete(id)); } else { ids.forEach((id) => b.sel.add(id)); }
        render(); break;
      }
      case 'bimport': doImport(); break;
      case 'csel': { const e2 = ADO.effort; if (e2 && e2.res) { if (e2.selected.has(key)) { e2.selected.delete(key); } else { e2.selected.add(key); } recompute(); } break; }
      case 'call': { const e2 = ADO.effort; if (e2 && e2.res) { e2.selected = new Set(e2.res.commits.map((c) => c.key)); recompute(); } break; }
      case 'cnone': { const e2 = ADO.effort; if (e2 && e2.res) { e2.selected = new Set(); recompute(); } break; }
      case 'ereload': ADO.effort = null; render(); break;
      case 'esave': saveEstimate(false); break;
      case 'esave2': saveEstimate(true); break;
      case 'esavecancel': if (ADO.effort) { ADO.effort.confirm = false; render(); } break;
      case 'eclearask': ADO.confirmClear = key; render(); break;
      case 'eclearcancel': ADO.confirmClear = ''; render(); break;
      case 'eclear': ADO.confirmClear = ''; sendOp({ type: 'clearEffort', storyId: key }); break;
      case 'sapply': applySync(); break;
      case 'sagain': ADO.sync = null; render(); break;
      case 'grp': S.sGroup = S.sGroup === key ? 'all' : key; persist(); render(); break;
      case 'selrow': if (S.sel.has(key)) { S.sel.delete(key); } else { S.sel.add(key); } render(); break;
      case 'selall': {
        const shown = untaggedList().filter((x) => S.uWs === 'all' || x.s.wsKey === S.uWs).map((x) => x.s.id);
        if (shown.length && shown.every((id) => S.sel.has(id))) { shown.forEach((id) => S.sel.delete(id)); } else { shown.forEach((id) => S.sel.add(id)); }
        render(); break;
      }
      case 'umore': S.uShown += 25; render(); break;
      case 'bulkapply':
        if (!S.sel.size || !storyById(S.bulk)) { S.toast = { ok: false, text: 'Tick some sessions and choose a story first.' }; render(); break; }
        sendOp({ type: 'tagSessions', ids: [...S.sel].slice(0, Core.LIMITS.bulk), storyId: S.bulk, onlyUntagged: true }); break;
      case 'sugtag': sendOp({ type: 'tagSessions', ids: [a.dataset.sid], storyId: a.dataset.story }); break;
      case 'sugnew': openForm({ id: a.dataset.num, label: 'will tag this session', apply: { kind: 'sessions', ids: [a.dataset.sid] } }); break;
      case 'clearov': { const sid = a.dataset.sid; sendOp({ type: 'tagSessions', ids: [sid], storyId: Core.hasOwn(STORE.sessionTags, sid) ? STORE.sessionTags[sid] : null, clearOverrides: true }); break; }
      case 'rescan': vscode.postMessage({ type: 'rescan' }); break;
      case 'export': { const w = getWindow(); vscode.postMessage({ type: 'export', from: w.all ? null : w.from, to: w.all ? null : w.end - 1 }); break; }
      case 'applydates': applyDates(); break;
      case 'cleardates': S.from = ''; S.to = ''; dateDraft = { from: '', to: '' }; S.shown = 25; persist(); render(); break;
      case 'ws': S.ws = S.ws === key ? 'all' : key; S.shown = 25; persist(); render(); break;
      case 'here': S.ws = S.ws === key ? 'all' : key; S.shown = 25; persist(); render(); break;
      case 'model': S.model = S.model === key ? 'all' : key; S.shown = 25; persist(); render(); break;
      case 'tag': S.tag = S.tag === key ? 'all' : key; S.shown = 25; persist(); render(); break;
      case 'cleartag': S.tag = 'all'; persist(); render(); break;
      case 'phase': if (Core.validPhase(key)) { S.phase = S.phase === key ? 'all' : key; S.shown = 25; persist(); render(); } break;
      case 'clearphase': S.phase = 'all'; persist(); render(); break;
      case 'tab': S.tab = key; persist(); render(); break;
      case 'more': S.shown += 25; render(); break;
      case 'sess': if (expanded.has(key)) { expanded.delete(key); } else { expanded.add(key); } render(); break;
      case 'ptext': if (openPrompts.has(key)) { openPrompts.delete(key); } else { openPrompts.add(key); } a.classList.toggle('open'); break;
      case 'open-ws': vscode.postMessage({ type: 'openFolder', path: a.dataset.path }); break;
      case 'reveal': vscode.postMessage({ type: 'reveal', path: a.dataset.path }); break;
      default: break;
    }
  });

  let resizeT;
  new ResizeObserver(() => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (DATA && $('#chart') && AFTER) { AFTER(); } }, 120);
  }).observe(document.body);

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m !== 'object') { return; }
    if (m.type === 'progress') {
      SCANNING = m;
      const bar = $('#bar'); if (bar) { bar.style.width = (m.total ? (m.done / m.total) * 100 : 0) + '%'; }
      if (!DATA) { render(); }
    } else if (m.type === 'data') {
      SCANNING = null; DATA = m.payload; CURRENT = m.current || CURRENT; ALLOWANCE = m.allowance || 0;
      const bar = $('#bar'); if (bar) { bar.style.width = '0'; }
      prepare(DATA);
      if (S.ws !== 'all' && !DATA.workspaces[S.ws]) { S.ws = 'all'; }
      render();
    } else if (m.type === 'stories') {
      onStories(m);
    } else if (m.type === 'ado') {
      const done = ADO.wait.get(m.rid);
      if (done) { ADO.wait.delete(m.rid); done(m); }
    } else if (m.type === 'adoChanged') {
      // the connection, the sign-in or the settings changed: forget what the pages loaded, read the status again
      resetAdoPages(); ADO.status = null; loadStatus(); if (DATA) { render(); }
    } else if (m.type === 'route') {
      go(m.route);
    }
  });

  render();
  vscode.postMessage({ type: 'ready' });
  loadStatus(); // settings only: reading it sends nothing to Azure DevOps
})();
