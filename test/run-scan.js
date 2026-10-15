'use strict';
/** Scans the synthetic fixture and asserts on the result. Writes the scan to LENS_DATA for the UI test. */
const fs = require('fs');
const { scan, diagnoseText, toCsv, summarize } = require('../lib/scanner');

const fixture = process.env.LENS_FIXTURE;
const out = process.env.LENS_DATA;
if (!fixture || !out) { console.error('LENS_FIXTURE and LENS_DATA must be set (run via npm test).'); process.exit(2); }
const userDir = fixture + '/Code/User';

let failed = 0;
const check = (name, ok, extra) => { if (!ok) { failed++; } console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' -> ' + extra : '')); };

(async () => {
  const cache = { version: 2, entries: {} };
  const data = await scan({ userDirs: [userDir], cache });
  const d = data.diagnostics;
  const prompts = data.sessions.flatMap((s) => s.prompts);

  check('finds all workspaces (incl. no-folder windows)', Object.keys(data.workspaces).length === 7, Object.keys(data.workspaces).length);
  check('parses every valid session', data.sessions.length === 216, data.sessions.length);
  check('reads both .json and .jsonl formats', d.formats.json > 50 && d.formats.jsonl > 50, JSON.stringify(d.formats));
  check('JSONL mutation log replays to the same shape (pushes + sets applied)', data.sessions.some((s) => s.format === 'jsonl' && s.prompts.length > 1 && s.title));
  check('a corrupt file is reported, not fatal', d.errors.length === 1 && /broken\.json/.test(d.errors[0]), d.errors.length);
  check('multi-root workspace resolves both repos', Object.values(data.workspaces).some((w) => w.kind === 'multi-root' && w.repos.length === 2));
  check('remote (WSL) workspace is labelled', Object.values(data.workspaces).some((w) => /^WSL:/.test(w.remote)));
  check('git credentials never reach the output', !/ghp_secrettoken/.test(JSON.stringify(data)));
  check('scp-style remotes are normalised', JSON.stringify(data.workspaces).includes('github.com/acme/storefront-web'));
  check('all three data-quality levels occur', ['exact', 'tokens', 'estimated'].every((q) => prompts.some((p) => p.quality === q)));
  check('billed credits are used verbatim when present', prompts.some((p) => p.quality === 'exact' && p.credits > 0));
  check('no prompt has negative or NaN numbers', prompts.every((p) => Number.isFinite(p.credits) && p.credits >= 0 && p.inTok >= 0 && p.outTok >= 0));
  check('title-generation calls become background overhead', data.sessions.some((s) => s.overhead && s.overhead.calls >= 1));
  check('background overhead is not counted as a prompt', summarize(data, 0).prompts === prompts.length);

  const again = await scan({ userDirs: [userDir], cache });
  check('second scan is served from the cache', again.diagnostics.cacheHits === data.sessions.length, again.diagnostics.cacheHits);

  const csv = toCsv(data).split('\n');
  check('CSV has one row per prompt plus a header', csv.length === prompts.length + 1, csv.length);
  check('diagnose output lists folders and field names only', /Data folders scanned/.test(diagnoseText(data)) && !/Walk me through/.test(diagnoseText(data)));

  fs.writeFileSync(out, JSON.stringify(data));
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nscanner checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
