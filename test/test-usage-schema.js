'use strict';
/**
 * The published JSON Schema (docs/ai-delivery-insights/schema/story-usage.schema.json) against what lib/usage.js really produces,
 * including reports built from random data, and against changes that must be rejected. Run: node test/test-usage-schema.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Ajv = require('ajv');
const Core = require('../media/story-core.js');
const U = require('../lib/usage.js');

let failed = 0;
function check(name, fn) {
  try { const r = fn(); console.log('PASS ' + name + (r === undefined ? '' : ' -> ' + r)); } catch (e) { failed++; console.log('FAIL ' + name + ' -> ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : e)); }
}

// the schema lives in docs/ of this folder, or two levels further up when the extension sits under extensions/ in a larger repository
const schemaFile = [path.join(__dirname, '..', 'docs'), path.join(__dirname, '..', '..', '..', 'docs')]
  .map((d) => path.join(d, 'ai-delivery-insights', 'schema', 'story-usage.schema.json')).find((f) => fs.existsSync(f));
const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(schema);
const valid = (doc) => { const ok = validate(doc); assert.ok(ok, JSON.stringify(validate.errors && validate.errors.slice(0, 3))); };
const invalid = (doc, why) => assert.ok(!validate(doc), 'should be rejected: ' + why);
const NOW = Date.UTC(2026, 9, 14, 6, 30);
const clone = (o) => JSON.parse(JSON.stringify(o));

// small seeded random numbers so a failure can be reproduced
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function storyReport(data, tagEvery) {
  const store = Core.emptyStore();
  store.stories.S1 = { id: 'S1', title: 'Story', points: 5, budget: null, group: '', adoId: 1234, created: 0, updated: 0 };
  data.sessions.forEach((s, i) => { if (i % tagEvery === 0) { store.sessionTags[s.id] = 'S1'; } });
  const { rows } = Core.buildRows(data);
  const g = Core.groupByStory(rows, store);
  const sessions = U.sessionsFromRows(g.byStory.get('S1'), store);
  return { m: U.mergeReport({ remote: null, contributorId: 'me-1', displayName: 'Me', sessions, previouslySynced: [], effort: null, now: NOW, adoId: 1234, points: 5 }), rows: g.byStory.get('S1'), sessions };
}

check('a report built from the scanner\'s own fixture data (every session tagged) matches the schema', () => {
  assert.ok(process.env.LENS_DATA, 'LENS_DATA must point at the scanned fixture (run through npm test)');
  const data = JSON.parse(fs.readFileSync(process.env.LENS_DATA, 'utf8'));
  const { m, rows } = storyReport(data, 1);
  valid(m.report);
  assert.ok(m.report.totals.session_count >= 3);
  const raw = rows.reduce((n, r) => n + (r.p.credits || 0), 0);
  assert.ok(Math.abs(m.report.totals.credits - raw) < 0.001, `${m.report.totals.credits} vs ${raw}`);
  assert.strictEqual(m.report.totals.user_initiated_interaction_count, rows.filter((r) => !r.ov).length);
  return `${m.report.totals.session_count} sessions, ${m.report.totals.credits} credits`;
});

check('a report with several contributors and a typed effort matches', () => {
  assert.ok(process.env.LENS_DATA);
  const data = JSON.parse(fs.readFileSync(process.env.LENS_DATA, 'utf8'));
  const { m, sessions } = storyReport(data, 1);
  const first = sessions.slice(0, 2), rest = sessions.slice(2);
  const a = U.mergeReport({ remote: null, contributorId: 'her-2', displayName: 'Her', sessions: first, previouslySynced: [], effort: { hours: 12.5, low: 8, high: 19, source: 'estimated', method: 'size-v1', confidence: 'high', setAt: NOW, note: '', inputs: { commits: 4, prodLines: 100, testLines: 50, files: 6, points: 5 } }, now: NOW, adoId: 1, points: null });
  const b = U.mergeReport({ remote: U.parseDescription(U.renderDescription(a.report).html).report, contributorId: 'me-1', sessions: rest, previouslySynced: [], effort: { hours: 30, source: 'manual', note: 'agreed with the team', setAt: NOW + 1000 }, now: NOW + 1000, adoId: 1, points: null });
  valid(b.report);
  assert.strictEqual(b.report.contributors.length, 2);
  assert.strictEqual(b.report.traditional_effort.source, 'manual');
  assert.ok(m);
});

check('empty reports, and reports read back from hostile input, match', () => {
  valid(U.mergeReport({ contributorId: 'me-1', sessions: [], now: NOW }).report);
  valid(U.mergeReport({ contributorId: 'me-1', sessions: [], now: NOW, effort: { hours: 8, source: 'manual', setAt: NOW } }).report);
  const hostile = { schema: U.SCHEMA, schema_version: 1, extra: 1, contributors: [{ contributor_id: 'c1', display_name: 5, sessions: [{ session_id: 's1', credits: -3, days: [{ day: 'x' }], totals_by_phase: [{ phase: 'nope' }], title: 'SECRET', file: '/a/b' }] }], traditional_effort: { hours: 5, source: 'weird', confidence: 'high' } };
  const n = U.normalizeReport(hostile);
  assert.strictEqual(n.state, 'ok');
  valid(n.report);
  assert.ok(!JSON.stringify(n.report).includes('SECRET'));
});

check('1,000 random stories: every report matches the schema, adds up, and survives being written and read back', () => {
  const rnd = rng(20261014);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const models = ['gpt-5', 'claude-sonnet-4.5', 'gpt-4.1', '', 'o3'], agents = ['Agent', 'Ask', 'Plan', ''], quals = ['exact', 'tokens', 'estimated'], tags = ['Feature', 'Bug fix', 'Tests', 'Docs', 'Explain', 'Other'];
  const phases = Core.PHASE_KEYS;
  for (let it = 0; it < 1000; it++) {
    const nSess = 1 + Math.floor(rnd() * 5);
    const sessions = Array.from({ length: nSess }, (_, i) => ({ id: `s${it}-${i}`, wsKey: 'w', title: 't', created: 0, last: 0 }));
    const rows = []; const store = Core.emptyStore();
    let rawCredits = 0, rawPrompts = 0, rawIn = 0;
    for (const s of sessions) {
      const nRows = Math.floor(rnd() * 8);
      for (let k = 0; k < nRows; k++) {
        const ts = Date.UTC(2026, 8 + Math.floor(rnd() * 3), 1 + Math.floor(rnd() * 28), Math.floor(rnd() * 24), Math.floor(rnd() * 60));
        const p = { i: k, ts, text: 'x', model: pick(models), agent: pick(agents), tag: pick(tags), credits: Math.round(rnd() * 20000) / 1000, inTok: Math.floor(rnd() * 50000), outTok: Math.floor(rnd() * 5000), cached: Math.floor(rnd() * 20000), quality: pick(quals), calls: 1, files: [], edited: [], tools: [], toolCalls: 0 };
        const ov = rnd() < 0.15;
        rows.push({ p, s, ts, ws: 'w', ov }); rawCredits += p.credits; rawIn += p.inTok; if (!ov) { rawPrompts++; }
        if (!ov && rnd() < 0.3) { store.phaseTags[s.id] = store.phaseTags[s.id] || Object.create(null); store.phaseTags[s.id][String(ts)] = pick(phases); }
      }
    }
    const recs = U.sessionsFromRows(rows, store);
    const m = U.mergeReport({ remote: null, contributorId: 'fuzz-1', displayName: '', sessions: recs, previouslySynced: [], effort: rnd() < 0.5 ? null : { hours: 1 + Math.round(rnd() * 400) / 10, source: 'manual', note: '', setAt: NOW } , now: NOW, adoId: 1 + it, points: null });
    valid(m.report);
    const t = m.report.totals;
    assert.ok(Math.abs(t.credits - rawCredits) < 0.002 * Math.max(1, recs.length), `iteration ${it}: ${t.credits} vs ${rawCredits}`);
    assert.strictEqual(t.user_initiated_interaction_count, rawPrompts, `iteration ${it} prompts`);
    assert.ok(Math.abs(t.input_tokens - rawIn) === 0, `iteration ${it} input tokens`);
    for (const part of ['totals_by_model', 'totals_by_feature', 'totals_by_phase', 'days']) {
      const sum = m.report[part].reduce((n, e) => n + e.credits, 0);
      assert.ok(Math.abs(sum - t.credits) < 0.002 * Math.max(1, recs.length) * 2, `iteration ${it} ${part}: ${sum} vs ${t.credits}`);
    }
    if (!m.empty) {
      const r = U.renderDescription(m.report);
      assert.ok(r.ok);
      const back = U.parseDescription(r.html);
      assert.strictEqual(back.state, 'ok', `iteration ${it}`);
      assert.strictEqual(U.contentHash(back.report), m.hashAfter, `iteration ${it} round trip`);
      const again = U.mergeReport({ remote: back.report, contributorId: 'fuzz-1', sessions: recs, previouslySynced: m.syncedIds, effort: null, now: NOW + 5000, adoId: 1 + it, points: null });
      assert.strictEqual(again.changed, false, `iteration ${it}: syncing the same data again must change nothing`);
    }
  }
});

check('changes the schema must reject: extra fields (so nothing private can slip in), wrong types, impossible values', () => {
  const data = JSON.parse(fs.readFileSync(process.env.LENS_DATA, 'utf8'));
  const base = storyReport(data, 1).m.report;
  base.traditional_effort = { hours: 5, low_hours: null, high_hours: null, source: 'manual', method: '', confidence: 'manual', set_at: '', set_by: '', note: '', inputs: {} };
  valid(base);
  const mutate = (why, fn) => { const d = clone(base); fn(d); invalid(d, why); };
  mutate('extra top-level field', (d) => { d.title = 'x'; });
  mutate('extra session field (a title)', (d) => { d.contributors[0].sessions[0].title = 'SECRET'; });
  mutate('extra contributor field (an e-mail)', (d) => { d.contributors[0].email = 'a@b.c'; });
  mutate('prompt text in a model entry', (d) => { d.contributors[0].sessions[0].totals_by_model[0].text = 'hello'; });
  mutate('wrong schema name', (d) => { d.schema = 'other'; });
  mutate('version 2', (d) => { d.schema_version = 2; });
  mutate('negative credits', (d) => { d.totals.credits = -1; });
  mutate('fractional tokens', (d) => { d.totals.input_tokens = 1.5; });
  mutate('bad day', (d) => { d.days[0].day = '2026-1-1'; });
  mutate('bad timestamp', (d) => { d.generated_at = 'yesterday'; });
  mutate('unknown phase', (d) => { d.totals_by_phase[0].phase = 'party'; });
  mutate('bad feature name', (d) => { d.totals_by_feature[0].feature = 'Has Space'; });
  mutate('session id with a slash', (d) => { d.contributors[0].sessions[0].session_id = '../x'; });
  mutate('missing session field', (d) => { delete d.contributors[0].sessions[0].credit_basis; });
  mutate('missing totals', (d) => { delete d.totals; });
  mutate('effort source', (d) => { d.traditional_effort.source = 'guess'; });
  mutate('effort with zero hours', (d) => { d.traditional_effort.hours = 0; });
  mutate('effort note too long', (d) => { d.traditional_effort.note = 'x'.repeat(201); });
  mutate('unknown effort input', (d) => { d.traditional_effort.inputs.author = 'me'; });
  mutate('story id as text', (d) => { d.story.ado_id = '1234'; });
  mutate('an array where an object belongs', (d) => { d.totals = []; });
});

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nUsage schema checks passed.');
process.exit(failed ? 1 : 0);
