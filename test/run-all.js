'use strict';
/**
 * One-command test run: builds a synthetic VS Code data folder, scans it, then exercises the
 * dashboard UI (jsdom), the story logic and pages, and the extension wiring (mock vscode API).
 * Uses only synthetic data. Never touches the real VS Code user-data folder.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-delivery-insights-test-'));
const env = {
  ...process.env,
  LENS_FIXTURE: path.join(tmp, 'fixture'),
  LENS_DATA: path.join(tmp, 'scan.json'),
  TZ: process.env.LENS_TEST_TZ || 'Europe/London', // the clock-change regression test needs a zone that observes DST
};
// The dashboard formats dates and numbers in the viewer's locale, so the UI step runs once per locale.
// Override with LENS_TEST_LOCALES="en-US,fr-FR" (comma separated BCP 47 tags).
const locales = (process.env.LENS_TEST_LOCALES || 'en-US,en-GB,de-DE,ja-JP').split(',').map((s) => s.trim()).filter(Boolean);
const steps = [
  ['fixtures', ['test/make-fixtures.js', env.LENS_FIXTURE], {}],
  ['scanner', ['test/run-scan.js'], {}],
  ['story logic and CSV', ['test/test-stories.js'], {}],
  ['Azure DevOps store', ['test/test-ado-store.js'], {}],
  ['Azure DevOps client', ['test/test-ado.js'], {}],
  ['usage report', ['test/test-usage.js'], {}],
  ['usage report schema', ['test/test-usage-schema.js'], {}],
  ['effort estimate', ['test/test-effort.js'], {}],
  ['git reader', ['test/test-gitlog.js'], {}],
  ['hardening (chat logs, prices, settings scope)', ['test/test-hardening.js'], {}],
  ['chat log credits (billed cost, trimmed sessions)', ['test/test-chatlog-credits.js'], {}],
  ['packaging check (it must fail when a rule is broken)', ['test/test-verify-package.js'], {}],
  ['Azure DevOps service (end to end)', ['test/test-adoservice.js'], {}],
  ...locales.map((loc) => [`dashboard UI [${loc}]`, ['test/render-dashboard.js'], { LENS_TEST_LOCALE: loc }]),
  // the clock-change check finds its own 25-hour day, so repeat the UI step in other zones that observe daylight saving
  ...(process.env.LENS_TEST_TZ ? [] : ['America/New_York', 'Australia/Sydney'].map((tz) => [`dashboard UI [en-US, TZ=${tz}]`, ['test/render-dashboard.js'], { LENS_TEST_LOCALE: 'en-US', TZ: tz }])),
  // story pages and drill-down navigation, once per locale, and again in zones that observe daylight saving
  ...locales.map((loc) => [`story pages UI [${loc}]`, ['test/render-stories.js'], { LENS_TEST_LOCALE: loc }]),
  ...(process.env.LENS_TEST_TZ ? [] : ['America/New_York', 'Australia/Sydney'].map((tz) => [`story pages UI [en-US, TZ=${tz}]`, ['test/render-stories.js'], { LENS_TEST_LOCALE: 'en-US', TZ: tz }])),
  // lifecycle phase and "This workspace" with several windows, once per locale
  ...locales.map((loc) => [`phase and window UI [${loc}]`, ['test/render-phases.js'], { LENS_TEST_LOCALE: loc }]),
  // the Azure DevOps pages (connect, import, effort, sync), once per locale
  ...locales.map((loc) => [`Azure DevOps pages UI [${loc}]`, ['test/render-ado.js'], { LENS_TEST_LOCALE: loc }]),
  ['extension wiring', ['test/smoke-extension.js'], {}],
  ['Azure DevOps wiring', ['test/smoke-ado.js'], {}],
];

// Later steps still run after a failure so one report shows everything that is wrong; only a failed
// fixture build stops the run, because every other step needs it.
const failed = [];
for (const [name, args, extra] of steps) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(process.execPath, args, { cwd: path.resolve(__dirname, '..'), env: { ...env, ...extra }, stdio: 'inherit' });
  if (r.status !== 0) {
    failed.push(name);
    if (name === 'fixtures') { break; }
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
if (failed.length) { console.error(`\nTest step(s) failed: ${failed.join(', ')}`); process.exit(1); }
console.log('\nAll test steps passed.');
