'use strict';
/**
 * Tests for lib/usage.js: the report written into Azure DevOps and the rules for merging it with what is already there.
 * Expected numbers are worked out by hand in the comments, not copied from the code. Run: node test/test-usage.js
 */
const assert = require('assert');
const Core = require('../media/story-core.js');
const U = require('../lib/usage.js');

let failed = 0;
function check(name, fn) {
  try { const r = fn(); console.log('PASS ' + name + (r === undefined ? '' : ' -> ' + r)); } catch (e) { failed++; console.log('FAIL ' + name + ' -> ' + (e && e.stack ? e.stack.split("\n").slice(0, 14).join(" | ") : e)); }
}

const T = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h || 0, mi || 0);
const NOW = T(2026, 10, 14, 6, 30);
const NOW2 = T(2026, 10, 15, 8, 0);

function prompt(over) {
  return { i: 0, ts: 0, text: 'x', chars: 1, model: 'gpt-5', agent: 'Agent', tag: 'Feature', credits: 0, inTok: 0, outTok: 0, cached: 0, calls: 1, quality: 'exact', files: [], edited: [], tools: [], toolCalls: 0, canceled: false, ...over };
}
const sess = (id, extra) => ({ id, wsKey: 'file:///home/someone/secret-repo', title: 'SECRET SESSION TITLE', file: '/home/someone/.config/Code/secret.jsonl', created: 0, last: 0, ...(extra || {}) });
const row = (s, p) => ({ p, s, ts: p.ts, ws: s.wsKey, ov: false });
const bg = (s, ts, credits, inTok, outTok) => ({ p: { credits, inTok, outTok, cached: 0, calls: 1, text: 'Background calls (session titles and unmatched calls)', model: '', quality: 'exact', tag: 'Other', files: [], edited: [], tools: [], toolCalls: 0 }, s, ts, ws: s.wsKey, ov: true });

// Session A: three prompts over two UTC days (23:30 on the 6th, then the 7th) and one background call.
//   p1 2026-10-06T23:30Z  gpt-5 Agent  build  billed        10.50 cr  in 1000 out 200 cached 400
//   p2 2026-10-07T00:10Z  claude Plan  plan   token-priced   4.25 cr  in  500 out 100
//   p3 2026-10-07T09:00Z  gpt-5 Ask    test (set by hand)   estimated 1.00 cr  in 200 out 50
//   bg 2026-10-07T09:05Z                                    billed   0.75 cr  in  300 out  20
const A = sess('aaaa-1');
const pA1 = prompt({ i: 0, ts: T(2026, 10, 6, 23, 30), text: 'SECRET PROMPT TEXT one', credits: 10.5, inTok: 1000, outTok: 200, cached: 400, files: ['secret.ts'], edited: ['secret.ts'] });
const pA2 = prompt({ i: 1, ts: T(2026, 10, 7, 0, 10), text: 'SECRET PROMPT TEXT two', model: 'claude-sonnet-4.5', agent: 'Plan', tag: 'Other', credits: 4.25, inTok: 500, outTok: 100, quality: 'tokens' });
const pA3 = prompt({ i: 2, ts: T(2026, 10, 7, 9, 0), text: 'SECRET PROMPT TEXT three', agent: 'Ask', credits: 1.0, inTok: 200, outTok: 50, quality: 'estimated' });
const rowsA = () => [row(A, pA1), row(A, pA2), row(A, pA3), bg(A, T(2026, 10, 7, 9, 5), 0.75, 300, 20)];
// Session B: one prompt, no model or agent recorded, a docs prompt, on the 8th.
const B = sess('bbbb-2');
const pB1 = prompt({ i: 0, ts: T(2026, 10, 8, 12, 0), text: 'SECRET write the readme', model: '', agent: '', tag: 'Docs', credits: 2.0, inTok: 100, outTok: 10 });
const rowsB = () => [row(B, pB1)];

const store = () => { const s = Core.emptyStore(); s.phaseTags['aaaa-1'] = Object.create(null); s.phaseTags['aaaa-1'][String(pA3.ts)] = 'test'; return s; };
const recordsFor = (rows) => U.sessionsFromRows(rows, store());
const merge = (extra) => U.mergeReport({ remote: null, contributorId: 'me-1', displayName: 'Me', sessions: [], previouslySynced: [], effort: null, now: NOW, adoId: 1234, points: 5, ...extra });
const roundTrip = (report) => { const r = U.renderDescription(report); assert.ok(r.ok, r.error); const p = U.parseDescription(r.html); assert.strictEqual(p.state, 'ok', p.reason); return p.report; };
const firstOf = (list) => list[0];

check('one session, worked out by hand: counts, credits, tokens, partitions and UTC days', () => {
  const [a] = recordsFor(rowsA());
  assert.strictEqual(a.session_id, 'aaaa-1');
  assert.strictEqual(a.user_initiated_interaction_count, 3, 'the background call is not a prompt');
  assert.strictEqual(a.credits, 16.5);            // 10.5 + 4.25 + 1.0 + 0.75
  assert.strictEqual(a.input_tokens, 2000);       // 1000 + 500 + 200 + 300
  assert.strictEqual(a.output_tokens, 370);       // 200 + 100 + 50 + 20
  assert.strictEqual(a.cached_input_tokens, 400);
  assert.strictEqual(a.background_credits, 0.75);
  assert.deepStrictEqual(a.credit_basis, { billed: 11.25, token_priced: 4.25, estimated: 1 }); // 10.5 + 0.75 | 4.25 | 1.0
  assert.strictEqual(a.first_day, '2026-10-06');  // 23:30 UTC is still the 6th
  assert.strictEqual(a.last_day, '2026-10-07');
  assert.deepStrictEqual(a.totals_by_model, [
    { model: 'gpt-5', user_initiated_interaction_count: 2, credits: 11.5, input_tokens: 1200, output_tokens: 250 },
    { model: 'claude-sonnet-4.5', user_initiated_interaction_count: 1, credits: 4.25, input_tokens: 500, output_tokens: 100 },
    { model: 'background', user_initiated_interaction_count: 0, credits: 0.75, input_tokens: 300, output_tokens: 20 },
  ]);
  assert.deepStrictEqual(a.totals_by_feature.map((e) => [e.feature, e.credits]), [['agent', 10.5], ['plan', 4.25], ['ask', 1], ['background', 0.75]]);
  assert.deepStrictEqual(a.totals_by_phase.map((e) => [e.phase, e.credits, e.user_initiated_interaction_count]), [['plan', 4.25, 1], ['build', 10.5, 1], ['test', 1, 1], ['background', 0.75, 0]], 'lifecycle order; "test" was set by hand');
  assert.deepStrictEqual(a.days, [
    { day: '2026-10-06', user_initiated_interaction_count: 1, credits: 10.5, input_tokens: 1000, output_tokens: 200 },
    { day: '2026-10-07', user_initiated_interaction_count: 2, credits: 6, input_tokens: 1000, output_tokens: 170 }, // 4.25 + 1.0 + 0.75
  ]);
  for (const part of ['totals_by_model', 'totals_by_feature', 'totals_by_phase', 'days']) {
    const sum = Math.round(a[part].reduce((n, e) => n + e.credits, 0) * 10000) / 10000;
    assert.strictEqual(sum, a.credits, part + ' adds up to the session');
  }
  assert.strictEqual(Math.round((a.credit_basis.billed + a.credit_basis.token_priced + a.credit_basis.estimated) * 10000) / 10000, a.credits);
});

check('a model or agent that was not recorded is called "unknown", and the phase guess is used when none was set', () => {
  const [b] = recordsFor(rowsB());
  assert.deepStrictEqual(b.totals_by_model.map((e) => e.model), ['unknown']);
  assert.deepStrictEqual(b.totals_by_feature.map((e) => e.feature), ['unknown']);
  assert.deepStrictEqual(b.totals_by_phase.map((e) => e.phase), ['docs']);
});

check('totals of two sessions, by hand', () => {
  const m = merge({ sessions: [...recordsFor(rowsA()), ...recordsFor(rowsB())] });
  const t = m.report.totals;
  assert.deepStrictEqual(t, {
    session_count: 2, user_initiated_interaction_count: 4, credits: 18.5, cost_usd: 0.185, input_tokens: 2100, output_tokens: 380, cached_input_tokens: 400,
    background_credits: 0.75, first_day: '2026-10-06', last_day: '2026-10-08',
  });
  assert.deepStrictEqual(m.report.totals_by_model.map((e) => [e.model, e.credits]), [['gpt-5', 11.5], ['claude-sonnet-4.5', 4.25], ['unknown', 2], ['background', 0.75]]);
  assert.deepStrictEqual(m.report.totals_by_phase.map((e) => [e.phase, e.credits]), [['plan', 4.25], ['build', 10.5], ['test', 1], ['docs', 2], ['background', 0.75]]);
  assert.deepStrictEqual(m.report.days.map((d) => [d.day, d.credits]), [['2026-10-06', 10.5], ['2026-10-07', 6], ['2026-10-08', 2]]);
  assert.deepStrictEqual(m.report.credit_basis, { billed: 13.25, token_priced: 4.25, estimated: 1 });
  assert.deepStrictEqual(m.changes, { added: 2, updated: 0, unchanged: 0, removed: 0, others: 0 });
  assert.ok(m.changed && !m.empty);
  assert.deepStrictEqual(m.syncedIds, ['aaaa-1', 'bbbb-2']);
});

check('privacy: no prompt text, session title, path, repository or file name appears in the report or the description', () => {
  const m = merge({ sessions: [...recordsFor(rowsA()), ...recordsFor(rowsB())], effort: { hours: 10, source: 'manual', note: 'my note', setAt: NOW } });
  const r = U.renderDescription(m.report);
  const everything = JSON.stringify(m.report) + r.html;
  for (const secret of ['SECRET', 'someone', 'secret.ts', 'secret.jsonl', 'secret-repo', '.config', 'file://']) { assert.ok(!everything.includes(secret), secret); }
  assert.ok(everything.includes('my note'), 'the one free-text field is the note the person typed with their own effort');
});

check('syncing again with nothing new: every session unchanged, nothing to write, timestamps untouched', () => {
  const first = merge({ sessions: [...recordsFor(rowsA()), ...recordsFor(rowsB())] });
  const remote = roundTrip(first.report);
  const again = merge({ remote, sessions: [...recordsFor(rowsA()), ...recordsFor(rowsB())], previouslySynced: first.syncedIds, now: NOW2 });
  assert.deepStrictEqual(again.changes, { added: 0, updated: 0, unchanged: 2, removed: 0, others: 0 });
  assert.strictEqual(again.changed, false);
  assert.strictEqual(again.hashAfter, again.hashBefore);
  assert.strictEqual(firstOf(again.report.contributors).last_synced_at, new Date(NOW).toISOString(), 'a no-op sync does not touch the time');
  assert.strictEqual(again.report.totals.credits, 18.5);
});

check('a session that grew is replaced, not added to: totals follow the session, never accumulate', () => {
  const first = merge({ sessions: [...recordsFor(rowsA()), ...recordsFor(rowsB())] });
  const remote = roundTrip(first.report);
  const grown = [...rowsA(), row(A, prompt({ i: 3, ts: T(2026, 10, 9, 10, 0), text: 'more', credits: 3, inTok: 100, outTok: 10 }))];
  const second = merge({ remote, sessions: [...recordsFor(grown), ...recordsFor(rowsB())], previouslySynced: first.syncedIds, now: NOW2 });
  assert.deepStrictEqual(second.changes, { added: 0, updated: 1, unchanged: 1, removed: 0, others: 0 });
  assert.ok(second.changed);
  assert.strictEqual(second.report.totals.credits, 21.5);                       // 16.5 + 3.0 for A, plus B 2.0 (not 18.5 + 19.5 + 2.0)
  assert.strictEqual(second.report.totals.session_count, 2);
  assert.strictEqual(second.report.totals.user_initiated_interaction_count, 5);
  assert.strictEqual(firstOf(second.report.contributors).last_synced_at, new Date(NOW2).toISOString());
  const ids = second.report.contributors.flatMap((c) => c.sessions.map((s) => s.session_id));
  assert.deepStrictEqual(ids.sort(), ['aaaa-1', 'bbbb-2'], 'each session once');
  // and a third sync with the same data is a no-op again
  const third = merge({ remote: roundTrip(second.report), sessions: [...recordsFor(grown), ...recordsFor(rowsB())], previouslySynced: second.syncedIds, now: NOW2 + 1000 });
  assert.strictEqual(third.changed, false);
});

check('untagging: a session this machine synced earlier is removed; one it never synced is left alone', () => {
  const first = merge({ sessions: [...recordsFor(rowsA()), ...recordsFor(rowsB())] });
  const remote = roundTrip(first.report);
  const afterUntag = merge({ remote, sessions: recordsFor(rowsA()), previouslySynced: first.syncedIds, now: NOW2 });
  assert.deepStrictEqual(afterUntag.changes, { added: 0, updated: 0, unchanged: 1, removed: 1, others: 0 });
  assert.strictEqual(afterUntag.report.totals.credits, 16.5);
  assert.ok(afterUntag.changed);
  // if this machine has no record of having synced B, B stays (it may be somebody else's, or from an earlier install)
  const unknownHistory = merge({ remote, sessions: recordsFor(rowsA()), previouslySynced: ['aaaa-1'], now: NOW2 });
  assert.strictEqual(unknownHistory.report.totals.credits, 18.5);
  assert.strictEqual(unknownHistory.changes.removed, 0);
});

check('other people\'s sessions are kept and counted; removing mine never touches them', () => {
  const mine = merge({ sessions: recordsFor(rowsA()) });
  const theirs = merge({ remote: roundTrip(mine.report), contributorId: 'her-2', displayName: 'Her', sessions: recordsFor(rowsB()), now: NOW2 });
  assert.deepStrictEqual(theirs.changes, { added: 1, updated: 0, unchanged: 0, removed: 0, others: 1 });
  assert.strictEqual(theirs.report.totals.credits, 18.5);
  assert.deepStrictEqual(theirs.report.contributors.map((c) => [c.contributor_id, c.display_name, c.sessions.length]), [['her-2', 'Her', 1], ['me-1', 'Me', 1]]);
  // I untag everything: my session goes, hers stays
  const gone = merge({ remote: roundTrip(theirs.report), sessions: [], previouslySynced: ['aaaa-1'], now: NOW2 + 1000 });
  assert.deepStrictEqual(gone.report.contributors.map((c) => c.contributor_id), ['her-2']);
  assert.strictEqual(gone.report.totals.credits, 2);
  assert.strictEqual(gone.changes.removed, 1);
  assert.ok(gone.changed);
  // her removing hers while I have nothing syncs leaves mine alone
  const herGone = merge({ remote: roundTrip(theirs.report), contributorId: 'her-2', sessions: [], previouslySynced: ['bbbb-2'], now: NOW2 + 2000 });
  assert.deepStrictEqual(herGone.report.contributors.map((c) => c.contributor_id), ['me-1']);
});

check('the same session reported by two contributors ends up once, owned by whoever syncs it now', () => {
  const mine = merge({ sessions: recordsFor(rowsA()) });
  const other = merge({ remote: roundTrip(mine.report), contributorId: 'her-2', sessions: recordsFor(rowsA()), now: NOW2 });
  const all = other.report.contributors.flatMap((c) => c.sessions.map((s) => [c.contributor_id, s.session_id]));
  assert.deepStrictEqual(all, [['her-2', 'aaaa-1']]);
  assert.strictEqual(other.changes.updated, 1);
  assert.strictEqual(other.report.totals.credits, 16.5);
});

check('traditional effort: a typed number beats an estimate, the newer of equals wins, nothing is lost when this machine has none', () => {
  const est = (hours, day) => ({ hours, low: hours * 0.7, high: hours * 1.5, source: 'estimated', method: 'size-v1', confidence: 'medium', setAt: T(2026, 10, day), note: '', inputs: { commits: 5, prodLines: 450, testLines: 300, files: 14, points: 5 } });
  const man = (hours, day) => ({ hours, low: null, high: null, source: 'manual', method: '', confidence: 'manual', setAt: T(2026, 10, day), note: 'by hand', inputs: {} });
  const base = (effort, contributorId) => merge({ sessions: recordsFor(rowsA()), effort, contributorId: contributorId || 'me-1' });
  const withEstimate = base(est(46.4, 10));
  assert.strictEqual(withEstimate.effort, 'added');
  const e = withEstimate.report.traditional_effort;
  assert.deepStrictEqual([e.hours, e.low_hours, e.high_hours, e.source, e.method, e.confidence, e.set_by], [46.4, 32.5, 69.6, 'estimated', 'size-v1', 'medium', 'me-1']);
  assert.deepStrictEqual(e.inputs, { commits: 5, prod_lines: 450, test_lines: 300, files: 14, story_points: 5 });
  const remote = roundTrip(withEstimate.report);

  const newerEstimate = merge({ remote, contributorId: 'her-2', sessions: [], effort: est(50, 12), now: NOW2 });
  assert.strictEqual(newerEstimate.report.traditional_effort.hours, 50);
  assert.strictEqual(newerEstimate.effort, 'updated');
  const olderEstimate = merge({ remote, contributorId: 'her-2', sessions: [], effort: est(30, 8), now: NOW2 });
  assert.strictEqual(olderEstimate.report.traditional_effort.hours, 46.4, 'an older estimate does not replace a newer one');
  assert.strictEqual(olderEstimate.effort, 'unchanged');
  const typed = merge({ remote, contributorId: 'her-2', sessions: [], effort: man(60, 9), now: NOW2 });
  assert.strictEqual(typed.report.traditional_effort.hours, 60, 'a typed number wins even though it is older');
  assert.deepStrictEqual([typed.report.traditional_effort.source, typed.report.traditional_effort.confidence, typed.report.traditional_effort.method, typed.report.traditional_effort.note], ['manual', 'manual', '', 'by hand']);
  const afterTyped = roundTrip(typed.report);
  const laterEstimate = merge({ remote: afterTyped, contributorId: 'me-1', sessions: [], effort: est(99, 14), now: NOW2 });
  assert.strictEqual(laterEstimate.report.traditional_effort.hours, 60, 'a newer estimate does not replace a typed number');
  const none = merge({ remote, sessions: recordsFor(rowsA()), effort: null, previouslySynced: ['aaaa-1'], now: NOW2 });
  assert.strictEqual(none.report.traditional_effort.hours, 46.4, 'no local effort leaves the one in Azure DevOps');
  assert.strictEqual(none.effort, 'unchanged');
  assert.strictEqual(merge({ sessions: recordsFor(rowsA()), effort: null }).report.traditional_effort, null);
  // changing only the effort is a change
  const onlyEffort = merge({ remote, sessions: recordsFor(rowsA()), previouslySynced: ['aaaa-1'], effort: est(51, 13), now: NOW2 });
  assert.deepStrictEqual(onlyEffort.changes, { added: 0, updated: 0, unchanged: 1, removed: 0, others: 0 });
  assert.ok(onlyEffort.changed);
});

check('an effort with no sessions is still worth writing; with nothing at all there is nothing to write', () => {
  const effortOnly = merge({ effort: { hours: 8, source: 'manual', note: '', setAt: NOW } });
  assert.ok(effortOnly.changed && !effortOnly.empty);
  assert.strictEqual(effortOnly.report.totals.session_count, 0);
  const nothing = merge({});
  assert.ok(nothing.empty && !nothing.changed);
  // a report already in Azure DevOps is brought up to date even when everything has been untagged
  const first = merge({ sessions: recordsFor(rowsA()) });
  const cleared = merge({ remote: roundTrip(first.report), sessions: [], previouslySynced: ['aaaa-1'], now: NOW2 });
  assert.ok(cleared.empty && cleared.changed, 'the stale numbers are replaced by an empty report');
  assert.strictEqual(cleared.report.totals.credits, 0);
});

check('the description round trip: what is written is read back identically, even after an editor rewrites the HTML', () => {
  const m = merge({ sessions: [...recordsFor(rowsA()), ...recordsFor(rowsB())], effort: { hours: 12.5, low: 8, high: 19, source: 'estimated', method: 'size-v1', confidence: 'high', setAt: NOW, note: '', inputs: { commits: 2 } } });
  const r = U.renderDescription(m.report);
  assert.ok(r.ok);
  const back = U.parseDescription(r.html);
  assert.strictEqual(back.state, 'ok');
  assert.strictEqual(U.contentHash(back.report), m.hashAfter);
  assert.deepStrictEqual(back.report, m.report, 'every field survives');
  const mangled = r.html.replace(/<pre>([\s\S]*)<\/pre>/, (_, inner) => `<pre class="x"><code>${inner.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\n/g, '<br>')}</code></pre>`);
  assert.notStrictEqual(mangled, r.html);
  assert.strictEqual(U.contentHash(U.parseDescription(mangled).report), m.hashAfter);
  const wrapped = `<div>Hello <b>there</b></div><pre>{"unrelated":true}</pre><div>${r.html}</div>`;
  assert.strictEqual(U.parseDescription(wrapped).state, 'ok', 'an unrelated JSON block before ours is skipped');
});

check('the description has a summary table with the right numbers and no markup that came from data', () => {
  const m = merge({ sessions: [...recordsFor(rowsA()), ...recordsFor(rowsB())], displayName: '<img src=x onerror=alert(1)>', effort: { hours: 12.5, low: 8, high: 19, source: 'estimated', method: 'size-v1', confidence: 'high', setAt: NOW, note: '<script>alert(2)</script>', inputs: {} } });
  const r = U.renderDescription(m.report);
  const html = r.html;
  assert.ok(html.includes('<tr><td>Sessions</td><td>2</td></tr>'));
  assert.ok(html.includes('<tr><td>Prompts</td><td>4</td></tr>'));
  assert.ok(html.includes('<tr><td>Credits</td><td>18.5</td></tr>'));
  assert.ok(html.includes('<tr><td>Cost (USD)</td><td>$0.19</td></tr>') || html.includes('<tr><td>Cost (USD)</td><td>$0.18</td></tr>'));
  assert.ok(html.includes('<tr><td>Input tokens</td><td>2,100</td></tr>'));
  assert.ok(html.includes('12.5 h (range 8 to 19 h), estimated, high confidence'));
  const withoutOurTags = html.replace(/<\/?(div|b|table|tr|td|br|pre)\b[^>]*>/g, '');
  assert.ok(!/[<>]/.test(withoutOurTags), 'every other < and > is escaped: ' + withoutOurTags.match(/.{0,30}[<>].{0,30}/));
  assert.ok(!html.includes('<img') && !html.includes('<script'));
  assert.strictEqual(U.parseDescription(html).state, 'ok');
});

check('reading a description that is not ours: none, unreadable, or refused - never a guess', () => {
  assert.deepStrictEqual(U.parseDescription(''), { state: 'none' });
  assert.deepStrictEqual(U.parseDescription('   '), { state: 'none' });
  assert.deepStrictEqual(U.parseDescription(null), { state: 'none' });
  assert.strictEqual(U.parseDescription('<p>Someone wrote a description here</p>').state, 'unreadable');
  assert.strictEqual(U.parseDescription('<pre>{not json</pre>').state, 'unreadable');
  assert.match(U.parseDescription('<pre>{not json</pre>').reason, /not valid JSON/);
  assert.strictEqual(U.parseDescription('<pre>{"schema":"other"}</pre>').state, 'unreadable');
  assert.strictEqual(U.parseDescription('<pre>[1,2]</pre>').state, 'unreadable');
  const newer = JSON.stringify({ schema: U.SCHEMA, schema_version: 2, contributors: [] });
  const n = U.parseDescription(`<pre>${newer}</pre>`);
  assert.strictEqual(n.state, 'refuse');
  assert.match(n.reason, /newer version/);
  assert.strictEqual(U.parseDescription(`<pre>${JSON.stringify({ schema: U.SCHEMA, schema_version: 0 })}</pre>`).state, 'unreadable');
  assert.strictEqual(U.parseDescription(`<pre>${JSON.stringify({ schema: U.SCHEMA, schema_version: '1' })}</pre>`).state, 'unreadable');
  assert.strictEqual(U.parseDescription('x'.repeat(U.LIMITS.parse + 1)).state, 'refuse');
  const many = { schema: U.SCHEMA, schema_version: 1, contributors: Array.from({ length: U.LIMITS.contributors + 1 }, (_, i) => ({ contributor_id: 'c' + i, sessions: [] })) };
  assert.strictEqual(U.parseDescription(`<pre>${JSON.stringify(many)}</pre>`).state, 'refuse');
  const lots = { schema: U.SCHEMA, schema_version: 1, contributors: [{ contributor_id: 'c1', sessions: Array.from({ length: U.LIMITS.sessions + 1 }, (_, i) => ({ session_id: 's' + i })) }] };
  assert.strictEqual(U.parseDescription(`<pre>${JSON.stringify(lots)}</pre>`).state, 'refuse');
});

check('hostile content in the report is rebuilt field by field: junk dropped, numbers clamped, nothing polluted', () => {
  const evil = `{
    "schema": "copilot-lens/story-usage", "schema_version": 1, "__proto__": { "polluted": true }, "constructor": { "prototype": { "polluted2": true } },
    "totals": { "credits": 1e12, "session_count": 99999 }, "traditional_effort": { "hours": -5 },
    "contributors": [
      { "contributor_id": "good-1", "display_name": "Na\\u0000me\\n<b>", "last_synced_at": "not a date", "__proto__": { "polluted3": true }, "sessions": [
        { "session_id": "ok-1", "credits": -4, "input_tokens": "5", "output_tokens": 1e99, "cached_input_tokens": null, "user_initiated_interaction_count": 2.6,
          "first_day": "2026-13-45", "last_day": "2026-10-07",
          "totals_by_model": [ { "model": "gpt-5\\u0007", "credits": 2, "user_initiated_interaction_count": 1 }, { "model": 5 }, null, "x", { "model": "" } ],
          "totals_by_phase": [ { "phase": "build", "credits": 1 }, { "phase": "__proto__", "credits": 1 }, { "phase": "nonsense", "credits": 1 } ],
          "totals_by_feature": [ { "feature": "Agent Mode!!", "credits": 1 } ],
          "days": [ { "day": "2026-10-07", "credits": 1 }, { "day": "yesterday", "credits": 1 }, { "day": "2026-02-30", "credits": 1 } ],
          "credit_basis": { "billed": "lots", "estimated": 3 } },
        { "session_id": "__proto__" }, { "session_id": "../../etc/passwd" }, { "session_id": "has space" }, { "session_id": "ok-1" }, { "session_id": 7 }, null, 5
      ] },
      { "contributor_id": "good-2", "sessions": [ { "session_id": "ok-1", "credits": 9 }, { "session_id": "ok-2", "credits": 1 } ] },
      { "contributor_id": "<script>", "sessions": [ { "session_id": "ok-3" } ] },
      { "sessions": [ { "session_id": "ok-4" } ] }, null, "x", 3
    ] }`;
  const p = U.parseDescription(`<pre>${evil.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`);
  assert.strictEqual(p.state, 'ok');
  assert.strictEqual({}.polluted, undefined); assert.strictEqual({}.polluted2, undefined); assert.strictEqual({}.polluted3, undefined);
  const r = p.report;
  assert.deepStrictEqual(r.contributors.map((c) => c.contributor_id), ['good-1', 'good-2']);
  assert.strictEqual(r.contributors[0].display_name, 'Na me <b>', 'text is cleaned (and is escaped again when written)');
  assert.strictEqual(r.contributors[0].last_synced_at, '');
  const s = r.contributors[0].sessions;
  assert.deepStrictEqual(s.map((x) => x.session_id), ['ok-1'], 'bad IDs and the duplicate dropped');
  assert.deepStrictEqual([s[0].credits, s[0].input_tokens, s[0].output_tokens, s[0].cached_input_tokens, s[0].user_initiated_interaction_count], [0, 0, 0, 0, 3], 'negative, text, absurd and missing numbers become 0; 2.6 rounds to 3');
  assert.deepStrictEqual([s[0].first_day, s[0].last_day], ['', '2026-10-07']);
  assert.deepStrictEqual(s[0].totals_by_model.map((e) => e.model), ['gpt-5'], 'control characters removed; non-text and empty models dropped');
  assert.deepStrictEqual(s[0].totals_by_phase.map((e) => e.phase), ['build']);
  assert.deepStrictEqual(s[0].totals_by_feature.map((e) => e.feature), ['agent_mode']);
  assert.deepStrictEqual(s[0].days.map((d) => d.day), ['2026-10-07']);
  assert.deepStrictEqual(s[0].credit_basis, { billed: 0, token_priced: 0, estimated: 3 });
  assert.deepStrictEqual(r.contributors[1].sessions.map((x) => x.session_id), ['ok-2'], 'ok-1 stays with the first contributor that listed it');
  assert.strictEqual(r.traditional_effort, null);
  assert.strictEqual(r.totals.credits, 1, 'totals are recomputed from the sessions (ok-2), never believed from the file');
  assert.strictEqual(r.totals.session_count, 2);
  for (const o of [r, r.totals, s[0], r.contributors[0]]) { assert.ok(Object.getPrototypeOf(o) === Object.prototype); assert.ok(!Object.prototype.hasOwnProperty.call(o, '__proto__')); }
});

check('reading a report twice changes nothing (normalising is idempotent), and the order of input never matters', () => {
  const m = merge({ sessions: [...recordsFor(rowsA()), ...recordsFor(rowsB())] });
  const once = roundTrip(m.report);
  const twice = roundTrip(once);
  assert.deepStrictEqual(twice, once);
  const reversed = merge({ sessions: [...recordsFor(rowsB()), ...recordsFor(rowsA())].reverse() });
  assert.strictEqual(reversed.hashAfter, m.hashAfter);
  const shuffledRows = recordsFor([...rowsA().reverse(), ...rowsB()]);
  assert.strictEqual(merge({ sessions: shuffledRows }).hashAfter, m.hashAfter, 'rows in any order give the same records');
});

check('the content hash ignores the two timestamps that change on every run, and nothing else', () => {
  const m = merge({ sessions: recordsFor(rowsA()) });
  const copy = JSON.parse(JSON.stringify(m.report));
  copy.generated_at = '2030-01-01T00:00:00.000Z'; copy.contributors[0].last_synced_at = '2030-01-01T00:00:00.000Z';
  assert.strictEqual(U.contentHash(copy), U.contentHash(m.report));
  for (const edit of [(c) => { c.totals.credits += 0.0001; }, (c) => { c.contributors[0].sessions[0].credits += 0.0001; }, (c) => { c.contributors[0].contributor_id = 'x'; }, (c) => { c.story.ado_id = 9; }, (c) => { c.traditional_effort = { hours: 1 }; }]) {
    const c2 = JSON.parse(JSON.stringify(m.report)); edit(c2);
    assert.notStrictEqual(U.contentHash(c2), U.contentHash(m.report));
  }
  assert.match(m.hashAfter, /^[0-9a-f]{64}$/);
});

check('the plan hash ties what was confirmed to what is sent: different HTML, task or revision gives a different hash', () => {
  const h = U.planHash('<p>a</p>', { id: 7, rev: 3 });
  assert.notStrictEqual(h, U.planHash('<p>b</p>', { id: 7, rev: 3 }));
  assert.notStrictEqual(h, U.planHash('<p>a</p>', { id: 7, rev: 4 }));
  assert.notStrictEqual(h, U.planHash('<p>a</p>', { id: 8, rev: 3 }));
  assert.notStrictEqual(h, U.planHash('<p>a</p>', null));
  assert.strictEqual(h, U.planHash('<p>a</p>', { id: 7, rev: 3 }));
  assert.notStrictEqual(U.planHash('x', null), U.planHash('x\n', null));
});

check('size: hundreds of ordinary sessions fit; an enormous one is refused with a message instead of being sent', () => {
  const mk = (n, models, days) => Array.from({ length: n }, (_, i) => U.canonSession({
    session_id: 'sess-' + String(i).padStart(5, '0'), first_day: '2026-09-01', last_day: '2026-10-01', user_initiated_interaction_count: 20, credits: 55.5, input_tokens: 123456, output_tokens: 23456, cached_input_tokens: 99999,
    credit_basis: { billed: 55.5 },
    totals_by_model: Array.from({ length: models }, (_, k) => ({ model: 'model-name-' + k, user_initiated_interaction_count: 3, credits: 1.2345, input_tokens: 12345, output_tokens: 2345 })),
    totals_by_feature: [{ feature: 'agent', credits: 1 }], totals_by_phase: [{ phase: 'build', credits: 1 }, { phase: 'test', credits: 1 }],
    days: Array.from({ length: days }, (_, k) => ({ day: `2026-09-${String(k + 1).padStart(2, '0')}`, user_initiated_interaction_count: 1, credits: 1.5, input_tokens: 1000, output_tokens: 100 })),
  }));
  const typical = merge({ sessions: mk(300, 3, 3) });
  const ok = U.renderDescription(typical.report);
  assert.ok(ok.ok, 'a typical story with 300 sessions fits');
  assert.ok(ok.html.length < U.LIMITS.json * 0.6, 'and uses well under the limit: ' + ok.html.length);
  const big = merge({ sessions: mk(1500, 40, 28) });
  const r = U.renderDescription(big.report);
  assert.ok(!r.ok && /too many sessions/.test(r.error), r.ok ? 'size ' + r.html.length : r.error);
  const huge = merge({ sessions: mk(U.LIMITS.sessions + 1, 1, 1) });
  assert.ok(huge.error && /more than/.test(huge.error) && !huge.changed);
  return `300 sessions -> ${ok.html.length} characters`;
});

check('effort records written by the store come out in the report\'s words, and bad ones are dropped', () => {
  assert.strictEqual(U.effortToReport(null, 'x'), null);
  assert.strictEqual(U.effortToReport({ hours: 0 }, 'x'), null);
  assert.strictEqual(U.effortToReport({ hours: NaN }, 'x'), null);
  const e = U.effortToReport({ hours: 46.44, low: 32.5, high: 69.6, source: 'estimated', method: 'size-v1', confidence: 'medium', setAt: T(2026, 10, 10), note: ' a\nb ', inputs: { prodLines: 450, testLines: 300, files: 14, points: 5, commits: 5, extra: 1 } }, 'me-1');
  assert.deepStrictEqual(e, { hours: 46.4, low_hours: 32.5, high_hours: 69.6, source: 'estimated', method: 'size-v1', confidence: 'medium', set_at: '2026-10-10T00:00:00.000Z', set_by: 'me-1', note: 'a b', inputs: { commits: 5, prod_lines: 450, test_lines: 300, files: 14, story_points: 5 } });
  const m = U.effortToReport({ hours: 8, source: 'manual', confidence: 'high', method: 'size-v1', inputs: { files: 3 } }, 'me-1');
  assert.deepStrictEqual([m.source, m.confidence, m.method], ['manual', 'manual', ''], 'a typed number never claims a method or a confidence');
  const back = U.canonEffort({ hours: 10, low_hours: 12, high_hours: 9, source: 'estimated', confidence: 'bogus', method: 'other', inputs: { prod_lines: -1, files: 'x', commits: 3 } });
  assert.deepStrictEqual([back.low_hours, back.high_hours, back.confidence, back.method, back.inputs], [null, null, 'low', '', { commits: 3 }], 'a range that does not bracket the hours is dropped');
  assert.strictEqual(U.canonEffort({ hours: 1e9 }), null);
  assert.strictEqual(U.canonEffort('x'), null);
});

check('this machine\'s own contributor ID is required', () => {
  assert.throws(() => U.mergeReport({ contributorId: '', sessions: [] }), /contributor/);
  assert.throws(() => U.mergeReport({ contributorId: '__proto__', sessions: [] }), /contributor/);
  assert.throws(() => U.mergeReport({ contributorId: 'has space', sessions: [] }), /contributor/);
});

check('the name is exactly what is shared now: turning sharing off clears a name written earlier, and saying nothing leaves it', () => {
  const first = merge({ sessions: recordsFor(rowsA()), displayName: 'Me Myself' });
  assert.strictEqual(first.report.contributors[0].display_name, 'Me Myself');
  const remote = roundTrip(first.report);
  const off = merge({ remote, sessions: recordsFor(rowsA()), displayName: '', now: NOW2 });
  assert.strictEqual(off.report.contributors[0].display_name, '', 'sharing is off, so the name written before is removed');
  assert.ok(off.changed, 'removing a name is itself a change to write');
  const silent = merge({ remote, sessions: recordsFor(rowsA()), displayName: undefined, now: NOW2 });
  assert.strictEqual(silent.report.contributors[0].display_name, 'Me Myself', 'no instruction leaves the name as it was');
  assert.ok(!silent.changed);
  const again = merge({ remote, sessions: recordsFor(rowsA()), displayName: 'Me Myself', now: NOW2 });
  assert.ok(!again.changed, 'the same name is not a change');
});

check('the contributor limit is enforced when writing, so one more person cannot make the report unreadable for everyone', () => {
  let rep = null;
  for (let i = 1; i <= U.LIMITS.contributors; i++) {
    const r = merge({ remote: rep, contributorId: 'dev-' + String(i).padStart(3, '0'), displayName: '', sessions: U.sessionsFromRows([row(sess('sess-' + i), pB1)], store()), now: NOW + i });
    assert.ok(!r.error, `contributor ${i}: ${r.error}`);
    rep = roundTrip(r.report);
  }
  assert.strictEqual(rep.contributors.length, U.LIMITS.contributors);
  const extra = merge({ remote: rep, contributorId: 'dev-extra', displayName: '', sessions: U.sessionsFromRows([row(sess('sess-extra'), pB1)], store()), now: NOW2 });
  assert.match(extra.error, /already has 50 contributors/);
  assert.strictEqual(extra.changed, false, 'nothing is written');
  const known = merge({ remote: rep, contributorId: 'dev-007', displayName: '', sessions: U.sessionsFromRows([row(sess('sess-7'), { ...pB1, credits: 9 })], store()), now: NOW2 });
  assert.ok(!known.error && known.changed, 'someone who is already in the report can still update their own sessions');
  const swap = merge({ remote: rep, contributorId: 'dev-extra', displayName: '', sessions: [], previouslySynced: [], now: NOW2 });
  assert.ok(!swap.error, 'a machine with nothing to add is not blocked');
});

check('finding the report in a description takes time in proportion to its size, whatever it is made of', () => {
  const N = 200000;
  const nasty = [
    ['only "<"', '<'.repeat(N)],
    ['<pre> never closed', '<pre>'.repeat(N / 2)],
    ['<pre with no ">"', '<pre'.repeat(N)],
    ['</pre> only', '</pre>'.repeat(N / 2)],
    ['<pre></pre> pairs with no JSON', '<pre></pre>'.repeat(N / 4)],
    ['<pre>{ pairs that are not JSON', '<pre>{</pre>'.repeat(N / 4)],
    ['<prefix> tags, which are not <pre>', '<prefix>'.repeat(N / 2)],
    ['one <pre> holding a great many tags', '<pre>' + '<b>'.repeat(N) + '</pre>'],
  ];
  for (const [name, input] of nasty) {
    const text = input.length > U.LIMITS.parse ? input.slice(0, U.LIMITS.parse) : input;
    const t0 = Date.now();
    const r = U.parseDescription(text);
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, `${name}: took ${ms} ms`);
    assert.ok(['none', 'unreadable', 'refuse'].includes(r.state), `${name}: ${r.state}`);
  }
  // and a real report in the middle of that noise is still found
  const real = merge({ sessions: recordsFor(rowsA()) });
  const html = U.renderDescription(real.report).html;
  const noisy = '<pre>'.repeat(1000) + '</pre>'.repeat(1000) + '<prefix>'.repeat(1000) + html;
  const found = U.parseDescription(noisy);
  assert.strictEqual(found.state, 'ok');
  assert.strictEqual(found.report.totals.credits, real.report.totals.credits);
});

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nUsage report checks passed.');
process.exit(failed ? 1 : 0);
