'use strict';
/**
 * Traditional (no-AI) effort: how long the work in a story would have taken a developer working without AI.
 *
 * Method "size-v1" is a size-based rule of thumb, not a measurement. It counts what was changed in the repository for the
 * story and turns that into working hours with a few rates that are assumptions (all of them are settings). It is only as
 * good as the commits it is given, which is why the person sees the commit list and can untick commits first.
 *
 *   production hours = (lines added + half the lines deleted, in production files) / production lines per day * hours per day
 *   test hours       = (same count, in test files)                                / test lines per day       * hours per day
 *   file hours       = files touched * 0.25 h            (finding the code, reading it, reviewing the change)
 *   subtotal         = production + test + file hours
 *   estimate         = subtotal * (1 + overhead)          (clarifying the story, review comments, rework, builds)
 *   range            = 70% to 150% of the estimate
 *
 * Documentation (Markdown and files under docs/), lock files, generated or vendored code, build output, images and other binary files
 * are not counted. Pure functions: no
 * git, no files, no network. Reading git is lib/gitlog.js.
 */

const METHOD = 'size-v1';
const DEFAULTS = { prodLinesPerDay: 150, testLinesPerDay: 250, hoursPerDay: 8, overheadPercent: 25, hoursPerPoint: 0 };
const FILE_HOURS = 0.25;
const RANGE = { low: 0.7, high: 1.5 };
const DELETE_WEIGHT = 0.5;
const LIMITS = { hours: 100000 };

/* ------------------------------------------------------------------ */
/* Which files count                                                   */
/* ------------------------------------------------------------------ */

const LOCK_NAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'composer.lock', 'gemfile.lock', 'poetry.lock', 'pipfile.lock',
  'cargo.lock', 'go.sum', 'packages.lock.json', 'paket.lock', 'flake.lock', 'pubspec.lock', 'mix.lock', 'podfile.lock', 'gradle.lockfile',
]);
const IGNORED_DIR_RE = /(^|\/)(node_modules|vendor|third_party|third-party|bower_components|dist|build|out|target|obj|\.git|\.vs|\.idea|coverage|__pycache__|\.next|\.nuxt|__snapshots__|\.venv|venv)\/|(^|\/)bin\/(debug|release)\//i;
const IGNORED_FILE_RE = /(\.min\.(js|css)|\.map|\.snap|\.generated\.[a-z]+|\.g\.cs|\.designer\.cs|_pb2\.py|\.pb\.go|\.lock|\.log)$/i;
const MEDIA_RE = /\.(png|jpe?g|gif|bmp|ico|svg|webp|avif|tiff?|psd|ai|sketch|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|7z|rar|jar|war|dll|exe|so|dylib|class|pyc|mp3|mp4|mov|avi|wav|ogg|webm|bin|dat|vsix|nupkg)$/i;
const DOC_RE = /(\.(md|mdx|markdown|rst|adoc)$|(^|\/)docs?\/|(^|\/)(license|licence|notice|authors|changelog|contributing|codeowners)[^/]*$)/i;
const TEST_DIR_RE = /(^|\/)(tests?|__tests__|specs?|e2e|cypress|playwright|integration-tests?|unit-tests?|testing)\//i;
const TEST_FILE_RE = /(\.(test|spec|tests|e2e)\.[a-z0-9]+|_test\.[a-z0-9]+|(^|\/)test_[^/]+\.py|(^|\/)[^/]+(Tests?|Spec|IT)\.(java|kt|cs|scala|groovy|swift|php)|(^|\/)[^/]+_spec\.rb)$/i;

/** 'prod' | 'test' | 'ignored' for one path inside a repository (forward slashes). */
function classify(filePath) {
  const p = String(filePath || '').replace(/\\/g, '/');
  const name = p.split('/').pop().toLowerCase();
  if (!name) { return 'ignored'; }
  if (LOCK_NAMES.has(name) || IGNORED_DIR_RE.test(p) || IGNORED_FILE_RE.test(p) || MEDIA_RE.test(p) || DOC_RE.test(p)) { return 'ignored'; }
  if (TEST_DIR_RE.test(p) || TEST_FILE_RE.test(p)) { return 'test'; }
  return 'prod';
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/** Rates from settings (untrusted JSON): anything missing or silly falls back to the default. */
function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const pick = (k, min, max) => (typeof r[k] === 'number' && Number.isFinite(r[k]) && r[k] >= min && r[k] <= max ? r[k] : DEFAULTS[k]);
  return {
    prodLinesPerDay: pick('prodLinesPerDay', 1, 100000), testLinesPerDay: pick('testLinesPerDay', 1, 100000), hoursPerDay: pick('hoursPerDay', 1, 24),
    overheadPercent: pick('overheadPercent', 0, 500), hoursPerPoint: pick('hoursPerPoint', 0, 1000),
  };
}

/* ------------------------------------------------------------------ */
/* The estimate                                                        */
/* ------------------------------------------------------------------ */

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100; // the working in the steps keeps two decimals so the lines add up on screen
const fmt = (n) => String(Math.round(n * 10) / 10).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

/**
 * @param {object} a
 * @param {Array<{key:string, match:'id'|'branch'|'time', hash?:string, files:Array<{path:string, added:number, deleted:number, binary?:boolean}>}>} a.commits
 *        candidate commits with their per-file counts (lib/gitlog.js)
 * @param {Iterable<string>|null} [a.selected]  keys of the commits to count; null counts all
 * @param {object} [a.settings]                 rates (normalised here)
 * @param {number|null} [a.points]              the story's points, for the cross-check
 * @returns {{ok:true, hours:number, low:number, high:number, confidence:'high'|'medium'|'low', method:string, inputs:object, steps:object[], pointsCheck:object|null, notes:string[], counts:object}
 *          | {ok:false, reason:string}}
 */
function estimate(a) {
  const args = a || {};
  const s = normalizeSettings(args.settings);
  const all = Array.isArray(args.commits) ? args.commits : [];
  const chosen = args.selected == null ? null : new Set(args.selected);
  const commits = all.filter((c) => c && typeof c.key === 'string' && (!chosen || chosen.has(c.key)));
  if (!commits.length) { return { ok: false, reason: all.length ? 'No commits are ticked. Tick the commits that belong to this story, or enter the hours by hand.' : 'No commits were found for this story. Enter the hours by hand.' }; }

  let prod = 0, test = 0, ignoredFiles = 0, binaryFiles = 0;
  const prodFiles = new Set(), testFiles = new Set();
  const perCommit = [];
  for (const c of commits) {
    let weighted = 0;
    for (const f of Array.isArray(c.files) ? c.files : []) {
      const path = String(f && f.path || '');
      const kind = classify(path);
      if (kind === 'ignored') { ignoredFiles++; continue; }
      if (f.binary) { binaryFiles++; continue; }
      const added = Number.isFinite(f.added) && f.added > 0 ? f.added : 0;
      const deleted = Number.isFinite(f.deleted) && f.deleted > 0 ? f.deleted : 0;
      const w = added + DELETE_WEIGHT * deleted;
      const id = `${c.key.split(':')[0]}:${path}`;
      if (kind === 'prod') { prod += w; prodFiles.add(id); } else { test += w; testFiles.add(id); }
      weighted += w;
    }
    perCommit.push({ key: c.key, weighted });
  }
  const files = prodFiles.size + testFiles.size;
  if (!files || prod + test <= 0) {
    return { ok: false, reason: 'The ticked commits only change documentation, generated, lock or binary files, so there is nothing to size. Enter the hours by hand.' };
  }

  const prodH = (prod / s.prodLinesPerDay) * s.hoursPerDay;
  const testH = (test / s.testLinesPerDay) * s.hoursPerDay;
  const fileH = files * FILE_HOURS;
  const subtotal = prodH + testH + fileH;
  const total = subtotal * (1 + s.overheadPercent / 100);
  const hours = r1(total), low = r1(total * RANGE.low), high = r1(total * RANGE.high);
  if (!(hours > 0) || hours > LIMITS.hours) { return { ok: false, reason: 'The estimate is outside a believable range. Enter the hours by hand.' }; }

  const byId = commits.filter((c) => c.match === 'id' || c.match === 'branch').length;
  const byTime = commits.length - byId;
  const confidence = byTime === 0 ? 'high' : byId > 0 ? 'medium' : 'low';

  const notes = [];
  if (byTime > 0 && byId === 0) { notes.push('Every commit was matched only by the time you were working on the story, not by its number. Check the list carefully.'); }
  else if (byTime > 0) { notes.push(`${plural(byTime, 'commit was', 'commits were')} matched only by time, not by the story number.`); }
  const top = perCommit.slice().sort((x, y) => y.weighted - x.weighted)[0];
  if (commits.length > 1 && top && prod + test > 0 && top.weighted / (prod + test) > 0.6) {
    notes.push(`One commit (${top.key.split(':')[1].slice(0, 8)}) is more than 60% of the total. If it is a bulk import, a reformat or a rename, untick it.`);
  }
  if (prod + test < 20) { notes.push('Very little code changed, so the per-file time dominates. Treat this as a rough minimum.'); }

  const steps = [
    { label: 'Production code', value: r2(prodH), detail: `${fmt(prod)} weighted lines (lines added plus half the lines deleted) \u00f7 ${fmt(s.prodLinesPerDay)} lines a day \u00d7 ${fmt(s.hoursPerDay)} hours` },
    { label: 'Tests', value: r2(testH), detail: `${fmt(test)} weighted lines \u00f7 ${fmt(s.testLinesPerDay)} lines a day \u00d7 ${fmt(s.hoursPerDay)} hours` },
    { label: 'Files touched', value: r2(fileH), detail: `${plural(files, 'file', 'files')} \u00d7 ${FILE_HOURS} hours for finding, reading and reviewing each one` },
    { label: 'Subtotal', value: r2(subtotal), detail: 'production + tests + files' },
    { label: `Overhead +${fmt(s.overheadPercent)}%`, value: hours, detail: 'clarifying the story, review comments, rework, builds and waiting' },
    { label: 'Range', value: null, detail: `${fmt(RANGE.low * 100)}% to ${fmt(RANGE.high * 100)}% of the estimate = ${fmt(low)} to ${fmt(high)} hours, because a size rule of thumb is not precise` },
  ];

  const points = Number.isFinite(args.points) && args.points > 0 ? args.points : null;
  let pointsCheck = null;
  if (points != null && s.hoursPerPoint > 0) {
    const expected = r1(points * s.hoursPerPoint);
    const ratio = expected > 0 ? Math.round((hours / expected) * 100) / 100 : null;
    pointsCheck = {
      points, hoursPerPoint: s.hoursPerPoint, expected, ratio,
      note: ratio == null ? '' : ratio > 2 || ratio < 0.5
        ? `The story is ${fmt(points)} points, which at ${fmt(s.hoursPerPoint)} hours a point is about ${fmt(expected)} hours. The code estimate is ${ratio > 2 ? 'more than twice' : 'less than half'} of that: check that the right commits are ticked, or that the points are right.`
        : `The story is ${fmt(points)} points, which at ${fmt(s.hoursPerPoint)} hours a point is about ${fmt(expected)} hours. The code estimate is in the same range.`,
    };
  }

  return {
    ok: true, hours, low, high, confidence, method: METHOD,
    inputs: { commits: commits.length, prodLines: r1(prod), testLines: r1(test), files, points: points == null ? undefined : points },
    steps, pointsCheck, notes,
    counts: { prodFiles: prodFiles.size, testFiles: testFiles.size, ignoredFiles, binaryFiles, byId, byTime },
  };
}

/** What one commit looks like to the estimate, for the commit list: weighted lines in production and test files, and files not counted. */
function summarizeCommit(c) {
  let prod = 0, test = 0, prodFiles = 0, testFiles = 0, ignored = 0;
  for (const f of Array.isArray(c && c.files) ? c.files : []) {
    const kind = classify(String(f && f.path || ''));
    if (kind === 'ignored' || (f && f.binary)) { ignored++; continue; }
    const w = (Number.isFinite(f.added) && f.added > 0 ? f.added : 0) + DELETE_WEIGHT * (Number.isFinite(f.deleted) && f.deleted > 0 ? f.deleted : 0);
    if (kind === 'prod') { prod += w; prodFiles++; } else { test += w; testFiles++; }
  }
  return { prodLines: r1(prod), testLines: r1(test), files: prodFiles + testFiles, ignored };
}

/** The effort record the store keeps (see story-core.js normalizeEffort) for a successful estimate. */
function toEffortRecord(result, now, note) {
  if (!result || !result.ok) { return null; }
  const inputs = {};
  for (const [k, v] of Object.entries(result.inputs)) { if (typeof v === 'number') { inputs[k] = v; } }
  return { hours: result.hours, low: result.low, high: result.high, source: 'estimated', method: METHOD, confidence: result.confidence, setAt: now, note: String(note || ''), inputs };
}

module.exports = { METHOD, DEFAULTS, FILE_HOURS, RANGE, DELETE_WEIGHT, classify, normalizeSettings, estimate, summarizeCommit, toEffortRecord };
