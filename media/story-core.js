/**
 * AI Delivery Insights story core.
 *
 * Pure functions shared by the extension host (Node) and the dashboard (webview): story validation,
 * which story a prompt belongs to, totals, breakdowns, suggestions and waste signals.
 * No DOM, no vscode, no file or network access. Loaded by the webview as a classic script and by
 * the host with require().
 *
 * Model
 *   store.stories[id]            { id, title, points|null, budget|null, group, created, updated }
 *   store.sessionTags[sessionId] storyId
 *   store.promptTags[sessionId][promptKey]   storyId | null   (null = explicitly "no story")
 *   store.phaseTags[sessionId][promptKey]    phase key (a lifecycle phase set by hand; otherwise it is guessed)
 *   store.efforts[storyId]       the story's traditional (no-AI) effort: an estimate or a number someone typed
 *   store.ado[storyId]           what this machine knows about the story's Azure DevOps side (state, tracking task, last sync)
 *   story.adoId                  the Azure DevOps work item number, when it is not simply the story ID
 *
 * A prompt's story is its own tag if it has one, otherwise its session's tag. Background calls
 * (session titles and unmatched calls) follow their session.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.StoryCore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = { stories: 2000, sessionTags: 50000, promptTags: 100000, phaseTags: 100000, bulk: 1000, id: 40, title: 120, group: 60, points: 1000, budget: 10000000, key: 200, efforts: 2000, ado: 2000, adoSessions: 5000, hours: 100000, adoId: 2147483647 };
  const RESERVED = ['inherit', 'none', 'all', 'new', '__new__'];
  const ID_RE = /^[A-Za-z0-9][A-Za-z0-9#._:\-]{0,39}$/;
  const RETRY_GAP_MS = 10 * 60 * 1000;
  const RETRY_SIMILARITY = 0.6;
  const BUDGET_WARN = 0.8;

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const dict = () => Object.create(null);
  // The shape of an Azure DevOps organisation name (same rule as lib/ado.js).
  const ORG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;
  const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

  /* ---------- validation ---------- */

  function validId(id) {
    return typeof id === 'string' && ID_RE.test(id) && !RESERVED.includes(id.toLowerCase());
  }

  function optionalNumber(v, max, label) {
    if (v === '' || v == null) { return { ok: true, value: null }; }
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    if (!Number.isFinite(n) || n <= 0 || n > max) { return { ok: false, error: `${label} must be a number above 0 and at most ${max}, or left empty.` }; }
    return { ok: true, value: Math.round(n * 100) / 100 };
  }

  /** A whole number from 1 to `max`, or empty (null). */
  function optionalWholeNumber(v, max, label) {
    if (v === '' || v == null) { return { ok: true, value: null }; }
    const n = typeof v === 'number' ? v : (/^\s*\d{1,10}\s*$/.test(String(v)) ? Number(String(v).trim()) : NaN);
    if (!Number.isInteger(n) || n < 1 || n > max) { return { ok: false, error: `${label} must be a whole number from 1 to ${max}, or left empty.` }; }
    return { ok: true, value: n };
  }

  /**
   * The Azure DevOps work item number of a story: the number typed in "Azure DevOps ID", otherwise the story ID
   * when it is just a number ("1234" or "AB#1234"), otherwise null (a story called "US-12" must say which item it is).
   */
  function adoIdOf(story) {
    if (!story || typeof story !== 'object') { return null; }
    if (Number.isInteger(story.adoId) && story.adoId >= 1 && story.adoId <= LIMITS.adoId) { return story.adoId; }
    const m = /^(?:AB#)?(\d{1,9})$/i.exec(String(story.id == null ? '' : story.id));
    const n = m ? Number(m[1]) : NaN;
    return Number.isInteger(n) && n >= 1 ? n : null;
  }

  /* ---------- effort (traditional, no-AI) and Azure DevOps link ---------- */

  const EFFORT_SOURCES = ['estimated', 'manual'];
  const EFFORT_CONFIDENCE = ['high', 'medium', 'low', 'manual'];
  const EFFORT_INPUTS = ['commits', 'prodLines', 'testLines', 'files', 'points'];
  const posNum = (v, max) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? Math.round(v * 10) / 10 : null);

  /** Validate one effort record from untrusted input. Hours are rounded to a tenth. */
  function normalizeEffort(raw) {
    if (!raw || typeof raw !== 'object') { return { ok: false, error: 'Missing effort.' }; }
    const hours = posNum(typeof raw.hours === 'string' && raw.hours.trim() !== '' ? Number(raw.hours) : raw.hours, LIMITS.hours);
    if (hours == null) { return { ok: false, error: `Effort must be a number of hours above 0 and at most ${LIMITS.hours}.` }; }
    const source = EFFORT_SOURCES.includes(raw.source) ? raw.source : 'manual';
    let low = posNum(raw.low, LIMITS.hours), high = posNum(raw.high, LIMITS.hours);
    if (low == null || high == null || low > hours || high < hours) { low = null; high = null; }
    const inputs = {};
    if (raw.inputs && typeof raw.inputs === 'object') {
      for (const k of EFFORT_INPUTS) { const v = raw.inputs[k]; if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e9) { inputs[k] = Math.round(v * 10) / 10; } }
    }
    const effort = {
      hours, low, high, source,
      method: source === 'estimated' && raw.method === 'size-v1' ? 'size-v1' : '',
      confidence: source === 'manual' ? 'manual' : (EFFORT_CONFIDENCE.includes(raw.confidence) && raw.confidence !== 'manual' ? raw.confidence : 'low'),
      setAt: Number.isFinite(raw.setAt) ? raw.setAt : 0,
      note: clean(raw.note, 200),
      inputs: source === 'estimated' ? inputs : {},
    };
    return { ok: true, effort };
  }

  /** Validate what this machine remembers about a story's Azure DevOps side. Returns null when there is nothing worth keeping. */
  function normalizeAdoLink(raw) {
    if (!raw || typeof raw !== 'object') { return null; }
    const int = (v) => (Number.isInteger(v) && v >= 1 && v <= LIMITS.adoId ? v : null);
    const sessions = [];
    if (Array.isArray(raw.sessions)) {
      const seen = new Set();
      for (const x of raw.sessions) {
        if (sessions.length >= LIMITS.adoSessions) { break; }
        if (typeof x === 'string' && x && x.length <= LIMITS.key && x !== '__proto__' && !seen.has(x)) { seen.add(x); sessions.push(x); }
      }
    }
    // org and adoId say which organisation and which work item this was read from or written to. A link made in one organisation is
    // never trusted in another, and the person is asked again before a new target is written to.
    const link = {
      org: typeof raw.org === 'string' && ORG_RE.test(raw.org) ? raw.org.toLowerCase() : '', adoId: int(raw.adoId),
      project: clean(raw.project, 64), type: clean(raw.type, 60), state: clean(raw.state, 60), iteration: clean(raw.iteration, 200),
      fetchedAt: Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : 0,
      taskId: int(raw.taskId), hash: typeof raw.hash === 'string' && /^[0-9a-f]{64}$/.test(raw.hash) ? raw.hash : '',
      syncedAt: Number.isFinite(raw.syncedAt) ? raw.syncedAt : 0, sessions,
    };
    const empty = !link.project && !link.type && !link.state && !link.iteration && !link.taskId && !link.hash && !link.sessions.length;
    return empty ? null : link;
  }

  /** Validate and normalise one story from untrusted input. */
  function normalizeStory(raw) {
    if (!raw || typeof raw !== 'object') { return { ok: false, error: 'Missing story.' }; }
    const id = typeof raw.id === 'string' ? raw.id.trim() : (typeof raw.id === 'number' ? String(raw.id) : '');
    if (RESERVED.includes(id.toLowerCase())) { return { ok: false, error: `"${id}" is reserved. Choose another story ID.` }; }
    if (!validId(id)) { return { ok: false, error: 'Story ID must be 1 to 40 characters: letters, digits and # . _ : - (starting with a letter or digit).' }; }
    const title = clean(raw.title, LIMITS.title);
    if (!title) { return { ok: false, error: 'Give the story a title.' }; }
    const pts = optionalNumber(raw.points, LIMITS.points, 'Story points');
    if (!pts.ok) { return pts; }
    const bud = optionalNumber(raw.budget, LIMITS.budget, 'Credit budget');
    if (!bud.ok) { return bud; }
    const ado = optionalWholeNumber(raw.adoId, LIMITS.adoId, 'Azure DevOps ID');
    if (!ado.ok) { return ado; }
    const story = {
      id, title, points: pts.value, budget: bud.value, group: clean(raw.group, LIMITS.group), adoId: ado.value,
      created: Number.isFinite(raw.created) ? raw.created : 0, updated: Number.isFinite(raw.updated) ? raw.updated : 0,
    };
    return { ok: true, story };
  }

  function emptyStore() { return { version: 1, stories: dict(), sessionTags: dict(), promptTags: dict(), phaseTags: dict(), efforts: dict(), ado: dict() }; }

  /** Build a clean store from untrusted data (a file, or a message). Drops anything invalid; never throws. */
  function normalizeStore(raw) {
    const out = emptyStore();
    if (!raw || typeof raw !== 'object') { return out; }
    const list = Array.isArray(raw.stories) ? raw.stories : (raw.stories && typeof raw.stories === 'object' ? Object.values(raw.stories) : []);
    for (const item of list) {
      if (Object.keys(out.stories).length >= LIMITS.stories) { break; }
      const r = normalizeStory(item);
      if (r.ok && !hasOwn(out.stories, r.story.id)) { out.stories[r.story.id] = r.story; }
    }
    let n = 0;
    if (raw.sessionTags && typeof raw.sessionTags === 'object') {
      for (const [sid, sv] of Object.entries(raw.sessionTags)) {
        if (n >= LIMITS.sessionTags) { break; }
        if (typeof sid === 'string' && sid.length > 0 && sid.length <= LIMITS.key && sid !== '__proto__' && typeof sv === 'string' && hasOwn(out.stories, sv)) { out.sessionTags[sid] = sv; n++; }
      }
    }
    n = 0;
    if (raw.promptTags && typeof raw.promptTags === 'object') {
      for (const [sid, m] of Object.entries(raw.promptTags)) {
        if (typeof sid !== 'string' || !sid || sid === '__proto__' || sid.length > LIMITS.key || !m || typeof m !== 'object') { continue; }
        for (const [pk, pv] of Object.entries(m)) {
          if (n >= LIMITS.promptTags) { break; }
          if (typeof pk !== 'string' || !pk || pk === '__proto__' || pk.length > LIMITS.key) { continue; }
          if (pv === null || (typeof pv === 'string' && hasOwn(out.stories, pv))) {
            if (!out.promptTags[sid]) { out.promptTags[sid] = dict(); }
            out.promptTags[sid][pk] = pv; n++;
          }
        }
      }
    }
    n = 0;
    if (raw.phaseTags && typeof raw.phaseTags === 'object') {
      for (const [sid, m] of Object.entries(raw.phaseTags)) {
        if (typeof sid !== 'string' || !sid || sid === '__proto__' || sid.length > LIMITS.key || !m || typeof m !== 'object') { continue; }
        for (const [pk, pv] of Object.entries(m)) {
          if (n >= LIMITS.phaseTags) { break; }
          if (typeof pk !== 'string' || !pk || pk === '__proto__' || pk.length > LIMITS.key) { continue; }
          if (typeof pv === 'string' && PHASE_KEYS.includes(pv)) {
            if (!out.phaseTags[sid]) { out.phaseTags[sid] = dict(); }
            out.phaseTags[sid][pk] = pv; n++;
          }
        }
      }
    }
    n = 0;
    if (raw.efforts && typeof raw.efforts === 'object') {
      for (const [id, e] of Object.entries(raw.efforts)) {
        if (n >= LIMITS.efforts) { break; }
        if (!hasOwn(out.stories, id)) { continue; }
        const r = normalizeEffort(e);
        if (r.ok) { out.efforts[id] = r.effort; n++; }
      }
    }
    n = 0;
    if (raw.ado && typeof raw.ado === 'object') {
      for (const [id, l] of Object.entries(raw.ado)) {
        if (n >= LIMITS.ado) { break; }
        if (!hasOwn(out.stories, id)) { continue; }
        const link = normalizeAdoLink(l);
        if (link) { out.ado[id] = link; n++; }
      }
    }
    return out;
  }

  const cloneStore = (s) => normalizeStore(toPlain(s));

  /** A JSON-safe, ordered copy (stories as an array) for saving or exporting. */
  function toPlain(store) {
    const stories = Object.values(store.stories).sort((a, b) => (a.created - b.created) || (a.id < b.id ? -1 : 1));
    const sessionTags = {}; for (const k of Object.keys(store.sessionTags)) { sessionTags[k] = store.sessionTags[k]; }
    const promptTags = {};
    for (const sid of Object.keys(store.promptTags)) {
      const m = store.promptTags[sid]; const o = {};
      for (const k of Object.keys(m)) { o[k] = m[k]; }
      if (Object.keys(o).length) { promptTags[sid] = o; }
    }
    const phaseTags = {};
    for (const sid of Object.keys(store.phaseTags || {})) {
      const m = store.phaseTags[sid]; const o = {};
      for (const k of Object.keys(m)) { o[k] = m[k]; }
      if (Object.keys(o).length) { phaseTags[sid] = o; }
    }
    const efforts = {};
    for (const id of Object.keys(store.efforts || {})) { efforts[id] = { ...store.efforts[id], inputs: { ...store.efforts[id].inputs } }; }
    const ado = {};
    for (const id of Object.keys(store.ado || {})) { ado[id] = { ...store.ado[id], sessions: store.ado[id].sessions.slice() }; }
    return { version: 1, stories, sessionTags, promptTags, phaseTags, efforts, ado };
  }

  /* ---------- which story does a prompt belong to ---------- */

  /** Key of a prompt inside its session. Timestamps survive re-indexing; the index is the fallback. */
  const promptKey = (p) => (p.ts ? String(p.ts) : '#' + p.i);

  /** Story id for a row ({p, s, ov}), or null. */
  function storyOf(store, r) {
    if (!store) { return null; }
    if (!r.ov) {
      const m = hasOwn(store.promptTags, r.s.id) ? store.promptTags[r.s.id] : null;
      const k = promptKey(r.p);
      if (m && hasOwn(m, k)) { return m[k]; }
    }
    return hasOwn(store.sessionTags, r.s.id) ? store.sessionTags[r.s.id] : null;
  }

  /** 'override' | 'session' | 'none' - where the row's story comes from. */
  function sourceOf(store, r) {
    if (!store) { return 'none'; }
    if (!r.ov) {
      const m = hasOwn(store.promptTags, r.s.id) ? store.promptTags[r.s.id] : null;
      if (m && hasOwn(m, promptKey(r.p))) { return 'override'; }
    }
    return hasOwn(store.sessionTags, r.s.id) ? 'session' : 'none';
  }

  /* ---------- rows ---------- */

  /**
   * One row per prompt, plus one per session for its background calls.
   * @returns {{rows: object[], wsTotals: Object<string, number>}}
   */
  function buildRows(data) {
    const rows = []; const wsTotals = {};
    for (const s of data.sessions) {
      for (const p of s.prompts) {
        const ts = p.ts || s.created || 0;
        rows.push({ p, s, ts, ws: s.wsKey, ov: false });
        wsTotals[s.wsKey] = (wsTotals[s.wsKey] || 0) + p.credits;
      }
      if (s.overhead) {
        const o = s.overhead;
        rows.push({
          p: { credits: o.credits, inTok: o.inTok, outTok: o.outTok, cached: 0, calls: o.calls, text: 'Background calls (session titles and unmatched calls)', model: '', quality: 'exact', tag: 'Other', files: [], edited: [], tools: [], toolCalls: 0 },
          s, ts: s.last || s.created || 0, ws: s.wsKey, ov: true,
        });
        wsTotals[s.wsKey] = (wsTotals[s.wsKey] || 0) + o.credits;
      }
    }
    return { rows, wsTotals };
  }

  /* ---------- lifecycle phase ---------- */

  /** Software lifecycle phases, in the order work usually flows. [key, label] */
  const PHASES = [
    ['analysis', 'Analysis'], ['plan', 'Plan & design'], ['build', 'Build'], ['test', 'Test'], ['bugfix', 'Bug fix'],
    ['review', 'Review'], ['refactor', 'Refactor'], ['docs', 'Docs'], ['release', 'Release & ops'], ['other', 'Other'],
  ];
  const PHASE_KEYS = PHASES.map((x) => x[0]);
  const PHASE_LABEL = dict(); for (const [k, l] of PHASES) { PHASE_LABEL[k] = l; }
  const phaseLabel = (k) => (typeof k === 'string' && hasOwn(PHASE_LABEL, k) ? PHASE_LABEL[k] : '');
  const validPhase = (k) => typeof k === 'string' && PHASE_KEYS.includes(k);

  // The prompt's work type (scanner) maps onto a phase; planning and investigating words win over it.
  const TAG_PHASE = { 'Bug fix': 'bugfix', Tests: 'test', Refactor: 'refactor', Docs: 'docs', DevOps: 'release', Review: 'review', Explain: 'analysis', Feature: 'build', Other: 'other' };
  const PLAN_RE = /\b(plan(s|ning|ned)?|roadmap|architect(ure|ural)?|design(s|ing)?|proposal|outline|break(ing)? (it |this |that )?down|approach(es)?|trade-?offs?|strategy|milestones?|acceptance criteria|user stories)\b/i;
  const ANALYSIS_RE = /\b(analy[sz](e|es|ing|is)|investigat(e|es|ing|ion)|research|estimate|feasib(le|ility)|impact|root cause|assess(ment)?|compare|comparison|evaluate)\b/i;
  const autoPhases = new WeakMap();

  /**
   * Guess the phase of one prompt (a rule of thumb, never a verdict): the Plan agent, then planning words,
   * then investigating words, then the prompt's work type. Falls back to 'other'.
   */
  function autoPhase(p) {
    let v = autoPhases.get(p);
    if (v) { return v; }
    const text = String(p.text || '');
    v = p.agent === 'Plan' || PLAN_RE.test(text) ? 'plan' : ANALYSIS_RE.test(text) ? 'analysis' : (hasOwn(TAG_PHASE, p.tag) ? TAG_PHASE[p.tag] : 'other');
    autoPhases.set(p, v);
    return v;
  }

  /** The phase of a row ({p, s, ov}): the one you set, else the guess. Background rows have none (null). */
  function phaseOf(store, r) {
    if (r.ov) { return null; }
    const m = store && store.phaseTags && hasOwn(store.phaseTags, r.s.id) ? store.phaseTags[r.s.id] : null;
    const k = promptKey(r.p);
    if (m && hasOwn(m, k) && validPhase(m[k])) { return m[k]; }
    return autoPhase(r.p);
  }

  /** 'manual' | 'auto' | null (background rows). */
  function phaseSource(store, r) {
    if (r.ov) { return null; }
    const m = store && store.phaseTags && hasOwn(store.phaseTags, r.s.id) ? store.phaseTags[r.s.id] : null;
    return m && hasOwn(m, promptKey(r.p)) && validPhase(m[promptKey(r.p)]) ? 'manual' : 'auto';
  }

  /** Per-phase totals in lifecycle order, only phases that have prompts: [{k, label, credits, tokens, prompts}]. */
  function byPhase(rows, store) {
    const m = new Map(breakdown(rows, (r) => phaseOf(store, r)).map((e) => [e.k, e]));
    return PHASES.filter(([k]) => m.has(k)).map(([k, label]) => { const e = m.get(k); return { k, label, credits: e.credits, tokens: e.tokens, prompts: e.prompts }; });
  }

  /* ---------- aggregation ---------- */

  function totals(rows) {
    const t = {
      credits: 0, inTok: 0, outTok: 0, cached: 0, cachedKnown: 0, cachedBase: 0, prompts: 0, calls: 0, sessions: 0, canceled: 0, bgCredits: 0, first: 0, last: 0,
      q: { exact: { n: 0, c: 0 }, tokens: { n: 0, c: 0 }, estimated: { n: 0, c: 0 } },
    };
    const sess = new Set();
    for (const r of rows) {
      const p = r.p;
      t.credits += p.credits || 0; t.inTok += p.inTok || 0; t.outTok += p.outTok || 0;
      sess.add(r.s.id);
      if (r.ts) { if (!t.first || r.ts < t.first) { t.first = r.ts; } if (r.ts > t.last) { t.last = r.ts; } }
      if (r.ov) { t.bgCredits += p.credits || 0; continue; }
      t.prompts++; t.calls += p.calls || 0; t.cached += p.cached || 0;
      if (p.canceled) { t.canceled++; }
      if (p.quality !== 'estimated') { t.cachedBase += p.inTok || 0; t.cachedKnown += p.cached || 0; } // share = known cached / known input: same prompts in both
      const q = t.q[p.quality] || t.q.estimated; q.n++; q.c += p.credits || 0;
    }
    t.sessions = sess.size;
    return t;
  }

  /**
   * Split rows by story. Every story in the store gets an entry, even with no rows.
   * Rows whose story id is not in the store (a deleted story) count as untagged.
   */
  function groupByStory(rows, store) {
    const byStory = new Map(); const untagged = [];
    for (const id of Object.keys(store.stories)) { byStory.set(id, []); }
    for (const r of rows) {
      const id = storyOf(store, r);
      if (id != null && byStory.has(id)) { byStory.get(id).push(r); } else { untagged.push(r); }
    }
    return { byStory, untagged };
  }

  /** Sorted [{k, credits, tokens, prompts}] for rows whose keyFn is not null. */
  function breakdown(rows, keyFn) {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r); if (k == null) { continue; }
      const e = m.get(k) || { k, credits: 0, tokens: 0, prompts: 0 };
      e.credits += r.p.credits || 0; e.tokens += (r.p.inTok || 0) + (r.p.outTok || 0); if (!r.ov) { e.prompts++; }
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.credits - a.credits);
  }

  /** Credits and tokens per prompt, for groups with at least minN prompts. Prompts only (no background rows). */
  function efficiency(rows, keyFn, minN) {
    const min = minN == null ? 3 : minN;
    return breakdown(rows.filter((r) => !r.ov), keyFn)
      .filter((e) => e.prompts >= min)
      .map((e) => ({ k: e.k, prompts: e.prompts, credits: e.credits, perPrompt: e.credits / e.prompts, tokensPerPrompt: e.tokens / e.prompts }))
      .sort((a, b) => a.perPrompt - b.perPrompt);
  }

  /** For each work type with at least two models of minN prompts: the models ranked by credits per prompt. */
  function modelByType(rows, minN) {
    const min = minN == null ? 3 : minN;
    const types = new Map();
    for (const r of rows) {
      if (r.ov || !r.p.model) { continue; }
      const t = types.get(r.p.tag) || new Map();
      const e = t.get(r.p.model) || { model: r.p.model, prompts: 0, credits: 0 };
      e.prompts++; e.credits += r.p.credits || 0; t.set(r.p.model, e); types.set(r.p.tag, t);
    }
    const out = [];
    for (const [type, mm] of types) {
      const models = [...mm.values()].filter((e) => e.prompts >= min).map((e) => ({ ...e, perPrompt: e.credits / e.prompts })).sort((a, b) => a.perPrompt - b.perPrompt);
      if (models.length >= 2) { out.push({ type, models }); }
    }
    return out.sort((a, b) => b.models.reduce((s, e) => s + e.credits, 0) - a.models.reduce((s, e) => s + e.credits, 0));
  }

  /** 'none' | 'ok' | 'warn' | 'over' with the used fraction. */
  function budgetState(story, credits) {
    if (!story || !story.budget) { return { state: 'none', pct: 0 }; }
    const f = credits / story.budget;
    return { state: f > 1 ? 'over' : f >= BUDGET_WARN ? 'warn' : 'ok', pct: f };
  }

  /** Roll stories up by their free-text group. entries: [{story, t}] with t = totals(). */
  function rollupByGroup(entries) {
    const m = new Map();
    for (const { story, t } of entries) {
      const k = story.group || '';
      const g = m.get(k) || { group: k, stories: 0, credits: 0, tokens: 0, points: 0, creditsWithPoints: 0, prompts: 0 };
      g.stories++; g.credits += t.credits; g.tokens += t.inTok + t.outTok; g.prompts += t.prompts;
      if (story.points) { g.points += story.points; g.creditsWithPoints += t.credits; }
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, perPoint: g.points ? g.creditsWithPoints / g.points : null })).sort((a, b) => b.credits - a.credits);
  }

  /* ---------- which workspace is this window ---------- */

  /** Compare paths the way the platform does: Windows drive paths ignore case and slash direction. */
  const normPath = (p) => {
    let s = String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '');
    if (/^[A-Za-z]:/.test(s)) { s = s.toLowerCase(); }
    return s;
  };

  /**
   * The key of the scanned workspace that belongs to THIS window, or null.
   * A window is one of: a multi-root workspace (cur.file is its .code-workspace), a single folder
   * (cur.uris has one folder), or something we cannot match (an untitled multi-folder workspace).
   * A multi-root window matches ONLY its workspace file. It never falls back to one of its folders,
   * because Copilot stores that window's chats under the workspace, not under the folders: falling
   * back would show another window's numbers. Kinds must agree. Paths are compared only for local
   * windows and local entries, so a WSL or SSH folder is never mistaken for a local folder with the same path.
   * @param {Object<string, {kind:string, path:string, local:boolean}>} workspaces scan.workspaces
   * @param {{uris?:string[], paths?:string[], file?:string|null, filePath?:string|null}} cur this window
   */
  function currentWorkspaceKey(workspaces, cur) {
    if (!workspaces || !cur || typeof cur !== 'object') { return null; }
    const keys = Object.keys(workspaces).filter((k) => k !== '__empty__');
    const byUri = (uri, kind) => (typeof uri === 'string' ? keys.find((k) => k === uri && workspaces[k].kind === kind) : undefined);
    // A path is only comparable when this window is itself local (a file: URI). A remote window has paths
    // like /home/dev/app that mean something else on this machine, so it can only match by its exact URI.
    const byPath = (uri, p, kind) => {
      const n = normPath(p);
      return n && typeof uri === 'string' && /^file:/i.test(uri) ? keys.find((k) => { const w = workspaces[k]; return w.kind === kind && w.local && normPath(w.path) === n; }) : undefined;
    };
    if (cur.file) { return byUri(cur.file, 'multi-root') || byPath(cur.file, cur.filePath, 'multi-root') || null; }
    const folders = Array.isArray(cur.uris) ? cur.uris : [];
    if (folders.length !== 1) { return null; }
    return byUri(folders[0], 'folder') || byPath(folders[0], Array.isArray(cur.paths) ? cur.paths[0] : '', 'folder') || null;
  }

  /** Does this window have any folder or workspace open at all? (false = an empty window) */
  const hasWorkspace = (cur) => !!cur && typeof cur === 'object' && !!(cur.file || (Array.isArray(cur.uris) && cur.uris.length));

  /* ---------- navigation ---------- */

  const ROUTES = ['dash', 'stories', 'story', 'session', 'prompt', 'connect', 'import', 'effort', 'sync'];
  const ROUTES_WITH_ID = ['story', 'session', 'prompt', 'effort', 'sync'];
  /** Validate a page address from outside (a saved state or a message). Returns a clean copy or null. */
  function normalizeRoute(r) {
    if (!r || typeof r !== 'object' || !ROUTES.includes(r.name)) { return null; }
    const out = { name: r.name };
    if (ROUTES_WITH_ID.includes(r.name)) {
      if (typeof r.id !== 'string' || !r.id || r.id.length > LIMITS.key) { return null; }
      out.id = r.id;
    }
    if (r.name === 'prompt') {
      if (typeof r.key !== 'string' || !r.key || r.key.length > LIMITS.key) { return null; }
      out.key = r.key;
    }
    return out;
  }

  /* ---------- suggestions ---------- */

  const lastNumber = (id) => { const m = /(\d+)(?!.*\d)/.exec(String(id)); return m ? m[1] : null; };

  /**
   * Story numbers mentioned in a session's prompts: "AB#1234" (strong), "#1234" or "US-1234" (weak).
   * Suggestions only; nothing is tagged without a click. Returns at most 3, strongest first.
   * `storyId` is the existing story with that number, if exactly one.
   */
  function suggestForSession(session, store) {
    const found = new Map();
    const add = (num, strong) => { const e = found.get(num) || { number: num, count: 0, strong: false }; e.count++; e.strong = e.strong || strong; found.set(num, e); };
    for (const p of session.prompts) {
      const text = String(p.text || '');
      for (const m of text.matchAll(/\bAB#(\d{1,9})\b/gi)) { add(String(Number(m[1])), true); }
      for (const m of text.matchAll(/(?<![\w&/])#(\d{3,9})\b/g)) { add(String(Number(m[1])), false); }
      for (const m of text.matchAll(/\b(?:US|PBI|story|bug|task)[\s:#-]{0,2}(\d{3,9})\b/gi)) { add(String(Number(m[1])), false); }
    }
    const byNum = new Map();
    for (const id of Object.keys(store.stories)) { const n = lastNumber(id); if (n != null) { const k = String(Number(n)); byNum.set(k, (byNum.get(k) || []).concat(id)); } }
    return [...found.values()]
      .sort((a, b) => (Number(b.strong) - Number(a.strong)) || (b.count - a.count))
      .slice(0, 3)
      .map((e) => { const ids = byNum.get(e.number) || []; return { ...e, storyId: ids.length === 1 ? ids[0] : null }; });
  }

  /* ---------- waste signals (heuristics, always labelled as such in the UI) ---------- */

  const words = (t) => new Set((String(t || '').toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu)) || []);
  function jaccard(a, b) {
    if (!a.size || !b.size) { return 0; }
    let inter = 0; for (const w of a) { if (b.has(w)) { inter++; } }
    return inter / (a.size + b.size - inter);
  }

  /**
   * canceled: prompts the person cancelled.
   * retries: a prompt followed within 10 minutes, in the same session, by a very similar one (word overlap 60% or more).
   * cache:   share of input tokens served from cache, over prompts with real token counts.
   * costliest: the five most expensive prompts.
   */
  function wasteSignals(rows) {
    const real = rows.filter((r) => !r.ov);
    const canceled = real.filter((r) => r.p.canceled);
    const bySession = new Map();
    for (const r of real) { const a = bySession.get(r.s.id) || []; a.push(r); bySession.set(r.s.id, a); }
    const retryRows = [];
    for (const list of bySession.values()) {
      list.sort((a, b) => a.ts - b.ts);
      for (let i = 0; i + 1 < list.length; i++) {
        const a = list[i], b = list[i + 1];
        const gap = b.ts - a.ts;
        if (a.ts && gap >= 0 && gap <= RETRY_GAP_MS && jaccard(words(a.p.text), words(b.p.text)) >= RETRY_SIMILARITY) { retryRows.push(a); }
      }
    }
    const t = totals(rows);
    return {
      canceled: { n: canceled.length, credits: canceled.reduce((s, r) => s + r.p.credits, 0) },
      retries: { n: retryRows.length, credits: retryRows.reduce((s, r) => s + r.p.credits, 0), rows: retryRows },
      cache: { share: t.cachedBase > 0 ? t.cachedKnown / t.cachedBase : null, base: t.cachedBase },
      background: { credits: t.bgCredits, share: t.credits > 0 ? t.bgCredits / t.credits : 0 },
      costliest: real.slice().sort((a, b) => b.p.credits - a.p.credits).slice(0, 5),
    };
  }

  return {
    LIMITS, RETRY_GAP_MS, RETRY_SIMILARITY, BUDGET_WARN,
    validId, normalizeStory, adoIdOf, normalizeEffort, normalizeAdoLink, EFFORT_SOURCES, EFFORT_CONFIDENCE, emptyStore, normalizeStore, cloneStore, toPlain, hasOwn, dict,
    promptKey, storyOf, sourceOf, buildRows, totals, groupByStory, breakdown, efficiency, modelByType,
    budgetState, rollupByGroup, lastNumber, suggestForSession, wasteSignals, normalizeRoute, ROUTES,
    currentWorkspaceKey, hasWorkspace,
    PHASES, PHASE_KEYS, phaseLabel, validPhase, autoPhase, phaseOf, phaseSource, byPhase,
  };
});
