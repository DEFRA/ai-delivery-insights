'use strict';
/**
 * UI tests for the story pages and drill-down navigation (Dashboard > Stories > Story > Session > Prompt).
 *
 * A small host emulator stands in for the extension: it answers the page's messages using the real
 * story store (lib/stories.js), so the page and the store are exercised together. Expected numbers are
 * worked out here from the scan payload with plain loops, never by calling the dashboard's own code.
 *
 * Run:  LENS_DATA=<scan.json> LENS_TEST_LOCALE=de-DE node test/render-stories.js
 * The dashboard prints numbers in the viewer's locale, so checks read the data-* attributes that carry
 * exact values, and never parse visible numbers.
 */
const fs = require('fs');
const { boot } = require('./harness');
const Core = require('../media/story-core.js');
const Stories = require('../lib/stories.js');

const LOCALE = process.env.LENS_TEST_LOCALE || 'en-US';
const base = JSON.parse(fs.readFileSync(process.env.LENS_DATA, 'utf8'));

// Work on a copy so we can plant story references in two sessions without touching the fixture.
const data = JSON.parse(JSON.stringify(base));
const [A, B, C, , , D, E] = data.sessions;
D.prompts[0].text = 'Fix the cart total, see AB#4321 for details';
E.prompts[1].text = 'Continue AB#4321 and add unit tests';
const keyOf = (p) => (p.ts ? String(p.ts) : '#' + p.i);

// ---- oracle: plain sums over the payload ----
const credits = (s) => s.prompts.reduce((a, p) => a + p.credits, 0) + (s.overhead ? s.overhead.credits : 0);
const tokens = (s) => s.prompts.reduce((a, p) => a + p.inTok + p.outTok, 0) + (s.overhead ? s.overhead.inTok + s.overhead.outTok : 0);
const nearly = (a, b, tol) => Math.abs(a - b) <= (tol || 2e-3);

const assert = require('assert');
// Checks run one after another, in order, because each builds on the page state the previous one left.
const queue = [];
function check(name, fn) { queue.push([name, fn]); }

/** Start a page with a host emulator wired to the real store. */
function start(opts) {
  const o = opts || {};
  const t = boot({ locale: LOCALE, state: o.state });
  const ctx = Stories.contextFor(data);
  const log = { ops: [], exports: [], newTabs: [], commands: [] };
  let store = o.store || Core.emptyStore();
  const held = []; let hold = false;
  const reply = (msg) => {
    const m = JSON.parse(JSON.stringify(msg)); // what the real message bridge does
    switch (m.type) {
      case 'ready':
        t.send({ type: 'data', payload: data, current: { uris: [], paths: [] }, allowance: 1000 });
        t.send({ type: 'stories', store: Core.toPlain(store) });
        break;
      case 'story': {
        log.ops.push(m);
        const r = Stories.applyOp(store, m.op, ctx, Date.now());
        if (r.ok) { store = r.store; }
        const out = { type: 'stories', store: Core.toPlain(store), result: r.ok ? { rid: m.rid, ok: true, message: r.message } : { rid: m.rid, ok: false, error: r.error } };
        if (hold) { held.push(out); } else { t.send(out); }
        break;
      }
      case 'export': log.exports.push(m); break;
      case 'newTab': log.newTabs.push(m); break;
      case 'command': log.commands.push(m); break;
      default: break;
    }
  };
  t.host(reply);
  t.posted.slice().forEach(reply); // the page said "ready" while loading, before the host was attached
  return Object.assign(t, {
    log, ctx,
    store: () => store,
    holdReplies: (on) => { hold = on; },
    releaseReplies: () => { hold = false; while (held.length) { t.send(held.shift()); } },
    replaceStoreSilently: (s) => { store = s; },
    crumbs: () => t.qa('.crumbs ol li:not(.sep)').map((li) => li.textContent.trim()),
    title: () => (t.q('#page-title') || { textContent: '' }).textContent.trim(),
    route: () => t.state().route,
    storyRow: (id) => t.q(`tr[data-story="${id}"]`),
    fillForm: (v) => { for (const k of Object.keys(v)) { t.type(t.q(`[data-f="${k}"]`), v[k]); } },
    submit: () => t.q('form[data-form="story"]').dispatchEvent(new t.w.Event('submit', { bubbles: true, cancelable: true })),
    jump: (route) => t.send({ type: 'route', route }), // as if the extension asked for the page (command palette, budget alert)
    go: (name, id, key) => {
      const sel = `[data-act="nav"][data-name="${name}"]` + (id ? `[data-id="${id}"]` : '') + (key ? `[data-key="${key}"]` : '');
      const el = t.q(sel); assert.ok(el, 'link to ' + name + ' exists'); t.click(el);
    },
  });
}

/** Everything a person could not name with a screen reader: unlabeled buttons, selects and inputs, or a missing page title. */
function a11yProblems(t) {
  const bad = [];
  const named = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim().length > 0;
  for (const b of t.qa('button')) { if (!named(b)) { bad.push('button without a name: ' + b.outerHTML.slice(0, 80)); } }
  for (const f of t.qa('select, input:not([type="hidden"])')) {
    if (!(f.getAttribute('aria-label') || f.closest('label') || (f.id && t.q(`label[for="${f.id}"]`)))) { bad.push('field without a label: ' + f.outerHTML.slice(0, 80)); }
  }
  if (t.qa('#page-title').length !== 1) { bad.push('expected exactly one #page-title, found ' + t.qa('#page-title').length); }
  for (const th of t.qa('th')) { if (!th.getAttribute('scope')) { bad.push('th without scope'); } }
  return bad;
}

/* ===================================================================== */
const t = start();
check('page loads without script errors', () => { assert.deepStrictEqual(t.errors, []); });

check('dashboard offers stories before any exist', () => {
  assert.ok(t.q('[data-act="nav"][data-name="stories"]'), 'header has a Stories button');
  assert.ok(/Set up stories/.test(t.text('.empty.slim')), 'empty-state call to action');
  assert.strictEqual(t.qa('.crumbs').length, 0, 'no breadcrumb on the dashboard');
});

/* ---------- Dashboard > Stories ---------- */
check('opening Stories: breadcrumb, focus, announcement, Esc goes back', () => {
  t.click(t.q('header [data-act="nav"][data-name="stories"]'));
  assert.strictEqual(t.route().name, 'stories');
  assert.deepStrictEqual(t.crumbs(), ['Dashboard', 'Stories']);
  assert.strictEqual(t.q('.crumbs li[aria-current="page"]').textContent, 'Stories');
  assert.strictEqual(t.doc.activeElement.id, 'page-title', 'focus moves to the page title');
  assert.strictEqual(t.text('#live'), 'Stories', 'screen readers are told where they are');
  t.key('Escape');
  assert.strictEqual(t.route().name, 'dash'); assert.strictEqual(t.qa('.crumbs').length, 0);
  t.click(t.q('header [data-act="nav"][data-name="stories"]'));
});

check('empty Stories page has no tables to misread and passes the label checks', () => {
  assert.ok(/No stories yet/.test(t.text('.panel')));
  assert.deepStrictEqual(a11yProblems(t), []);
});

/* ---------- create ---------- */
check('creating a story: validation happens before anything is sent', () => {
  t.click(t.q('[data-act="newstory"]'));
  assert.ok(t.q('form[data-form="story"]'), 'form opens');
  assert.strictEqual(t.doc.activeElement.getAttribute('data-f'), 'id', 'focus starts on the ID field');
  t.submit();
  assert.ok(t.q('.ferr[role="alert"]'), 'an empty form shows an error');
  assert.strictEqual(t.log.ops.length, 0, 'nothing was sent to the extension');
  t.fillForm({ id: 'a b', title: 'x' }); t.submit();
  assert.ok(t.q('.ferr'), 'a bad ID is refused'); assert.strictEqual(t.log.ops.length, 0);
  t.fillForm({ id: 'AB#1001', title: 'Checkout total', points: '5', budget: '50', group: 'Sprint 12' }); t.submit();
  assert.strictEqual(t.log.ops.length, 1, 'one request sent');
  const m = t.log.ops[0];
  assert.strictEqual(m.type, 'story'); assert.strictEqual(typeof m.rid, 'number');
  assert.strictEqual(m.op.type, 'saveStory'); assert.strictEqual(m.op.mode, 'new');
  assert.deepStrictEqual({ id: m.op.story.id, points: m.op.story.points, budget: m.op.story.budget, group: m.op.story.group }, { id: 'AB#1001', points: 5, budget: 50, group: 'Sprint 12' });
  assert.ok(!t.q('form[data-form="story"]'), 'form closes on success');
  assert.ok(t.q('.toast.ok'), 'a confirmation is shown');
  assert.ok(t.storyRow('AB#1001'), 'the story is listed');
  assert.strictEqual(t.storyRow('AB#1001').dataset.credits, '0.0000');
});

check('a duplicate ID is refused inside the form', () => {
  const before = t.log.ops.length;
  t.click(t.q('[data-act="newstory"]'));
  t.fillForm({ id: 'AB#1001', title: 'Again' }); t.submit();
  assert.ok(/already exists/.test(t.text('.ferr')), t.text('.ferr'));
  assert.strictEqual(t.log.ops.length, before);
  t.key('Escape');
  assert.ok(!t.q('form[data-form="story"]'), 'Esc closes the form');
  assert.strictEqual(t.route().name, 'stories', 'and stays on the page');
});

check('hostile text in a title is shown as text, never run', () => {
  t.click(t.q('[data-act="newstory"]'));
  t.fillForm({ id: 'DEL-1', title: '<img src=x onerror="window.__pwned=1">', group: '"><script>window.__pwned=2</script>' }); t.submit();
  assert.ok(t.storyRow('DEL-1'), 'created');
  assert.strictEqual(t.qa('#app img').length, 0, 'no image element was created');
  assert.strictEqual(t.qa('#app script').length, 0, 'no script element was created');
  assert.strictEqual(t.w.__pwned, undefined, 'nothing ran');
  assert.ok(t.storyRow('DEL-1').textContent.includes('<img src=x'), 'the text is visible as typed');
});

/* ---------- bulk tag ---------- */
check('bulk tagging: tick sessions, choose a story, apply; totals match the payload', () => {
  const tick = (s) => { const el = t.q(`[data-act="selrow"][data-key="${s.id}"]`); assert.ok(el, 'session is listed: ' + s.title); t.click(el); };
  tick(A); tick(B);
  assert.ok(/Tag 2 selected/.test(t.text('.bulk')), t.text('.bulk'));
  assert.ok(t.q('[data-act="bulkapply"]').disabled, 'Apply stays disabled until a story is chosen');
  t.change(t.q('[data-sel-story][data-ctx="bulk"]'), 'AB#1001');
  assert.ok(!t.q('[data-act="bulkapply"]').disabled);
  t.click(t.q('[data-act="bulkapply"]'));
  const op = t.log.ops[t.log.ops.length - 1].op;
  assert.deepStrictEqual({ type: op.type, ids: op.ids.slice().sort(), storyId: op.storyId, onlyUntagged: op.onlyUntagged }, { type: 'tagSessions', ids: [A.id, B.id].sort(), storyId: 'AB#1001', onlyUntagged: true });
  const row = t.storyRow('AB#1001');
  assert.ok(nearly(Number(row.dataset.credits), credits(A) + credits(B)), `${row.dataset.credits} vs ${credits(A) + credits(B)}`);
  assert.strictEqual(Number(row.dataset.tokens), tokens(A) + tokens(B));
  assert.strictEqual(Number(row.dataset.prompts), A.prompts.length + B.prompts.length);
  assert.strictEqual(Number(row.dataset.sessions), 2);
  assert.ok(!t.q(`[data-act="selrow"][data-key="${A.id}"]`), 'tagged sessions leave the "without a story" list');
  assert.ok(/Tagged 2 sessions/.test(t.text('.toast')), t.text('.toast'));
});

check('"select all" ticks every listed session, and ticking again clears them', () => {
  const rows = () => t.qa('[data-act="selrow"]');
  t.click(t.q('[data-act="selall"]'));
  assert.ok(rows().length > 0 && rows().every((r) => r.checked), 'all ticked');
  t.click(t.q('[data-act="selall"]'));
  assert.ok(rows().every((r) => !r.checked), 'all cleared');
});

/* ---------- suggestions ---------- */
check('suggestions: an unknown reference offers to create the story, a known one offers to tag', () => {
  const chip = t.q(`[data-act="sugnew"][data-sid="${D.id}"][data-num="4321"]`);
  assert.ok(chip, 'create-story chip for the planted AB#4321 mention');
  t.click(chip);
  assert.strictEqual(t.q('[data-f="id"]').value, '4321', 'ID is pre-filled');
  assert.ok(/will tag this session/.test(t.text('#form-h')));
  t.fillForm({ title: 'Cart total rounding' }); t.submit();
  const op = t.log.ops[t.log.ops.length - 1].op;
  assert.strictEqual(op.type, 'saveStory'); assert.deepStrictEqual(op.apply, { kind: 'sessions', ids: [D.id] });
  assert.strictEqual(t.store().sessionTags[D.id], '4321');
  const tagChip = t.q(`[data-act="sugtag"][data-sid="${E.id}"]`);
  assert.ok(tagChip, 'now the second session offers a one-click tag');
  assert.strictEqual(tagChip.dataset.story, '4321');
  t.click(tagChip);
  assert.strictEqual(t.store().sessionTags[E.id], '4321');
});

/* ---------- Story page ---------- */
check('story page: totals, points, budget state and breadcrumb', () => {
  t.go('story', 'AB#1001');
  assert.strictEqual(t.route().name, 'story');
  assert.deepStrictEqual(t.crumbs(), ['Dashboard', 'Stories', 'Story AB#1001']);
  const total = credits(A) + credits(B);
  assert.ok(nearly(Number(t.q('.hero .big').dataset.v), total), 'credits');
  assert.strictEqual(Number(t.q('.stat .v[data-k="prompts"]').dataset.v), A.prompts.length + B.prompts.length);
  assert.strictEqual(Number(t.q('.stat .v[data-k="tokens"]').dataset.v), tokens(A) + tokens(B));
  assert.ok(nearly(Number(t.q('.stat .v[data-k="perpoint"]').dataset.v), total / 5), 'credits per point');
  const want = total > 50 ? 'over' : total >= 40 ? 'warn' : 'ok';
  assert.ok(t.q('.budget').classList.contains(want), `budget state should be "${want}" for ${total.toFixed(2)} of 50`);
  assert.ok(t.qa('#chart svg rect').length > 0, 'activity chart drawn');
  assert.ok(/Possible waste/.test(t.text('#app')), 'waste signals shown');
  assert.deepStrictEqual(a11yProblems(t), []);
});

check('metric switch on the story page redraws the chart', () => {
  t.click(t.q('[data-set="metric"][data-v="tokens"]'));
  assert.strictEqual(t.state().metric, 'tokens'); assert.ok(t.qa('#chart svg rect').length > 0);
  t.click(t.q('[data-set="metric"][data-v="credits"]'));
});

check('story page: edit keeps the ID fixed; export and new tab send the right messages', () => {
  t.click(t.q('[data-act="editstory"]'));
  assert.ok(t.q('[data-f="id"]').readOnly, 'the ID cannot be edited');
  t.fillForm({ title: 'Checkout total (renamed)' }); t.submit();
  assert.ok(t.text('#page-title').includes('renamed'));
  t.click(t.q('[data-act="exportstory"]'));
  assert.deepStrictEqual(t.log.exports[t.log.exports.length - 1], { type: 'export', storyId: 'AB#1001', from: null, to: null });
  t.click(t.q('[data-act="newtab"]'));
  assert.deepStrictEqual(t.log.newTabs[t.log.newTabs.length - 1], { type: 'newTab', route: { name: 'story', id: 'AB#1001' } });
});

/* ---------- Session page ---------- */
check('session page: totals, current story, trail grows', () => {
  t.go('session', A.id);
  assert.strictEqual(t.route().name, 'session');
  const crumbs = t.crumbs();
  assert.deepStrictEqual(crumbs.slice(0, 3), ['Dashboard', 'Stories', 'Story AB#1001']); assert.strictEqual(crumbs.length, 4);
  assert.ok(nearly(Number(t.q('.hero .big').dataset.v), credits(A)));
  assert.strictEqual(t.q('[data-sel-story][data-ctx="session"]').value, 'AB#1001');
  assert.ok(t.q('[data-act="nav"][data-name="story"][data-id="AB#1001"]'), 'link back to the story');
  assert.deepStrictEqual(a11yProblems(t), []);
});

/* ---------- Prompt page ---------- */
check('prompt page: position, previous and next replace the page instead of growing the trail', () => {
  const k2 = keyOf(A.prompts[2]);
  t.click(t.q(`.prompt [data-act="nav"][data-name="prompt"][data-key="${k2}"]`));
  assert.strictEqual(t.title(), `Prompt 3 of ${A.prompts.length}`);
  const depth = t.crumbs().length; assert.strictEqual(depth, 5);
  t.click(t.qa('.actions [data-act="nav"][data-replace="1"]').find((b) => /Next/.test(b.textContent)));
  assert.strictEqual(t.title(), `Prompt 4 of ${A.prompts.length}`); assert.strictEqual(t.crumbs().length, depth, 'trail did not grow');
  t.click(t.qa('.actions [data-act="nav"][data-replace="1"]').find((b) => /Previous/.test(b.textContent)));
  assert.strictEqual(t.title(), `Prompt 3 of ${A.prompts.length}`);
  assert.deepStrictEqual(a11yProblems(t), []);
});

check('the first prompt has no Previous and the last has no Next', () => {
  t.click(t.qa('.actions [data-act="nav"][data-replace="1"]').find((b) => /Previous/.test(b.textContent)));
  t.click(t.qa('.actions [data-act="nav"][data-replace="1"]').find((b) => /Previous/.test(b.textContent)));
  assert.strictEqual(t.title(), `Prompt 1 of ${A.prompts.length}`);
  assert.ok(t.qa('.actions button').find((b) => /Previous/.test(b.textContent)).disabled);
  t.jump({ name: 'prompt', id: A.id, key: keyOf(A.prompts[A.prompts.length - 1]) });
  assert.strictEqual(t.title(), `Prompt ${A.prompts.length} of ${A.prompts.length}`);
  assert.ok(t.qa('.actions button').find((b) => /Next/.test(b.textContent)).disabled);
  t.jump({ name: 'prompt', id: A.id, key: keyOf(A.prompts[2]) });
});

check('per-prompt story: "no story", back to the session story, then a new story just for this prompt', () => {
  const k = keyOf(A.prompts[2]);
  const sel = () => t.q('[data-sel-story][data-ctx="prompt"]');
  assert.strictEqual(sel().value, '__inherit__', 'follows the session by default');
  t.change(sel(), '__none__');
  let op = t.log.ops[t.log.ops.length - 1].op;
  assert.deepStrictEqual({ type: op.type, sessionId: op.sessionId, key: op.key, value: op.value }, { type: 'tagPrompt', sessionId: A.id, key: k, value: 'none' });
  assert.strictEqual(sel().value, '__none__'); assert.ok(/set on this prompt/.test(t.text('#app')));
  // picking the session's own story is stored as "follow the session", not as a redundant override
  t.change(sel(), 'AB#1001');
  op = t.log.ops[t.log.ops.length - 1].op;
  assert.strictEqual(op.value, 'inherit'); assert.strictEqual(sel().value, '__inherit__');
  assert.ok(!Core.hasOwn(t.store().promptTags, A.id));
  // a new story created from here applies to this prompt only
  t.change(sel(), '__new__');
  assert.ok(/will tag this prompt/.test(t.text('#form-h')));
  t.fillForm({ id: 'AB#1002', title: 'Refund flow', group: 'Sprint 12' }); t.submit();
  assert.strictEqual(t.store().promptTags[A.id][k], 'AB#1002');
  assert.strictEqual(sel().value, 'AB#1002');
  assert.ok(!Core.hasOwn(t.store().sessionTags, 'AB#1002'));
});

check('moving one prompt moves exactly that prompt\'s credits and tokens between stories', () => {
  t.click(t.q('.crumbs [data-act="crumb"][data-i="1"]')); // Stories
  assert.strictEqual(t.route().name, 'stories');
  const p = A.prompts[2];
  const r1 = t.storyRow('AB#1001'), r2 = t.storyRow('AB#1002');
  assert.ok(nearly(Number(r2.dataset.credits), p.credits), 'AB#1002 has just that prompt');
  assert.strictEqual(Number(r2.dataset.tokens), p.inTok + p.outTok);
  assert.strictEqual(Number(r2.dataset.prompts), 1);
  assert.ok(nearly(Number(r1.dataset.credits), credits(A) + credits(B) - p.credits), 'AB#1001 lost it');
  assert.strictEqual(Number(r1.dataset.prompts), A.prompts.length + B.prompts.length - 1);
  assert.strictEqual(Number(r1.dataset.tokens), tokens(A) + tokens(B) - (p.inTok + p.outTok));
});

check('group roll-up adds the stories in a group and the filter narrows the list', () => {
  const rows = t.qa('.panel table.compact tbody tr').filter((tr) => /Sprint 12/.test(tr.textContent));
  assert.strictEqual(rows.length, 1, 'one roll-up row for the group');
  assert.ok(/\b2\b/.test(rows[0].cells[1].textContent), 'two stories in the group');
  const want = credits(A) + credits(B); // both stories together hold exactly the two sessions
  assert.ok(nearly(Number(t.storyRow('AB#1001').dataset.credits) + Number(t.storyRow('AB#1002').dataset.credits), want));
  t.click(t.q('[data-act="grp"][data-key="Sprint 12"]'));
  assert.deepStrictEqual(t.qa('tr[data-story]').map((r) => r.dataset.story).sort(), ['AB#1001', 'AB#1002']);
  t.click(t.q('[data-act="grp"][data-key="Sprint 12"]'));
  assert.ok(t.qa('tr[data-story]').length >= 4, 'filter cleared');
});

check('stories can be searched and sorted', () => {
  t.type(t.q('#sq'), 'refund');
  return new Promise((res) => setTimeout(res, 260)).then(() => {
    assert.deepStrictEqual(t.qa('tr[data-story]').map((r) => r.dataset.story), ['AB#1002']);
    t.type(t.q('#sq'), '');
  });
});

check('sorting by credits puts the biggest story first', () => {
  t.change(t.q('[data-sel="sSort"]'), 'credits');
  const rows = t.qa('tr[data-story]').map((r) => Number(r.dataset.credits));
  assert.deepStrictEqual(rows, rows.slice().sort((a, b) => b - a));
  t.change(t.q('[data-sel="sSort"]'), 'id');
  const ids = t.qa('tr[data-story]').map((r) => r.dataset.story);
  assert.deepStrictEqual(ids, ids.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
  t.change(t.q('[data-sel="sSort"]'), 'credits');
});

check('efficiency tables only list rows with 3 or more prompts', () => {
  const rows = t.qa('.panel table.compact').filter((tb) => /Credits \/ prompt/.test(tb.textContent)).flatMap((tb) => [...tb.querySelectorAll('tbody tr')]);
  for (const tr of rows) { assert.ok(Number(tr.cells[1].textContent.replace(/\D/g, '')) >= 3, 'row has fewer than 3 prompts: ' + tr.textContent); }
});

/* ---------- session select, clear overrides ---------- */
check('session page: removing the story, re-tagging, and "make prompts follow the session"', () => {
  t.jump({ name: 'session', id: A.id });
  const sel = () => t.q('[data-sel-story][data-ctx="session"]');
  assert.ok(/1 prompt is set individually/.test(t.text('.tagrow')), t.text('.tagrow'));
  t.click(t.q('[data-act="clearov"]'));
  let op = t.log.ops[t.log.ops.length - 1].op;
  assert.deepStrictEqual({ type: op.type, ids: op.ids, storyId: op.storyId, clearOverrides: op.clearOverrides }, { type: 'tagSessions', ids: [A.id], storyId: 'AB#1001', clearOverrides: true });
  assert.ok(!Core.hasOwn(t.store().promptTags, A.id)); assert.ok(!t.q('[data-act="clearov"]'));
  t.change(sel(), '__none__');
  op = t.log.ops[t.log.ops.length - 1].op;
  assert.strictEqual(op.storyId, null); assert.ok(!Core.hasOwn(t.store().sessionTags, A.id));
  assert.ok(!t.q('[data-act="nav"][data-name="story"][data-id="AB#1001"]'), 'no link to a story it no longer has');
  t.change(sel(), 'AB#1001');
  assert.strictEqual(t.store().sessionTags[A.id], 'AB#1001');
});

/* ---------- Back and breadcrumb ---------- */
check('Back and Alt+Left retrace the trail one step at a time; a crumb jumps several', () => {
  t.jump({ name: 'dash' }); t.click(t.q('header [data-act="nav"][data-name="stories"]')); t.go('story', 'AB#1001'); t.go('session', A.id);
  t.click(t.q(`.prompt [data-act="nav"][data-name="prompt"][data-key="${keyOf(A.prompts[1])}"]`));
  assert.strictEqual(t.crumbs().length, 5);
  const before = t.crumbs();
  t.click(t.q('[data-act="back"]'));
  assert.strictEqual(t.route().name, 'session');
  t.key('ArrowLeft', { altKey: true });
  assert.strictEqual(t.route().name, 'story', 'Alt+Left went back to the story');
  assert.ok(before.length > t.crumbs().length);
  t.click(t.q('.crumbs [data-act="crumb"][data-i="0"]'));
  assert.strictEqual(t.route().name, 'dash'); assert.strictEqual(t.qa('.crumbs').length, 0);
});

check('Esc does not leave the page while typing in a field', () => {
  t.click(t.q('header [data-act="nav"][data-name="stories"]'));
  const sq = t.q('#sq'); sq.focus();
  sq.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.strictEqual(t.route().name, 'stories');
});

check('going to a page already in the trail returns to it instead of stacking', () => {
  t.go('story', 'AB#1001'); t.go('session', A.id);
  t.go('story', 'AB#1001');
  assert.deepStrictEqual(t.crumbs(), ['Dashboard', 'Stories', 'Story AB#1001']);
});

check('the trail never holds more than 7 earlier pages, and keeps the most recent ones', () => {
  t.jump({ name: 'dash' });
  const pages = [];
  for (const s of [A, B, C]) { for (const p of s.prompts) { pages.push({ name: 'prompt', id: s.id, key: keyOf(p) }); } }
  assert.ok(pages.length >= 12, 'fixture has enough different prompts: ' + pages.length);
  for (const r of pages.slice(0, 12)) { t.jump(r); }
  assert.strictEqual(t.state().hist.length, 7, 'trail is capped at 7');
  assert.deepStrictEqual(t.state().hist[6], pages[10], 'the page just before this one is the newest entry');
  assert.deepStrictEqual(t.route(), pages[11]);
  assert.strictEqual(t.crumbs().length, 8);
});

/* ---------- Dashboard integration & date window ---------- */
check('dashboard shows a Stories panel with the top stories and leads to the page', () => {
  t.jump({ name: 'dash' });
  const panel = t.qa('.panel').find((p) => /cost per user story|top \d+ by credits/.test(p.querySelector('h2').textContent));
  assert.ok(panel, 'panel present');
  const items = t.qa('.item[data-name="story"]', panel);
  assert.ok(items.length >= 2, 'lists the stories');
  t.click(items[0]); assert.strictEqual(t.route().name, 'story');
  t.click(t.q('[data-act="back"]'));
});

check('story pages can follow the dashboard date range, and an empty range says so', () => {
  const setDate = (which, v) => { const el = t.q(`[data-date="${which}"]`); el.value = v; t.change(el); const apply = t.q('[data-act="applydates"]'); if (apply && !apply.disabled) { t.click(apply); } };
  setDate('from', '2001-01-01'); setDate('to', '2001-01-02');
  t.click(t.q('header [data-act="nav"][data-name="stories"]'));
  t.click(t.q('[data-set="storyWin"][data-v="dash"]'));
  assert.ok(t.qa('tr[data-story]').length >= 2);
  assert.ok(t.qa('tr[data-story]').every((r) => Number(r.dataset.credits) === 0 && Number(r.dataset.prompts) === 0), 'nothing in that range');
  t.go('story', 'AB#1001');
  assert.ok(/in this date range/.test(t.text('.empty.slim')), t.text('.empty.slim'));
  t.click(t.q('[data-act="exportstory"]'));
  const ex = t.log.exports[t.log.exports.length - 1];
  assert.strictEqual(ex.storyId, 'AB#1001');
  assert.strictEqual(ex.from, new Date(2001, 0, 1).getTime()); assert.strictEqual(ex.to, new Date(2001, 0, 3).getTime() - 1, 'To is the end of the last chosen day');
  t.click(t.q('[data-set="storyWin"][data-v="all"]'));
  assert.ok(Number(t.q('.hero .big').dataset.v) > 0, 'all time again');
  t.click(t.q('[data-act="exportstory"]'));
  assert.deepStrictEqual(t.log.exports[t.log.exports.length - 1], { type: 'export', storyId: 'AB#1001', from: null, to: null });
  t.click(t.q('.crumbs [data-act="crumb"][data-i="0"]'));
  t.click(t.q('[data-act="cleardates"]'));
});

/* ---------- delete ---------- */
check('delete asks first; Keep changes nothing; Delete removes the story and its tags, then leaves the page', () => {
  t.jump({ name: 'session', id: C.id });
  t.change(t.q('[data-sel-story][data-ctx="session"]'), 'DEL-1');
  assert.strictEqual(t.store().sessionTags[C.id], 'DEL-1');
  t.click(t.q('[data-act="nav"][data-name="story"][data-id="DEL-1"]'));
  assert.strictEqual(t.route().id, 'DEL-1');
  const ops = t.log.ops.length;
  t.click(t.q('[data-act="delask"]'));
  assert.ok(t.q('.confirm[role="group"]'), 'confirmation shown'); assert.strictEqual(t.log.ops.length, ops, 'asking sends nothing');
  t.click(t.q('[data-act="delcancel"]'));
  assert.ok(!t.q('.confirm')); assert.ok(Core.hasOwn(t.store().stories, 'DEL-1'));
  t.click(t.q('[data-act="delask"]')); t.click(t.q('[data-act="deldo"]'));
  const op = t.log.ops[t.log.ops.length - 1].op;
  assert.deepStrictEqual(op, { type: 'deleteStory', id: 'DEL-1' });
  assert.ok(!Core.hasOwn(t.store().stories, 'DEL-1')); assert.ok(!Core.hasOwn(t.store().sessionTags, C.id));
  assert.strictEqual(t.route().name, 'stories', 'moved off the deleted story');
  assert.ok(/Deleted DEL-1/.test(t.text('.toast')), t.text('.toast'));
  assert.ok(t.q(`[data-act="selrow"][data-key="${C.id}"]`), 'its session is back in the untagged list');
});

/* ---------- errors, stale replies, bad routes ---------- */
check('a refused request shows an error and changes nothing', () => {
  const emptied = Core.emptyStore();
  const keep = t.store();
  t.replaceStoreSilently(emptied); // the extension lost the story the page still shows
  t.jump({ name: 'session', id: B.id });
  t.change(t.q('[data-sel-story][data-ctx="session"]'), 'AB#1001');
  assert.ok(t.q('.toast.err'), 'error toast');
  assert.ok(/does not exist/.test(t.text('.toast.err')), t.text('.toast.err'));
  t.replaceStoreSilently(keep);
  t.click(t.q('[data-act="toastx"]')); assert.ok(!t.q('.toast'));
});

check('a reply to a request this page did not make is ignored, but the new data is used', () => {
  const s = Core.toPlain(t.store());
  s.stories = s.stories.concat([{ id: 'GHOST', title: 'Added elsewhere', points: null, budget: null, group: '', created: 1, updated: 1 }]);
  t.send({ type: 'stories', store: s, result: { rid: 7, ok: true, message: 'someone else did this' } });
  assert.ok(!/someone else did this/.test(t.text('#app')), 'no toast for a stranger\'s request id');
  t.jump({ name: 'stories' });
  assert.ok(t.storyRow('GHOST'), 'a story created in another tab appears');
  t.send({ type: 'stories', store: Core.toPlain(t.store()) });
  assert.ok(!t.storyRow('GHOST'));
});

check('while a request is in flight, a reply meant for something else is not mistaken for its answer', () => {
  t.jump({ name: 'stories' });
  t.click(t.q('[data-act="newstory"]')); t.fillForm({ id: 'SLOW-1', title: 'Slow one' });
  t.holdReplies(true); t.submit();
  assert.ok(t.q('form[data-form="story"]'), 'the form stays open until the extension answers');
  t.send({ type: 'stories', store: Core.toPlain(Core.emptyStore()), result: { rid: 1, ok: true, message: 'a stranger\'s message' } });
  assert.ok(t.q('form[data-form="story"]'), 'a stranger\'s reply does not close the form');
  assert.ok(!/stranger/.test(t.text('#app')), 'and shows no message');
  t.releaseReplies();
  assert.ok(!t.q('form[data-form="story"]'), 'the real answer closes it');
  assert.ok(/Created SLOW-1/.test(t.text('.toast')), t.text('.toast'));
});

check('routes from outside: missing pages say so; junk routes are ignored', () => {
  t.send({ type: 'route', route: { name: 'story', id: 'NOPE' } });
  assert.ok(/story was not found/.test(t.text('#page-title')), t.title());
  t.click(t.q('[data-act="back"]'));
  t.send({ type: 'route', route: { name: 'prompt', id: A.id, key: 'zzz' } });
  assert.ok(/prompt was not found/.test(t.text('#page-title')), t.title());
  const at = JSON.stringify(t.route());
  for (const bad of [{ name: '__proto__' }, { name: 'story' }, { name: 'session', id: 5 }, null, 'x', { name: 'story', id: 'x'.repeat(300) }]) { t.send({ type: 'route', route: bad }); }
  assert.strictEqual(JSON.stringify(t.route()), at, 'still on the same page');
  t.send({ type: 'route', route: { name: 'dash' } });
});

check('only the two backup commands can be requested from the page', () => {
  t.jump({ name: 'stories' });
  const before = t.log.commands.length;
  t.click(t.q('[data-act="cmd"][data-cmd="exportTags"]'));
  t.click(t.q('[data-act="cmd"][data-cmd="importTags"]'));
  assert.deepStrictEqual(t.log.commands.slice(before).map((c) => c.name), ['exportTags', 'importTags']);
  const evil = t.doc.createElement('button'); evil.setAttribute('data-act', 'cmd'); evil.setAttribute('data-cmd', 'workbench.action.quit');
  t.q('#app').appendChild(evil); t.click(evil);
  assert.strictEqual(t.log.commands.length, before + 2, 'an unknown command was not forwarded');
});

/* ---------- reload: state is restored ---------- */
check('reopening restores the page you were on; bad saved state falls back to the dashboard', () => {
  t.jump({ name: 'session', id: A.id });
  const saved = t.state();
  const t2 = start({ state: saved, store: t.store() });
  assert.strictEqual(t2.title(), A.title, 'the session page is showing');
  assert.deepStrictEqual(t2.crumbs(), t.crumbs(), 'same trail');
  assert.ok(!t2.state().hasOwnProperty('sel') && !t2.state().hasOwnProperty('form') && !t2.state().hasOwnProperty('toast'), 'transient state is not saved');
  const t3 = start({ state: { route: { name: 'story' }, hist: 'junk', storyWin: 'weird' } });
  assert.strictEqual(t3.title(), 'AI Delivery Insights', 'the dashboard is showing'); assert.strictEqual(t3.qa('.crumbs').length, 0); assert.deepStrictEqual(t3.errors, []);
  const t4 = start({ state: { route: { name: 'story', id: 'GONE' }, hist: [{ name: 'dash' }] }, store: Core.emptyStore() });
  assert.ok(/story was not found/.test(t4.title()), t4.title());
});

check('a stored story with a hostile ID cannot break the page', () => {
  const evil = JSON.parse('{"stories":[{"id":"constructor","title":"ctor"},{"id":"__proto__","title":"p"},{"id":"ok","title":"fine"}],"sessionTags":{"__proto__":"ok"}}');
  const t5 = start({ store: Core.normalizeStore(evil) });
  t5.go('stories');
  assert.deepStrictEqual(t5.errors, []);
  assert.deepStrictEqual(t5.qa('tr[data-story]').map((r) => r.dataset.story).sort(), ['constructor', 'ok']);
  assert.strictEqual({}.polluted, undefined);
});

check('the final page is still free of script errors', () => { assert.deepStrictEqual(t.errors, []); });

(async () => {
  let failed = 0;
  for (const [name, fn] of queue) {
    try { const r = await fn(); console.log('PASS ' + name + (r === undefined ? '' : ' -> ' + r)); } catch (e) { failed++; console.log('FAIL ' + name + ' -> ' + (e && e.message)); }
  }
  console.log(failed ? `\n${failed} CHECK(S) FAILED [${LOCALE}]` : `\nStory UI checks passed [${LOCALE}].`);
  process.exit(failed ? 1 : 0);
})();
