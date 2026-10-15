'use strict';
/**
 * UI tests for the lifecycle phase (pills, Lifecycle panel, filter, selectors) and for "This workspace"
 * when more than one VS Code window is open.
 *
 * As in render-stories.js, a small host emulator answers the page's messages using the real story store,
 * and expected values come from plain loops over the scan payload and from test/phase-oracle.js (the rule
 * written out by hand), never from the dashboard's own code. Numbers are read from text only after
 * parsing them the way the pinned locale prints them.
 *
 * Run:  LENS_DATA=<scan.json> LENS_TEST_LOCALE=de-DE node test/render-phases.js
 */
const fs = require('fs');
const assert = require('assert');
const { boot, parseLocaleNumber } = require('./harness');
const Core = require('../media/story-core.js');
const Stories = require('../lib/stories.js');
const oracle = require('./phase-oracle.js');

const LOCALE = process.env.LENS_TEST_LOCALE || 'en-US';
const data = JSON.parse(fs.readFileSync(process.env.LENS_DATA, 'utf8'));
const keyOf = (p) => (p.ts ? String(p.ts) : '#' + p.i);
// The fixture's prompts map one-to-one onto work types, so plant a few that do not: planning and investigating
// prompts under several work types. (Expected values below are worked out from this modified payload.)
data.sessions[0].prompts[0].text = 'Create a plan to fix the crash in checkout'; data.sessions[0].prompts[0].tag = 'Bug fix';
data.sessions[1].prompts[0].text = 'Design the cart architecture for multi-currency'; data.sessions[1].prompts[0].tag = 'Feature';
data.sessions[2].prompts[0].text = 'Do a root cause analysis of the slow login'; data.sessions[2].prompts[0].tag = 'Bug fix';
data.sessions[3].prompts[0].text = 'Hello'; data.sessions[3].prompts[0].tag = 'Other'; data.sessions[3].prompts[0].agent = 'Plan';
for (const x of data.sessions) { if (x.overhead) { x.overhead.credits = 7.5; } } // the fixture's background calls cost nothing; give them a cost so totals can tell whether they are counted
const queue = [];
function check(name, fn) { queue.push([name, fn]); }

/** Start a page with a host emulator wired to the real store. `current` is what the host says this window has open. */
function start(opts) {
  const o = opts || {};
  const t = boot({ locale: LOCALE, state: o.state });
  const ctx = Stories.contextFor(data);
  const log = { ops: [] };
  let store = o.store || Core.emptyStore();
  const reply = (msg) => {
    const m = JSON.parse(JSON.stringify(msg));
    if (m.type === 'ready') {
      t.send({ type: 'data', payload: o.data || data, current: o.current || { uris: [], paths: [] }, allowance: 0 });
      t.send({ type: 'stories', store: Core.toPlain(store) });
    } else if (m.type === 'story') {
      log.ops.push(m);
      const r = Stories.applyOp(store, m.op, ctx, Date.now());
      if (r.ok) { store = r.store; }
      t.send({ type: 'stories', store: Core.toPlain(store), result: r.ok ? { rid: m.rid, ok: true, message: r.message } : { rid: m.rid, ok: false, error: r.error } });
    }
  };
  t.host(reply);
  t.posted.slice().forEach(reply);
  return Object.assign(t, {
    log, store: () => store,
    jump: (route) => t.send({ type: 'route', route }),
    allTime: () => t.click(t.q('[data-set="range"][data-v="0"]')),
    metric: (m) => t.click(t.q(`[data-set="metric"][data-v="${m}"]`)),
    promptsStat: () => { const st = t.qa('.band .stat').find((x) => (x.querySelector('.l') || {}).textContent === 'prompts'); return parseLocaleNumber(st.querySelector('.v').textContent, LOCALE); },
    phaseRows: () => t.qa('[data-act="phase"]'),
  });
}

/** Names that a screen reader needs: every select and button on the page. */
function unlabeled(t) {
  const bad = [];
  for (const f of t.qa('select')) { if (!(f.getAttribute('aria-label') || f.closest('label'))) { bad.push('select without a label: ' + f.outerHTML.slice(0, 90)); } }
  for (const b of t.qa('button')) { if (!((b.getAttribute('aria-label') || b.textContent || b.getAttribute('title') || '').trim())) { bad.push('button without a name'); } }
  return bad;
}

// ---- oracle: counts per phase over the whole payload, and for one workspace ----
const countBy = (sessions) => { const m = new Map(); for (const s of sessions) { for (const p of s.prompts) { const k = oracle.guess(p); m.set(k, (m.get(k) || 0) + 1); } } return m; };
const allCounts = countBy(data.sessions);
const total = data.sessions.reduce((a, s) => a + s.prompts.length, 0);
const wsKeys = Object.keys(data.workspaces);
const wsByName = (n) => wsKeys.find((k) => data.workspaces[k].name === n);
const sessionsOf = (key) => data.sessions.filter((s) => s.wsKey === key);
const promptsIn = (key) => sessionsOf(key).reduce((a, s) => a + s.prompts.length, 0);

/* ===================================================================== */
const t = start();
check('page loads without script errors', () => { assert.deepStrictEqual(t.errors, []); });

/* ---------- Dashboard ---------- */
check('dashboard Lifecycle panel: one row per phase that has prompts, in lifecycle order, counts match the data', () => {
  t.allTime();
  const rows = t.phaseRows();
  const keys = rows.map((r) => r.dataset.key);
  const want = oracle.ORDER.filter((k) => allCounts.has(k));
  assert.deepStrictEqual(keys, want, 'phases in lifecycle order, only those with prompts');
  for (const r of rows) {
    const k = r.dataset.key;
    assert.strictEqual(r.querySelector('.t').textContent, oracle.LABEL[k], 'label for ' + k);
    const n = Number(/^(\d+) prompts?\b/.exec(r.querySelector('.meta').textContent)[1]);
    assert.strictEqual(n, allCounts.get(k), 'prompt count for ' + k);
  }
  assert.strictEqual(rows.reduce((a, r) => a + Number(/^(\d+)/.exec(r.querySelector('.meta').textContent)[1]), 0), total, 'every prompt is in exactly one phase');
  assert.strictEqual(t.qa('.stackbar[role="img"]').length >= 1, true, 'the stacked bar has a text alternative');
  assert.ok(/rule of thumb/i.test(t.text('.panel .hint') + t.qa('.panel .hint').map((h) => h.textContent).join(' ')), 'the guess is labelled as a guess');
});

check('every prompt row carries a phase pill', () => {
  t.click(t.qa('[data-act="sess"]')[0]);
  const pills = t.qa('.prompt .pill.phase');
  assert.ok(pills.length > 0, 'pills are shown in the expanded session');
  assert.ok(pills.every((p) => Object.values(oracle.LABEL).includes(p.textContent.replace(' •', '').trim())));
  assert.ok(pills.every((p) => !p.classList.contains('manual')), 'nothing is manual yet');
});

check('clicking a phase filters the whole dashboard; the chip clears it; it is remembered', () => {
  const k = 'bugfix';
  assert.ok(allCounts.get(k) > 0, 'fixture has bug-fix prompts');
  t.click(t.phaseRows().find((r) => r.dataset.key === k));
  assert.strictEqual(t.state().phase, k, 'saved with the page state');
  assert.strictEqual(t.promptsStat(), allCounts.get(k), 'the prompt count is that phase\'s count');
  assert.ok(t.qa('[data-act="clearphase"]').length === 1 && /Bug fix/.test(t.text('[data-act="clearphase"]')), 'a chip names the filter');
  assert.deepStrictEqual(t.phaseRows().map((r) => r.dataset.key), [k], 'the Lifecycle panel itself shows only the filtered phase');
  const again = start({ state: t.state() });
  again.allTime();
  assert.strictEqual(again.state().phase, k, 'a reopened page keeps the filter'); assert.strictEqual(again.promptsStat(), allCounts.get(k));
  t.click(t.q('[data-act="clearphase"]'));
  assert.strictEqual(t.state().phase, 'all'); assert.strictEqual(t.promptsStat(), total); assert.strictEqual(t.qa('[data-act="clearphase"]').length, 0);
  t.click(t.phaseRows()[0]);
  assert.notStrictEqual(t.state().phase, 'all');
  t.click(t.phaseRows()[0]);
  assert.strictEqual(t.state().phase, 'all', 'clicking the active row again turns the filter off');
  const junk = start({ state: { phase: 'definitely-not-a-phase' } });
  junk.allTime(); assert.strictEqual(junk.promptsStat(), total, 'an unknown saved phase is ignored');
  assert.strictEqual(junk.qa('[data-act="clearphase"]').length, 0, 'and no filter chip is shown');
  assert.deepStrictEqual(junk.errors, []);
});

check('a phase filter narrows prompts but, like the work-type filter, leaves background calls in the credits total', () => {
  const ph = 'bugfix';
  let prompts = 0, credits = 0, bg = 0;
  for (const x of data.sessions) { for (const p of x.prompts) { if (oracle.guess(p) === ph) { prompts++; credits += p.credits; } } if (x.overhead) { bg += x.overhead.credits; } }
  assert.ok(bg > 0, 'fixture has background calls');
  t.click(t.phaseRows().find((r) => r.dataset.key === ph));
  const shown = parseLocaleNumber(t.q('.band .big').textContent, LOCALE);
  const tol = (v) => Math.max(0.011, Math.abs(v) * 0.006); // the page prints about three significant digits
  assert.ok(Math.abs(shown - (credits + bg)) <= tol(credits + bg), `credits ${shown} = ${credits} in the phase + ${bg} background`);
  assert.strictEqual(t.promptsStat(), prompts, 'but the prompt count is only the phase\'s');
  t.click(t.q('[data-act="clearphase"]'));
});

check('a phase filter and a work-type filter combine (both must match)', () => {
  const inter = (phase, tag) => { let n = 0; for (const x of data.sessions) { for (const p of x.prompts) { if (oracle.guess(p) === phase && p.tag === tag) { n++; } } } return n; };
  const tagCount = (tag) => { let n = 0; for (const x of data.sessions) { for (const p of x.prompts) { if (p.tag === tag) { n++; } } } return n; };
  const tags = [...new Set(data.sessions.flatMap((x) => x.prompts.map((p) => p.tag)))];
  // a pair that overlaps only partly, so "both" is different from either one alone
  let partial = null;
  for (const ph of oracle.ORDER) { for (const tg of tags) { const n = inter(ph, tg); if (!partial && n > 0 && n < allCounts.get(ph) && n < tagCount(tg)) { partial = [ph, tg, n]; } } }
  assert.ok(partial, 'fixture has a partly overlapping pair');
  const [ph, tg, n] = partial;
  t.click(t.phaseRows().find((r) => r.dataset.key === ph));
  // with the phase chosen, "What the work was" lists only the work types that occur in that phase
  const offered = t.qa('[data-act="tag"]').map((b) => b.dataset.key).sort();
  assert.deepStrictEqual(offered, tags.filter((x) => inter(ph, x) > 0).sort(), 'work types offered under the phase filter');
  t.click(t.qa('[data-act="tag"]').find((b) => b.dataset.key === tg));
  assert.strictEqual(t.promptsStat(), n, `"${oracle.LABEL[ph]}" and "${tg}" together`);
  assert.ok(n < allCounts.get(ph) && n < tagCount(tg));
  t.click(t.q('[data-act="clearphase"]'));
  assert.strictEqual(t.promptsStat(), tagCount(tg), 'removing the phase leaves just the work type');
  t.click(t.q('[data-act="cleartag"]'));
  assert.strictEqual(t.promptsStat(), total);
  return `${ph} + ${tg} = ${n}`;
});

check('metric switch: the Lifecycle panel follows credits, tokens and prompts', () => {
  for (const [m, unit] of [['credits', 'credits'], ['tokens', 'tokens'], ['prompts', 'prompts']]) {
    t.metric(m);
    assert.ok(new RegExp(`of ${unit}$`).test(t.phaseRows()[0].querySelector('.meta').textContent), 'percent is of ' + unit);
  }
  t.metric('credits');
});

/* ---------- Session page ---------- */
const S1 = data.sessions.find((s) => s.prompts.length >= 4 && s.prompts.some((p) => oracle.guess(p) !== 'test'));
const keys1 = S1.prompts.map(keyOf);

check('session page: guessed pills and the Lifecycle panel match the data', () => {
  t.jump({ name: 'session', id: S1.id });
  const want = new Map(); for (const p of S1.prompts) { want.set(oracle.guess(p), (want.get(oracle.guess(p)) || 0) + 1); }
  assert.deepStrictEqual(t.phaseRows().length, 0, 'rows on this page are plain, not filter buttons');
  const rows = t.qa('.panel .list .item.static');
  assert.deepStrictEqual(rows.map((r) => r.querySelector('.t').textContent), oracle.ORDER.filter((k) => want.has(k)).map((k) => oracle.LABEL[k]));
  const selects = t.qa('select[data-sel-phase][data-ctx="prompt"]');
  assert.strictEqual(selects.length, S1.prompts.length, 'one phase selector per prompt');
  S1.prompts.forEach((p, i) => { assert.ok(selects[i].selectedOptions[0].textContent === 'Automatic (' + oracle.LABEL[oracle.guess(p)] + ')', 'prompt ' + i + ' says what the guess is'); });
  assert.deepStrictEqual(unlabeled(t), []);
});

check('session page: change one prompt; only that prompt is sent and marked', () => {
  const n = t.log.ops.length;
  const sel = t.qa('select[data-sel-phase][data-ctx="prompt"]')[1];
  sel.focus(); t.change(sel, 'docs');
  assert.strictEqual(t.log.ops.length, n + 1);
  assert.deepStrictEqual(t.log.ops[n].op, { type: 'tagPhase', sessionId: S1.id, keys: [keys1[1]], phase: 'docs' });
  assert.strictEqual(t.store().phaseTags[S1.id][keys1[1]], 'docs');
  const pills = t.qa('.prompt').filter((x) => x.querySelector('.pill.phase')).map((x) => x.querySelector('.pill.phase'));
  assert.strictEqual(pills.filter((p) => p.classList.contains('manual')).length, 1, 'exactly one prompt is marked as set by you');
  assert.strictEqual(pills[1].textContent, 'Docs •');
  assert.ok(/Docs/.test(t.qa('.toast').map((x) => x.textContent).join(' ')), 'the person is told what happened');
  assert.ok(t.doc.activeElement && t.doc.activeElement.dataset.fid === sel.dataset.fid, 'keyboard focus stays on the selector after the page redraws');
});

check('session page: set every prompt at once, then hand them all back to the automatic guess', () => {
  const n = t.log.ops.length;
  t.change(t.q('select[data-sel-phase][data-ctx="session"]'), 'test');
  assert.deepStrictEqual(t.log.ops[n].op, { type: 'tagPhase', sessionId: S1.id, keys: keys1, phase: 'test' }, 'every prompt key of the session, background calls excluded');
  const rows = t.qa('.panel .list .item.static');
  assert.deepStrictEqual(rows.map((r) => r.querySelector('.t').textContent), ['Test'], 'the whole session is now one phase');
  assert.ok(/^\d+ prompts?, 100% of credits$/.test(rows[0].querySelector('.meta').textContent) || /100%/.test(rows[0].querySelector('.meta').textContent));
  assert.ok(t.qa('.prompt .pill.phase').every((p) => p.classList.contains('manual') && p.textContent === 'Test •'));
  t.change(t.q('select[data-sel-phase][data-ctx="session"]'), '__auto__');
  assert.deepStrictEqual(t.log.ops[n + 1].op, { type: 'tagPhase', sessionId: S1.id, keys: keys1, phase: 'auto' });
  assert.ok(!Core.hasOwn(t.store().phaseTags, S1.id), 'nothing is left on file');
  assert.ok(t.qa('.prompt .pill.phase').every((p) => !p.classList.contains('manual')));
});

check('the choice placeholder does nothing', () => {
  const n = t.log.ops.length;
  t.change(t.q('select[data-sel-phase][data-ctx="session"]'), '');
  assert.strictEqual(t.log.ops.length, n);
});

/* ---------- Prompt page ---------- */
check('prompt page: shows the guess, lets you correct it, and says who set it', () => {
  const p = S1.prompts[2], k = keyOf(p);
  t.jump({ name: 'prompt', id: S1.id, key: k });
  const sel = t.q('select[data-sel-phase]');
  assert.strictEqual(sel.selectedOptions[0].textContent, 'Automatic (' + oracle.LABEL[oracle.guess(p)] + ')');
  assert.ok(/guessed from the prompt/.test(t.text('#app')), 'says it is a guess');
  assert.strictEqual(t.qa('.pchips .pill.phase').length, 1);
  t.change(sel, 'plan');
  assert.strictEqual(t.q('.pchips .pill.phase').textContent, 'Plan & design •');
  assert.ok(/set by you/.test(t.text('#app')));
  assert.strictEqual(t.q('select[data-sel-phase]').value, 'plan');
  assert.deepStrictEqual(t.log.ops[t.log.ops.length - 1].op, { type: 'tagPhase', sessionId: S1.id, keys: [k], phase: 'plan' });
  t.change(t.q('select[data-sel-phase]'), '__auto__');
  assert.ok(/guessed from the prompt/.test(t.text('#app')) && !t.q('.pchips .pill.phase.manual'));
  assert.deepStrictEqual(unlabeled(t), []);
});

check('a phase you set shows up in the dashboard Lifecycle panel and filter', () => {
  const k = keyOf(S1.prompts[0]);
  const before = oracle.guess(S1.prompts[0]);
  t.jump({ name: 'prompt', id: S1.id, key: k });
  const target = before === 'docs' ? 'review' : 'docs';
  t.change(t.q('select[data-sel-phase]'), target);
  t.jump({ name: 'dash' });
  t.allTime();
  const want = new Map(allCounts); want.set(before, want.get(before) - 1); want.set(target, (want.get(target) || 0) + 1);
  const got = new Map(t.phaseRows().map((r) => [r.dataset.key, Number(/^(\d+)/.exec(r.querySelector('.meta').textContent)[1])]));
  for (const key of oracle.ORDER) { assert.strictEqual(got.get(key) || 0, want.get(key) || 0, key); }
  assert.strictEqual(t.qa('select[data-sel-phase]').length, 0, 'the dashboard itself has no phase selectors');
});

/* ---------- Story page ---------- */
check('story page: Lifecycle covers only that story\'s prompts', () => {
  const sa = data.sessions[0], sb = data.sessions[1];
  const store = Core.emptyStore();
  store.stories.X = { id: 'X', title: 'Story X', points: null, budget: null, group: '', created: 1, updated: 1 };
  store.sessionTags[sa.id] = 'X';
  const p = start({ store });
  p.jump({ name: 'story', id: 'X' });
  const want = countBy([sa]);
  const rows = p.qa('.panel .list .item.static').filter((r) => r.querySelector('.t') && Object.values(oracle.LABEL).includes(r.querySelector('.t').textContent) && /of (credits|tokens|prompts)$/.test(r.querySelector('.meta').textContent));
  assert.deepStrictEqual(rows.map((r) => r.querySelector('.t').textContent), oracle.ORDER.filter((k) => want.has(k)).map((k) => oracle.LABEL[k]));
  assert.strictEqual(rows.reduce((a, r) => a + Number(/^(\d+)/.exec(r.querySelector('.meta').textContent)[1]), 0), sa.prompts.length, 'only this story\'s prompts; ' + sb.id + ' is not in it');
  assert.deepStrictEqual(p.errors, []);
});

/* ---------- Which workspace is this window ---------- */
const fullstackKey = wsByName('fullstack'), shopKey = wsByName('shop-api'), storefrontKey = wsByName('storefront-web');
const wsFor = (key) => data.workspaces[key];
const windowA = () => ({ uris: [shopKey, storefrontKey], paths: [wsFor(shopKey).path, wsFor(storefrontKey).path], file: fullstackKey, filePath: wsFor(fullstackKey).path });
const windowB = () => ({ uris: [storefrontKey], paths: [wsFor(storefrontKey).path], file: null, filePath: null });

check('two windows: "This workspace" is a different workspace in each, and shows its name', () => {
  const a = start({ current: windowA() }), b = start({ current: windowB() });
  for (const w of [a, b]) { w.allTime(); }
  const btnA = a.q('[data-act="here"]'), btnB = b.q('[data-act="here"]');
  assert.strictEqual(btnA.dataset.key, fullstackKey, 'the multi-root window is its workspace file, not one of its folders');
  assert.strictEqual(btnB.dataset.key, storefrontKey);
  assert.ok(/fullstack/.test(btnA.textContent) && /storefront-web/.test(btnB.textContent), 'the button names the workspace');
  assert.ok(btnA.title.includes('fullstack'));
  a.click(btnA); b.click(btnB);
  assert.strictEqual(a.q('[data-sel="ws"]').value, fullstackKey); assert.strictEqual(b.q('[data-sel="ws"]').value, storefrontKey);
  assert.strictEqual(a.promptsStat(), promptsIn(fullstackKey), 'window A: exactly the workspace file\'s prompts');
  assert.strictEqual(b.promptsStat(), promptsIn(storefrontKey), 'window B: exactly the folder\'s prompts');
  assert.notStrictEqual(a.promptsStat(), b.promptsStat(), 'the two windows show different numbers');
  a.click(a.q('[data-act="here"]')); assert.strictEqual(a.q('[data-sel="ws"]').value, 'all', 'clicking it again goes back to all workspaces');
});

check('two windows: the answer does not depend on the order workspaces were scanned in', () => {
  for (const order of [Object.keys(data.workspaces), Object.keys(data.workspaces).reverse(), [fullstackKey, ...Object.keys(data.workspaces).filter((k) => k !== fullstackKey)], [shopKey, storefrontKey, ...Object.keys(data.workspaces).filter((k) => k !== shopKey && k !== storefrontKey)]]) {
    const re = JSON.parse(JSON.stringify(data));
    re.workspaces = Object.fromEntries(order.map((k) => [k, data.workspaces[k]]));
    assert.strictEqual(start({ data: re, current: windowA() }).q('[data-act="here"]').dataset.key, fullstackKey, 'multi-root window, order: ' + order.map((k) => data.workspaces[k].name).slice(0, 3).join(','));
    assert.strictEqual(start({ data: re, current: windowB() }).q('[data-act="here"]').dataset.key, storefrontKey, 'folder window');
  }
});

check('a window whose workspace has no chats yet gets a disabled explanation, not another window\'s numbers', () => {
  const unseen = { uris: ['file:///home/someone/brand-new-project'], paths: ['/home/someone/brand-new-project'], file: null, filePath: null };
  const w = start({ current: unseen }); w.allTime();
  const btn = w.q('[data-act="here"]');
  assert.ok(btn && btn.disabled, 'the button is there but disabled');
  assert.ok(/no chats yet/.test(btn.textContent) && /no saved chats/i.test(btn.title));
  w.click(btn); assert.strictEqual(w.q('[data-sel="ws"]').value, 'all', 'clicking it does nothing');
  // a multi-root window with no chats of its own must not borrow a member folder's chats
  const multiUnseen = { uris: [shopKey], paths: [wsFor(shopKey).path], file: 'file:///home/someone/new.code-workspace', filePath: '/home/someone/new.code-workspace' };
  const m = start({ current: multiUnseen });
  assert.ok(m.q('[data-act="here"]').disabled, 'no fallback to the folder');
});

check('an empty window has no "This workspace" button', () => {
  const w = start({ current: { uris: [], paths: [], file: null, filePath: null } });
  assert.strictEqual(w.qa('[data-act="here"]').length, 0);
  assert.strictEqual(start().qa('[data-act="here"]').length, 0, 'and neither does a page that was never told');
});

check('a window name with markup is shown as text', () => {
  const evil = JSON.parse(JSON.stringify(data));
  evil.workspaces[shopKey].name = '<img src=x onerror=alert(1)>';
  const w = start({ data: evil, current: { uris: [shopKey], paths: [evil.workspaces[shopKey].path], file: null, filePath: null } });
  assert.strictEqual(w.qa('img').length, 0, 'no element was created from the name');
  assert.ok(w.q('[data-act="here"]').textContent.includes('<img'), 'the name is visible as text');
  assert.ok(w.q('[data-act="here"]').title.includes('<img'), 'and in the tooltip');
  assert.deepStrictEqual(w.errors, []);
});

check('the final page is still free of script errors', () => { assert.deepStrictEqual(t.errors, []); });

(async () => {
  let failed = 0;
  for (const [name, fn] of queue) {
    try { const r = await fn(); console.log('PASS ' + name + (r === undefined ? '' : ' -> ' + r)); } catch (e) { failed++; console.log('FAIL ' + name + ' -> ' + (e && e.message)); }
  }
  console.log(failed ? `\n${failed} CHECK(S) FAILED [${LOCALE}]` : `\nPhase and window UI checks passed [${LOCALE}].`);
  process.exit(failed ? 1 : 0);
})();
