'use strict';
/**
 * Shared jsdom harness for dashboard UI tests.
 * The dashboard formats dates and numbers in the viewer's locale; boot() pins the page's default
 * locale (by wrapping the locale-sensitive built-ins, because environment variables do not control it
 * on Windows). See render-dashboard.js for the longer explanation.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SHELL = '<!DOCTYPE html><html><body><div class="progress"><i id="bar"></i></div><div class="wrap" id="app"></div><div id="live" class="sr" role="status" aria-live="polite"></div></body></html>';

/**
 * @param {{locale?:string, state?:object}} [opts]
 * @returns the page plus helpers; `host(fn)` registers a function that sees every message the page posts.
 */
function boot(opts) {
  const o = opts || {};
  const locale = o.locale || process.env.LENS_TEST_LOCALE || 'en-US';
  const dom = new JSDOM(SHELL, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const posted = [];
  let stored = o.state ? JSON.parse(JSON.stringify(o.state)) : {};
  let hostFn = null;
  w.acquireVsCodeApi = () => ({
    postMessage: (m) => { posted.push(m); if (hostFn) { hostFn(m); } },
    getState: () => stored,
    setState: (s) => { stored = JSON.parse(JSON.stringify(s)); },
  });
  w.ResizeObserver = class { observe() {} };
  w.scrollTo = () => {};
  Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get() { return 980; } });
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.eval(`(function (loc) {
    const wrap = (proto, name) => { const orig = proto[name]; proto[name] = function (l, o) { return orig.call(this, l === undefined ? loc : l, o); }; };
    wrap(Date.prototype, 'toLocaleDateString'); wrap(Date.prototype, 'toLocaleTimeString'); wrap(Date.prototype, 'toLocaleString'); wrap(Number.prototype, 'toLocaleString');
  })(${JSON.stringify(locale)});`);
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'media', 'story-core.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'media', 'dashboard.js'), 'utf8'));
  const doc = w.document;
  return {
    w, doc, posted, errors, locale,
    host: (fn) => { hostFn = fn; },
    state: () => stored,
    send: (m) => w.dispatchEvent(new w.MessageEvent('message', { data: m })),
    q: (s, root) => (root || doc).querySelector(s),
    qa: (s, root) => [...(root || doc).querySelectorAll(s)],
    click: (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    change: (el, value) => { if (value !== undefined) { el.value = value; } el.dispatchEvent(new w.Event('change', { bubbles: true })); },
    type: (el, value) => { el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); },
    key: (key, init) => doc.dispatchEvent(new w.KeyboardEvent('keydown', Object.assign({ key, bubbles: true }, init || {}))),
    text: (s) => { const el = doc.querySelector(s); return el ? el.textContent : ''; },
  };
}

/** Parse a number the way this locale prints it ("1,234.5", "1.234,5"). */
function parseLocaleNumber(text, locale) {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  const group = (parts.find((p) => p.type === 'group') || {}).value || ',';
  const dec = (parts.find((p) => p.type === 'decimal') || {}).value || '.';
  const m = /[\d][\d.,\s  ]*/.exec(text);
  if (!m) { return NaN; }
  return Number(m[0].split(group).join('').split(dec).join('.').replace(/[\s  ]/g, ''));
}

module.exports = { boot, parseLocaleNumber };
