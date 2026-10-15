'use strict';
/**
 * Renders media/dashboard.js in jsdom against a scanned fixture and exercises the UI.
 * Run:  LENS_DATA=<scan.json> TZ=Europe/London LENS_TEST_LOCALE=en-GB node test/render-dashboard.js
 *
 * The dashboard formats dates and numbers in the viewer's own locale (the host default), which is
 * correct for users. So that the checks are deterministic on any machine, this harness pins the
 * host default locale inside the jsdom window to LENS_TEST_LOCALE (default en-US). It does this by
 * wrapping the locale-sensitive built-ins, not by setting environment variables, because the
 * environment does not control the default locale on Windows. Expected text is always produced by
 * the same pinned locale; no check hard-codes an English month name. run-all.js repeats this file
 * for several locales.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const LOCALE = process.env.LENS_TEST_LOCALE || 'en-US';
const data = JSON.parse(fs.readFileSync(process.env.LENS_DATA, 'utf8'));
const html = '<!DOCTYPE html><html><body><div class="progress"><i id="bar"></i></div><div class="wrap" id="app"></div></body></html>';
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const posted = [];
let stored = {};
w.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m), getState: () => stored, setState: (s) => { stored = s; } });
w.ResizeObserver = class { observe() {} };
Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get() { return 980; } });
const errors = [];
w.addEventListener('error', (e) => errors.push(e.message));
// Pin the "host default" locale for calls that pass `undefined` (what the dashboard does).
w.eval(`(function (loc) {
  const wrap = (proto, name) => { const orig = proto[name]; proto[name] = function (l, o) { return orig.call(this, l === undefined ? loc : l, o); }; };
  wrap(Date.prototype, 'toLocaleDateString'); wrap(Date.prototype, 'toLocaleTimeString'); wrap(Date.prototype, 'toLocaleString'); wrap(Number.prototype, 'toLocaleString');
})(${JSON.stringify(LOCALE)});`);
w.eval(fs.readFileSync(path.join(__dirname, '..', 'media', 'story-core.js'), 'utf8'));
w.eval(fs.readFileSync(path.join(__dirname, '..', 'media', 'dashboard.js'), 'utf8'));

const send = (m) => w.dispatchEvent(new w.MessageEvent('message', { data: m }));
const q = (s) => w.document.querySelector(s);
const qa = (s) => [...w.document.querySelectorAll(s)];
const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
let failed = 0; let skipped = 0;
const check = (name, ok, extra) => { if (!ok) { failed++; } console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra !== undefined ? ' -> ' + extra : '')); };
const skip = (name, why) => { skipped++; console.log('SKIP ' + name + ' -> ' + why); };

// Expected labels come from the pinned locale, built from numeric dates (never from English month names).
const FULL = { month: 'short', day: 'numeric', year: 'numeric' };
const label = (y, m, d, o) => new Date(y, m - 1, d).toLocaleDateString(LOCALE, o || FULL);
const labelIso = (s, o) => { const [y, m, d] = s.split('-').map(Number); return label(y, m, d, o); };

const setDate = (which, value) => {
  const el = q(`[data-date="${which}"]`);
  el.value = value;
  el.dispatchEvent(new w.Event('change', { bubbles: true }));
  const apply = q('[data-act="applydates"]');
  if (apply && !apply.disabled) { apply.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); }
};
const clearDates = () => { const b = q('[data-act="cleardates"]'); if (b) { click(b); } };
const dayStart = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const addDay = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d.getTime(); };
const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const iso = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// independent oracle: prompt timestamps straight from the scan payload
const stamps = data.sessions.flatMap((s) => s.prompts.map((p) => p.ts || s.created || 0));
const countIn = (lo, hiExclusive) => stamps.filter((t) => t >= lo && t < hiExclusive).length;
const shownPrompts = () => Number(q('.band .stat .v').textContent.replace(/\D/g, '')); // "1,108", "1.108" or "1 108" -> 1108

send({ type: 'progress', done: 3, total: 10 });
send({ type: 'data', payload: data, current: { uris: [Object.keys(data.workspaces)[0]], paths: [] }, allowance: 1000 });

/* ---------- baseline behaviour ---------- */
check('no script errors', errors.length === 0, errors.join(' | '));
// guards the harness itself: the window must format with the pinned locale whatever the host default is
check(`locale is pinned to ${LOCALE} inside the page`, w.eval('new Date(2026, 8, 1).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })') === label(2026, 9, 1) && w.eval('(1234567).toLocaleString()') === (1234567).toLocaleString(LOCALE), `${label(2026, 9, 1)} | ${(1234567).toLocaleString(LOCALE)}`);
check('hero credits rendered', /credits/.test(q('.hero').textContent), q('.hero').textContent);
check('chart svg + bars', qa('#chart svg rect').length > 20, qa('#chart svg rect').length + ' rects');
check('heatmap cells', qa('#heat rect').length > 100, qa('#heat rect').length);
check('workspace list', qa('[data-act="ws"]').length >= 5);
check('no credential leak', !/ghp_secret/.test(w.document.body.innerHTML));
check('sessions listed', qa('.sess').length === 25, qa('.sess').length);
check('allowance meter', !!q('.meter'));

/* ---------- date filter ---------- */
check('date inputs rendered', !!q('[data-date="from"]') && !!q('[data-date="to"]'));
check('To is optional (no required attribute)', !q('[data-date="to"]').hasAttribute('required') && !q('[data-date="from"]').hasAttribute('required'));
check('inputs cannot pick future dates', q('[data-date="to"]').getAttribute('max') === iso(Date.now()), q('[data-date="to"]').getAttribute('max'));
check('default 30-day preset active', q('[data-set="range"][data-v="30"]').getAttribute('aria-pressed') === 'true');
check('default 30-day count matches oracle', shownPrompts() === countIn(addDay(todayStart(), -29), addDay(todayStart(), 1)), shownPrompts());

// From only -> runs up to today
setDate('from', '2026-09-01');
const fromOnly = countIn(dayStart('2026-09-01'), addDay(todayStart(), 1));
check('From only: count = Sep 1 through today', shownPrompts() === fromOnly, `${shownPrompts()} vs ${fromOnly}`);
check('From only: "up to today" hint shown', /up to today/.test(q('.daterange').textContent));
check('From only: quick ranges all deselected', qa('[data-set="range"]').every((b) => b.getAttribute('aria-pressed') === 'false'));
check('From only: Activity heading says "to today"', q('.panel h2').textContent.includes(`${labelIso('2026-09-01')} to today`), q('.panel h2').textContent);
check('From only: chart still renders', qa('#chart svg rect').length > 10);
check('From only: state persisted for reload', stored.from === '2026-09-01' && stored.to === '');

// From + To
setDate('to', '2026-09-15');
const both = countIn(dayStart('2026-09-01'), dayStart('2026-09-16'));
check('From+To: count inclusive of the To day', shownPrompts() === both, `${shownPrompts()} vs ${both}`);
check('From+To: heading names both dates, no "today"', q('.panel h2').textContent.includes(`${labelIso('2026-09-01')} to ${labelIso('2026-09-15')}`) && !/to today/.test(q('.panel h2').textContent), q('.panel h2').textContent);
check('From+To: every costliest-prompt row is inside the window', (() => {
  click(q('[data-act="tab"][data-key="top"]'));
  // each row's date cell (a child of .when) must be one of the 15 days Sep 1..15; an empty list would pass vacuously, so require rows
  const allowed = new Set(); for (let d = 1; d <= 15; d++) { allowed.add(label(2026, 9, d)); }
  const rows = qa('.prompt .when');
  const ok = rows.length > 0 && rows.every((el) => [...el.children].some((c) => allowed.has(c.textContent)));
  click(q('[data-act="tab"][data-key="sessions"]'));
  return ok;
})());

// moving one date past the other: the edited date wins and the other follows
setDate('from', '2026-09-20');   // To was Sep 15
check('From moved past To: To follows From', q('[data-date="from"]').value === '2026-09-20' && q('[data-date="to"]').value === '2026-09-20', `${q('[data-date="from"]').value} / ${q('[data-date="to"]').value}`);
check('...giving a one-day window', shownPrompts() === countIn(dayStart('2026-09-20'), dayStart('2026-09-21')), shownPrompts());
setDate('to', '2026-09-10');
check('To moved before From: From follows To', q('[data-date="from"]').value === '2026-09-10' && q('[data-date="to"]').value === '2026-09-10', `${q('[data-date="from"]').value} / ${q('[data-date="to"]').value}`);
setDate('from', '2026-09-01');
check('widening afterwards works', shownPrompts() === countIn(dayStart('2026-09-01'), dayStart('2026-09-11')), shownPrompts());

// clearing To again makes it open-ended
setDate('to', '');
check('clearing To returns to open-ended', /up to today/.test(q('.daterange').textContent) && shownPrompts() === countIn(dayStart('2026-09-01'), addDay(todayStart(), 1)));

// To only -> from the earliest prompt
clearDates();
setDate('to', '2026-08-01');
const toOnly = countIn(-Infinity, dayStart('2026-08-02'));
check('To only: everything up to that day', shownPrompts() === toOnly, `${shownPrompts()} vs ${toOnly}`);

// future To is clamped to today
clearDates();
setDate('from', '2026-09-01'); setDate('to', '2027-06-30');
check('future To is clamped to today', shownPrompts() === fromOnly && q('.panel h2').textContent.includes(`${labelIso('2026-09-01')} to ${new Date().toLocaleDateString(LOCALE, FULL)}`), q('.panel h2').textContent);

// export carries the window
posted.length = 0;
setDate('to', '');
click(q('[data-act="export"]'));
const exp = posted.find((m) => m.type === 'export');
check('export posts the From..today window', !!exp && exp.from === dayStart('2026-09-01') && exp.to === addDay(todayStart(), 1) - 1, JSON.stringify(exp));

// quick range replaces custom dates; Clear works
click(q('[data-set="range"][data-v="7"]'));
check('quick range clears custom dates', q('[data-date="from"]').value === '' && q('[data-date="to"]').value === '' && stored.from === '' && stored.to === '');
check('7-day count matches oracle', shownPrompts() === countIn(addDay(todayStart(), -6), addDay(todayStart(), 1)), shownPrompts());
click(q('[data-set="range"][data-v="0"]'));
posted.length = 0; click(q('[data-act="export"]'));
check('all-time export is unbounded', posted[0] && posted[0].from === null && posted[0].to === null, JSON.stringify(posted[0]));
check('all-time count = every prompt', shownPrompts() === stamps.length, `${shownPrompts()} vs ${stamps.length}`);

// a range with no data is handled
clearDates(); setDate('from', '2024-01-01'); setDate('to', '2024-01-31');
check('empty window shows empty states, no crash', shownPrompts() === 0 && /No sessions match|No data in this range/.test(w.document.body.textContent) && errors.length === 0);
check('empty window still draws an axis', qa('#chart svg').length === 1);

// clock-change regression: a window that spans the autumn clock change (a 25-hour local day) must show consecutive
// day labels with no repeat. The test finds that day in 2025 for whatever time zone the run uses (Europe/London: 26 Oct,
// America/New_York: 2 Nov, Australia/Sydney: 6 Apr). A zone without daylight saving, or a platform that ignores the TZ
// variable while the system zone has none, has no such day: report a SKIP rather than failing or passing silently.
let fallBack = null;
for (let m = 0; m < 12 && !fallBack; m++) {
  for (let d = 1; d <= 28; d++) { if ((new Date(2025, m, d + 1) - new Date(2025, m, d)) / 36e5 === 25) { fallBack = { m, d }; break; } }
}
if (!fallBack) {
  skip('DST fall-back: bar labels are consecutive days', `no 25-hour day in 2025 in this time zone (TZ=${process.env.TZ || 'system default'}); run under a zone such as Europe/London`);
} else {
  const day = (k) => new Date(2025, fallBack.m, fallBack.d + k); // calendar arithmetic: overflow rolls into the next month
  const isoOf = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  clearDates();
  setDate('from', isoOf(day(-6))); setDate('to', isoOf(day(4)));
  const labels = qa('#chart .axis text[text-anchor="middle"]').map((t) => t.textContent); // x-axis labels; the y-axis ticks are anchored at the end
  const want = []; for (let k = -6; k <= 4; k++) { want.push(day(k).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' })); }
  check(`DST fall-back (25-hour day ${isoOf(day(0))}): bar labels are consecutive days`, JSON.stringify(labels) === JSON.stringify(want), labels.join(', '));
}

// long custom spans switch to weekly bars
clearDates(); setDate('from', '2025-01-01');
check('long span uses weekly buckets', /per week/.test(q('.panel h2').textContent), q('.panel h2').textContent);
clearDates();

/* ---------- unchanged behaviours ---------- */
click(q('[data-set="range"][data-v="30"]'));
click(qa('[data-act="sess"]')[0]);
check('session expands to prompts', qa('.prompt').length > 0);
click(q('[data-set="metric"][data-v="tokens"]'));
check('metric switch -> tokens', /tokens/.test(q('.panel h2 span').textContent));
click(q('[data-set="metric"][data-v="credits"]'));
click(q('[data-act="ws"]')); check('workspace filter applied', qa('.item.on').length >= 1);
click(q('[data-act="ws"]'));
const sel = q('[data-sel="model"]'); sel.value = sel.options[1].value; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
check('model filter via select', !!q('.band'));
data.sessions[0].prompts[0].text = '<img src=x onerror=alert(1)>';
send({ type: 'data', payload: data });
check('html in prompt text is escaped', !w.document.querySelector('img[src="x"]'));
send({ type: 'data', payload: { ...data, sessions: [], workspaces: {}, sources: [{ edition: 'VS Code', dir: '/nope' }] } });
check('empty-history state', /No Copilot chat history found/.test(q('.empty').textContent));
check('no script errors at end', errors.length === 0, errors.join(' | '));

console.log(failed ? `\n${failed} CHECK(S) FAILED [${LOCALE}]` : `\nALL CHECKS PASSED [${LOCALE}]${skipped ? ` (${skipped} skipped, see SKIP lines)` : ''}`);
process.exit(failed ? 1 : 0);
