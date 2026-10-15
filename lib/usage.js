'use strict';
/**
 * The usage report that Sync writes into Azure DevOps, and the rules for merging it with what is already there.
 *
 * Pure functions: no network, no files, no VS Code. The report is shaped like GitHub's Copilot usage metrics
 * (a "day" per entry, "totals_by_model", "totals_by_feature", user_initiated_interaction_count) with a per-session record
 * and the story's traditional effort added. It is NOT a GitHub format and is not accepted by GitHub's tools; the field
 * names are borrowed so the data reads the same way.
 *
 * What goes in: counts, credits, token numbers, model and agent names, lifecycle phases, UTC days, session IDs and the
 * effort figures. What never goes in: prompt text, responses, session titles, file names, paths, repository names,
 * workspace names, user names (a display name only if the person signed in with Microsoft) or e-mail addresses.
 *
 * Sync rules (each one is covered by a test):
 *   - A session is identified by its session_id. Syncing again REPLACES that session's record; it never adds to it.
 *   - Totals are always recomputed from the session records, never added to a stored total.
 *   - Other people's sessions are kept as they are. This machine removes only sessions it synced earlier that are no
 *     longer tagged to the story.
 *   - Everything read back from Azure DevOps is untrusted: it is validated field by field into fresh objects.
 *   - If nothing changed, nothing is written (content hash, ignoring the timestamps that change on every run).
 */

const crypto = require('crypto');
const Core = require('../media/story-core.js');
const { cleanText, escapeText, stripTags } = require('./text.js');

const SCHEMA = 'copilot-lens/story-usage';
const SCHEMA_VERSION = 1;
const LIMITS = { sessions: 2000, contributors: 50, entries: 40, days: 400, json: 900000, parse: 1200000, number: 1e12 };
const BASIS = ['billed', 'token_priced', 'estimated'];
const PHASE_ORDER = [...Core.PHASE_KEYS, 'background'];

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const r4 = (n) => Math.round(n * 10000) / 10000;
const nonNeg = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= LIMITS.number ? v : 0);
const credits = (v) => r4(nonNeg(v));
const count = (v) => Math.round(nonNeg(v));
const dayText = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) { return ''; }
  const t = Date.parse(v + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? v : ''; // 2026-02-30 would parse, but to March 2
};
const isoText = (v) => { if (typeof v !== 'string' || v.length > 40) { return ''; } const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : ''; };
const idText = (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,99}$/.test(v) && v !== '__proto__' ? v : '');
const labelText = (v, max) => (typeof v === 'string' ? cleanText(v, max || 100) : '');
const dayOf = (ts) => (Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString().slice(0, 10) : '');
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/* ------------------------------------------------------------------ */
/* Session records                                                     */
/* ------------------------------------------------------------------ */

const zero = () => ({ n: 0, c: 0, i: 0, o: 0, k: 0 });
function add(acc, r) {
  const p = r.p;
  if (!r.ov) { acc.n++; acc.k += p.cached || 0; }
  acc.c += p.credits || 0; acc.i += p.inTok || 0; acc.o += p.outTok || 0;
}
const entry = (name, key, a) => ({ [name]: key, user_initiated_interaction_count: count(a.n), credits: credits(a.c), input_tokens: count(a.i), output_tokens: count(a.o) });

/** Canonical form of one session record from anything (our own rows, or untrusted JSON from Azure DevOps). Null if it has no ID. */
function canonSession(raw) {
  if (!raw || typeof raw !== 'object') { return null; }
  const id = idText(raw.session_id);
  if (!id) { return null; }
  const list = (arr, dim, valid) => {
    const out = [];
    for (const e of Array.isArray(arr) ? arr.slice(0, LIMITS.entries) : []) {
      if (!e || typeof e !== 'object') { continue; }
      const key = valid(e[dim]);
      if (key) { out.push(entry(dim, key, { n: nonNeg(e.user_initiated_interaction_count), c: nonNeg(e.credits), i: nonNeg(e.input_tokens), o: nonNeg(e.output_tokens) })); }
    }
    return out;
  };
  const byCredits = (a, b) => b.credits - a.credits || (a[Object.keys(a)[0]] < b[Object.keys(b)[0]] ? -1 : 1);
  const days = [];
  for (const d of Array.isArray(raw.days) ? raw.days.slice(0, LIMITS.days) : []) {
    const day = d && typeof d === 'object' ? dayText(d.day) : '';
    if (day) { days.push(entry('day', day, { n: nonNeg(d.user_initiated_interaction_count), c: nonNeg(d.credits), i: nonNeg(d.input_tokens), o: nonNeg(d.output_tokens) })); }
  }
  days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const basis = raw.credit_basis && typeof raw.credit_basis === 'object' ? raw.credit_basis : {};
  return {
    session_id: id,
    first_day: dayText(raw.first_day), last_day: dayText(raw.last_day),
    user_initiated_interaction_count: count(raw.user_initiated_interaction_count),
    credits: credits(raw.credits), input_tokens: count(raw.input_tokens), output_tokens: count(raw.output_tokens), cached_input_tokens: count(raw.cached_input_tokens),
    background_credits: credits(raw.background_credits),
    credit_basis: { billed: credits(basis.billed), token_priced: credits(basis.token_priced), estimated: credits(basis.estimated) },
    totals_by_model: list(raw.totals_by_model, 'model', (v) => (typeof v === 'string' ? labelText(v, 100) : '')).sort(byCredits),
    totals_by_feature: list(raw.totals_by_feature, 'feature', (v) => (typeof v === 'string' ? slug(v) : '')).sort(byCredits),
    totals_by_phase: list(raw.totals_by_phase, 'phase', (v) => (PHASE_ORDER.includes(v) ? v : '')).sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase)),
    days,
  };
}

const modelOf = (r) => (r.ov ? 'background' : labelText(r.p.model, 100) || 'unknown');
const featureOf = (r) => (r.ov ? 'background' : slug(r.p.agent) || 'unknown');

/**
 * The records for one story's rows: one per session, counting only the rows that belong to the story.
 * @param rows  rows from StoryCore.buildRows, already split by story (StoryCore.groupByStory)
 * @param store the story store (for hand-set lifecycle phases)
 * @returns {object[]} canonical session records, oldest first
 */
function sessionsFromRows(rows, store) {
  const bySession = new Map();
  for (const r of rows) {
    let g = bySession.get(r.s.id);
    if (!g) { g = { id: r.s.id, all: zero(), basis: { billed: 0, token_priced: 0, estimated: 0 }, bg: 0, model: new Map(), feature: new Map(), phase: new Map(), day: new Map(), first: '', last: '' }; bySession.set(r.s.id, g); }
    const bump = (m, k) => { if (!m.has(k)) { m.set(k, zero()); } add(m.get(k), r); };
    add(g.all, r);
    bump(g.model, modelOf(r)); bump(g.feature, featureOf(r));
    bump(g.phase, r.ov ? 'background' : Core.phaseOf(store, r) || 'other');
    const day = dayOf(r.ts);
    if (day) { bump(g.day, day); if (!g.first || day < g.first) { g.first = day; } if (!g.last || day > g.last) { g.last = day; } }
    const q = r.ov ? 'billed' : r.p.quality === 'exact' ? 'billed' : r.p.quality === 'tokens' ? 'token_priced' : 'estimated';
    g.basis[q] += r.p.credits || 0;
    if (r.ov) { g.bg += r.p.credits || 0; }
  }
  const out = [];
  for (const g of bySession.values()) {
    const m = (map, dim) => [...map.entries()].map(([k, a]) => entry(dim, k, a));
    out.push(canonSession({
      session_id: g.id, first_day: g.first, last_day: g.last,
      user_initiated_interaction_count: g.all.n, credits: g.all.c, input_tokens: g.all.i, output_tokens: g.all.o, cached_input_tokens: g.all.k,
      background_credits: g.bg, credit_basis: g.basis,
      totals_by_model: m(g.model, 'model'), totals_by_feature: m(g.feature, 'feature'), totals_by_phase: m(g.phase, 'phase'), days: m(g.day, 'day'),
    }));
  }
  return out.filter(Boolean).sort((a, b) => (a.first_day < b.first_day ? -1 : a.first_day > b.first_day ? 1 : a.session_id < b.session_id ? -1 : 1));
}

/* ------------------------------------------------------------------ */
/* Traditional effort                                                  */
/* ------------------------------------------------------------------ */

const EFFORT_INPUT_MAP = [['commits', 'commits'], ['prodLines', 'prod_lines'], ['testLines', 'test_lines'], ['files', 'files'], ['points', 'story_points']];

/** The report's form of a story's effort record (the store's form is in story-core.js). Null for nothing. */
function effortToReport(e, contributorId) {
  if (!e || typeof e !== 'object' || !Number.isFinite(e.hours) || e.hours <= 0) { return null; }
  const inputs = {};
  for (const [from, to] of EFFORT_INPUT_MAP) { if (e.inputs && Number.isFinite(e.inputs[from])) { inputs[to] = Math.round(e.inputs[from] * 10) / 10; } }
  return {
    hours: Math.round(e.hours * 10) / 10,
    low_hours: Number.isFinite(e.low) ? Math.round(e.low * 10) / 10 : null,
    high_hours: Number.isFinite(e.high) ? Math.round(e.high * 10) / 10 : null,
    source: e.source === 'manual' ? 'manual' : 'estimated',
    method: e.source === 'estimated' && e.method === 'size-v1' ? 'size-v1' : '',
    confidence: e.source === 'manual' ? 'manual' : (['high', 'medium', 'low'].includes(e.confidence) ? e.confidence : 'low'),
    set_at: Number.isFinite(e.setAt) && e.setAt > 0 ? new Date(e.setAt).toISOString() : '',
    set_by: idText(contributorId),
    note: cleanText(e.note, 200),
    inputs,
  };
}

/** Untrusted effort from a report, rebuilt field by field. */
function canonEffort(raw) {
  if (!raw || typeof raw !== 'object') { return null; }
  const h = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100000 ? Math.round(v * 10) / 10 : null);
  const hours = h(raw.hours);
  if (hours == null) { return null; }
  let low = h(raw.low_hours), high = h(raw.high_hours);
  if (low == null || high == null || low > hours || high < hours) { low = null; high = null; }
  const manual = raw.source === 'manual';
  const inputs = {};
  if (!manual && raw.inputs && typeof raw.inputs === 'object') {
    for (const [, to] of EFFORT_INPUT_MAP) { const v = raw.inputs[to]; if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e9) { inputs[to] = Math.round(v * 10) / 10; } }
  }
  return {
    hours, low_hours: low, high_hours: high, source: manual ? 'manual' : 'estimated',
    method: !manual && raw.method === 'size-v1' ? 'size-v1' : '',
    confidence: manual ? 'manual' : (['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low'),
    set_at: isoText(raw.set_at), set_by: idText(raw.set_by), note: cleanText(raw.note, 200), inputs,
  };
}

/** Which effort wins: a number somebody typed beats an estimate; between equals the newer one wins; on a tie the local one. */
function pickEffort(remote, local) {
  if (!remote) { return local || null; }
  if (!local) { return remote; }
  const rank = (e) => (e.source === 'manual' ? 1 : 0);
  if (rank(local) !== rank(remote)) { return rank(local) > rank(remote) ? local : remote; }
  return Date.parse(remote.set_at || 0) > Date.parse(local.set_at || 0) ? remote : local;
}

/* ------------------------------------------------------------------ */
/* Reports                                                             */
/* ------------------------------------------------------------------ */

function aggregate(sessions) {
  const t = { n: 0, c: 0, i: 0, o: 0, k: 0, bg: 0, basis: { billed: 0, token_priced: 0, estimated: 0 }, first: '', last: '' };
  const maps = { model: new Map(), feature: new Map(), phase: new Map(), day: new Map() };
  const fold = (m, key, e) => { const a = m.get(key) || zero(); a.n += e.user_initiated_interaction_count; a.c += e.credits; a.i += e.input_tokens; a.o += e.output_tokens; m.set(key, a); };
  for (const s of sessions) {
    t.n += s.user_initiated_interaction_count; t.c += s.credits; t.i += s.input_tokens; t.o += s.output_tokens; t.k += s.cached_input_tokens; t.bg += s.background_credits;
    for (const b of BASIS) { t.basis[b] += s.credit_basis[b]; }
    if (s.first_day && (!t.first || s.first_day < t.first)) { t.first = s.first_day; }
    if (s.last_day && s.last_day > t.last) { t.last = s.last_day; }
    for (const e of s.totals_by_model) { fold(maps.model, e.model, e); }
    for (const e of s.totals_by_feature) { fold(maps.feature, e.feature, e); }
    for (const e of s.totals_by_phase) { fold(maps.phase, e.phase, e); }
    for (const e of s.days) { fold(maps.day, e.day, e); }
  }
  const list = (m, dim) => [...m.entries()].map(([k, a]) => entry(dim, k, a));
  const byCredits = (dim) => (a, b) => b.credits - a.credits || (a[dim] < b[dim] ? -1 : 1);
  return {
    totals: {
      session_count: sessions.length, user_initiated_interaction_count: count(t.n), credits: credits(t.c), cost_usd: r4(credits(t.c) / 100),
      input_tokens: count(t.i), output_tokens: count(t.o), cached_input_tokens: count(t.k), background_credits: credits(t.bg),
      first_day: t.first, last_day: t.last,
    },
    credit_basis: { billed: credits(t.basis.billed), token_priced: credits(t.basis.token_priced), estimated: credits(t.basis.estimated) },
    totals_by_model: list(maps.model, 'model').sort(byCredits('model')),
    totals_by_feature: list(maps.feature, 'feature').sort(byCredits('feature')),
    totals_by_phase: list(maps.phase, 'phase').sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase)),
    days: list(maps.day, 'day').sort((a, b) => (a.day < b.day ? -1 : 1)),
  };
}

/** Assemble a report from contributor groups ([{contributor_id, display_name, last_synced_at, sessions}]). */
function buildReport(args) {
  const a = args || {};
  const contributors = (a.contributors || []).filter((c) => c.sessions.length)
    .sort((x, y) => (x.contributor_id < y.contributor_id ? -1 : 1))
    .map((c) => ({ contributor_id: c.contributor_id, display_name: c.display_name || '', last_synced_at: c.last_synced_at || '', sessions: c.sessions }));
  const all = contributors.flatMap((c) => c.sessions);
  const agg = aggregate(all);
  return {
    schema: SCHEMA, schema_version: SCHEMA_VERSION,
    generated_at: new Date(a.now || Date.now()).toISOString(),
    story: { ado_id: Number.isInteger(a.adoId) ? a.adoId : null, story_points: Number.isFinite(a.points) ? a.points : null },
    totals: agg.totals, credit_basis: agg.credit_basis,
    totals_by_model: agg.totals_by_model, totals_by_feature: agg.totals_by_feature, totals_by_phase: agg.totals_by_phase, days: agg.days,
    traditional_effort: a.effort || null,
    contributors,
  };
}

/* ------------------------------------------------------------------ */
/* Reading a report back (untrusted)                                   */
/* ------------------------------------------------------------------ */

/**
 * Rebuild a report from parsed JSON, keeping only valid fields.
 * @returns {{state:'ok', report:object} | {state:'refuse', reason:string} | {state:'unreadable', reason:string}}
 */
function normalizeReport(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema !== SCHEMA) { return { state: 'unreadable', reason: 'It is not an AI Delivery Insights usage report.' }; }
  if (!Number.isInteger(raw.schema_version) || raw.schema_version < 1) { return { state: 'unreadable', reason: 'It has no valid version.' }; }
  if (raw.schema_version > SCHEMA_VERSION) { return { state: 'refuse', reason: 'This report was written by a newer version of AI Delivery Insights. Update the extension before syncing, so nothing is lost.' }; }
  const src = Array.isArray(raw.contributors) ? raw.contributors : [];
  if (src.length > LIMITS.contributors) { return { state: 'refuse', reason: `This report has more than ${LIMITS.contributors} contributors, more than AI Delivery Insights will merge.` }; }
  const seen = new Set();
  const contributors = [];
  let total = 0;
  for (const c of src) {
    if (!c || typeof c !== 'object') { continue; }
    const cid = idText(c.contributor_id);
    if (!cid || !Array.isArray(c.sessions)) { continue; }
    const sessions = [];
    for (const s of c.sessions) {
      const cs = canonSession(s);
      if (!cs || seen.has(cs.session_id)) { continue; }
      seen.add(cs.session_id); sessions.push(cs); total++;
      if (total > LIMITS.sessions) { return { state: 'refuse', reason: `This report has more than ${LIMITS.sessions} sessions, more than AI Delivery Insights will merge.` }; }
    }
    contributors.push({ contributor_id: cid, display_name: labelText(c.display_name, 100), last_synced_at: isoText(c.last_synced_at), sessions });
  }
  const report = buildReport({
    contributors, effort: canonEffort(raw.traditional_effort), now: Date.parse(raw.generated_at) || 0,
    adoId: raw.story && Number.isInteger(raw.story.ado_id) ? raw.story.ado_id : null,
    points: raw.story && typeof raw.story.story_points === 'number' ? raw.story.story_points : null,
  });
  return { state: 'ok', report };
}

/**
 * Find the report in a work item's description (the first <pre> block that holds one).
 * @returns {{state:'none'|'ok'|'unreadable'|'refuse', report?:object, reason?:string}}
 */
function parseDescription(html) {
  const text = typeof html === 'string' ? html : '';
  if (!text.trim()) { return { state: 'none' }; }
  if (text.length > LIMITS.parse) { return { state: 'refuse', reason: 'The task description is larger than AI Delivery Insights will read.' }; }
  let last = { state: 'unreadable', reason: 'The task description does not contain an AI Delivery Insights report.' };
  // <pre> blocks found with indexOf, so a description made of nothing but "<pre>" cannot make this slow (a regular expression
  // with a lazy match would search to the end of the text from every opening tag).
  const lower = text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  let from = 0;
  for (;;) {
    let open = lower.indexOf('<pre', from);
    while (open !== -1 && /[a-z0-9_]/.test(lower[open + 4] || '')) { open = lower.indexOf('<pre', open + 4); }   // <pre, not <prefix>
    if (open === -1) { break; }
    const tagEnd = lower.indexOf('>', open + 4);
    if (tagEnd === -1) { break; }
    const close = lower.indexOf('</pre>', tagEnd + 1);
    if (close === -1) { break; }                       // no closing tag anywhere after this: none of the later ones has one either
    from = close + 6;
    const body = stripTags(text.slice(tagEnd + 1, close)).trim();
    if (body[0] !== '{') { continue; }
    let json;
    try { json = JSON.parse(body); } catch { last = { state: 'unreadable', reason: 'The report in the task description is not valid JSON (it may have been edited).' }; continue; }
    if (!json || json.schema !== SCHEMA) { continue; }
    return normalizeReport(json);
  }
  return last;
}

/* ------------------------------------------------------------------ */
/* Merge                                                               */
/* ------------------------------------------------------------------ */

/** Hash of what the report says, ignoring the timestamps that change on every run. */
function contentHash(report) {
  const copy = JSON.parse(JSON.stringify(report));
  delete copy.generated_at;
  for (const c of copy.contributors || []) { delete c.last_synced_at; }
  return sha256(JSON.stringify(copy));
}

/**
 * Combine this machine's sessions with the report already in Azure DevOps.
 * @param {object} a
 * @param {object|null} a.remote            a normalised report (from parseDescription) or null
 * @param {string} a.contributorId          who this machine is (Azure DevOps identity or a random install ID)
 * @param {string} [a.displayName]
 * @param {object[]} a.sessions             canonical session records from sessionsFromRows
 * @param {string[]} a.previouslySynced     session IDs this machine wrote to this story on earlier syncs
 * @param {object|null} a.effort            the story's effort in the store's form, or null
 * @param {number} a.now
 * @param {number|null} a.adoId
 * @param {number|null} a.points
 * @returns {{report:object, changes:object, effort:string, changed:boolean, empty:boolean, hashBefore:string, hashAfter:string, syncedIds:string[]}}
 */
function mergeReport(a) {
  const cid = idText(a.contributorId);
  if (!cid) { throw new Error('mergeReport needs a contributor ID.'); }
  const remote = a.remote || null;
  const groups = new Map();
  const where = new Map();
  for (const c of remote ? remote.contributors : []) {
    groups.set(c.contributor_id, { contributor_id: c.contributor_id, display_name: c.display_name, last_synced_at: c.last_synced_at, sessions: new Map(c.sessions.map((s) => [s.session_id, s])) });
    for (const s of c.sessions) { where.set(s.session_id, c.contributor_id); }
  }
  const mine = () => {
    if (!groups.has(cid)) { groups.set(cid, { contributor_id: cid, display_name: '', last_synced_at: '', sessions: new Map() }); }
    return groups.get(cid);
  };
  const changes = { added: 0, updated: 0, unchanged: 0, removed: 0, others: 0 };
  const local = new Map();
  for (const s of a.sessions || []) { const c = canonSession(s); if (c) { local.set(c.session_id, c); } }

  for (const id of a.previouslySynced || []) {
    if (!local.has(id) && where.has(id)) { groups.get(where.get(id)).sessions.delete(id); where.delete(id); changes.removed++; }
  }
  let touched = changes.removed > 0;
  for (const [id, s] of local) {
    const owner = where.get(id);
    const old = owner ? groups.get(owner).sessions.get(id) : null;
    if (old && owner === cid && JSON.stringify(old) === JSON.stringify(s)) { changes.unchanged++; continue; }
    if (old) { groups.get(owner).sessions.delete(id); changes.updated++; } else { changes.added++; }
    mine().sessions.set(id, s); where.set(id, cid); touched = true;
  }
  if (groups.has(cid)) {
    const g = groups.get(cid);
    if (g.sessions.size) {
      // The name is exactly what the person has chosen to share now: turning sharing off clears a name written earlier.
      if (typeof a.displayName === 'string') {
        const name = labelText(a.displayName, 100);
        if (name !== g.display_name) { g.display_name = name; touched = true; }
      }
      if (touched || !g.last_synced_at) { g.last_synced_at = new Date(a.now || Date.now()).toISOString(); }
    }
  }
  for (const [id, g] of groups) { if (id !== cid) { changes.others += g.sessions.size; } }

  const localEffort = effortToReport(a.effort, cid);
  const remoteEffort = remote ? remote.traditional_effort : null;
  const effort = pickEffort(remoteEffort, localEffort);
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const effortChange = !effort ? 'none' : !remoteEffort ? 'added' : same(effort, remoteEffort) ? 'unchanged' : 'updated';

  const report = buildReport({
    contributors: [...groups.values()].map((g) => ({ ...g, sessions: [...g.sessions.values()].sort((x, y) => (x.first_day < y.first_day ? -1 : x.first_day > y.first_day ? 1 : x.session_id < y.session_id ? -1 : 1)) })),
    effort, now: a.now, adoId: a.adoId, points: a.points,
  });
  const empty = report.contributors.length === 0 && !report.traditional_effort;
  const sessionCount = report.contributors.reduce((n, c) => n + c.sessions.length, 0);
  // The same limit that makes a report unreadable (see normalizeReport) must stop it being written, or one more person could lock everyone out.
  if (report.contributors.length > LIMITS.contributors) {
    return { report, changes, effort: effortChange, changed: false, empty, hashBefore: remote ? contentHash(remote) : '', hashAfter: '', syncedIds: [], error: `This story's report already has ${LIMITS.contributors} contributors, the most AI Delivery Insights will merge, so yours cannot be added. Ask someone to untag their sessions, or split the story.` };
  }
  if (sessionCount > LIMITS.sessions) {
    return { report, changes, effort: effortChange, changed: false, empty, hashBefore: remote ? contentHash(remote) : '', hashAfter: '', syncedIds: [], error: `This story has more than ${LIMITS.sessions} sessions in its report, more than AI Delivery Insights will write. Untag old sessions or split the story.` };
  }
  const hashBefore = remote ? contentHash(remote) : '';
  const hashAfter = contentHash(report);
  // With no report in Azure DevOps and nothing to say there is nothing to write; if a report exists, it is brought up to date even when it ends up empty.
  const changed = hashBefore !== hashAfter && !(empty && !remote);
  return { report, changes, effort: effortChange, changed, empty, hashBefore, hashAfter, syncedIds: [...local.keys()].sort() };
}

/* ------------------------------------------------------------------ */
/* The task description                                                */
/* ------------------------------------------------------------------ */

/**
 * JSON for people to read: the top level and the contributor list are spread over lines, and each session or list entry is
 * one line, which keeps even hundreds of sessions well inside the size limit of a work item.
 */
function stringify(report) {
  const one = (v) => JSON.stringify(v);
  const lines = ['{'];
  const keys = Object.keys(report);
  keys.forEach((k, ki) => {
    const v = report[k];
    const comma = ki < keys.length - 1 ? ',' : '';
    if (k === 'contributors') {
      if (!v.length) { lines.push(` ${one(k)}: []${comma}`); return; }
      lines.push(` ${one(k)}: [`);
      v.forEach((c, ci) => {
        const head = { contributor_id: c.contributor_id, display_name: c.display_name, last_synced_at: c.last_synced_at };
        lines.push('  {');
        lines.push(`   ${one('contributor_id')}: ${one(head.contributor_id)}, ${one('display_name')}: ${one(head.display_name)}, ${one('last_synced_at')}: ${one(head.last_synced_at)},`);
        lines.push(`   ${one('sessions')}: [`);
        c.sessions.forEach((s, si) => lines.push(`    ${one(s)}${si < c.sessions.length - 1 ? ',' : ''}`));
        lines.push('   ]');
        lines.push(`  }${ci < v.length - 1 ? ',' : ''}`);
      });
      lines.push(` ]${comma}`);
    } else if (Array.isArray(v)) {
      if (!v.length) { lines.push(` ${one(k)}: []${comma}`); return; }
      lines.push(` ${one(k)}: [`);
      v.forEach((e, ei) => lines.push(`  ${one(e)}${ei < v.length - 1 ? ',' : ''}`));
      lines.push(` ]${comma}`);
    } else { lines.push(` ${one(k)}: ${one(v)}${comma}`); }
  });
  lines.push('}');
  return lines.join('\n');
}

const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * The HTML written to the task's Description. Everything that is text is escaped; the only numbers in the summary table
 * come from the report we just built, never from the remote task.
 * @returns {{ok:true, html:string} | {ok:false, error:string}}
 */
function renderDescription(report) {
  const t = report.totals;
  const e = report.traditional_effort;
  const rows = [
    ['Sessions', fmt(t.session_count)], ['Prompts', fmt(t.user_initiated_interaction_count)], ['Credits', fmt(Math.round(t.credits * 100) / 100)],
    ['Cost (USD)', '$' + (Math.round(t.cost_usd * 100) / 100).toFixed(2)], ['Input tokens', fmt(t.input_tokens)], ['Output tokens', fmt(t.output_tokens)],
    ['Traditional effort (no AI)', e ? `${e.hours} h${e.low_hours != null ? ` (range ${e.low_hours} to ${e.high_hours} h)` : ''}, ${e.source === 'manual' ? 'entered by hand' : 'estimated, ' + e.confidence + ' confidence'}` : 'not recorded'],
  ];
  const table = rows.map(([k, v]) => `<tr><td>${escapeText(k)}</td><td>${escapeText(v)}</td></tr>`).join('');
  const html = '<div><b>Copilot Lens usage</b> for this story. This task is kept up to date by Copilot Lens: the JSON below is replaced on every sync, so please do not edit it. ' +
    'It holds counts, credits, tokens, model and agent names, lifecycle phases and dates. It does not hold prompt text, session titles, file names or paths.</div>' +
    `<table border="1" cellpadding="4" cellspacing="0">${table}</table><br>` +
    `<pre>${escapeText(stringify(report))}</pre>`;
  if (html.length > LIMITS.json) { return { ok: false, error: `This story has too many sessions to fit in one work item (more than about ${fmt(LIMITS.sessions)}). Untag old sessions or split the story.` }; }
  return { ok: true, html };
}

/** Binds what the person confirmed to what is sent: the exact HTML, and which task (or none) it goes to. */
function planHash(html, task) {
  return sha256(`${task ? task.id + ':' + task.rev : 'new'}\n${html}`);
}

module.exports = {
  SCHEMA, SCHEMA_VERSION, LIMITS, PHASE_ORDER,
  sessionsFromRows, canonSession, effortToReport, canonEffort, pickEffort, aggregate, buildReport, normalizeReport, parseDescription,
  mergeReport, contentHash, stringify, renderDescription, planHash,
};
