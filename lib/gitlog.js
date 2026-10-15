'use strict';
/**
 * Read-only access to a local git repository, to find the commits that belong to a story and count what they changed.
 *
 * This is the only module that starts another program. It runs `git` and nothing else, without a shell (arguments are
 * passed as a list, so nothing a commit message, branch name or story ID contains can be run), and only for commands that
 * read: log, show, for-each-ref, rev-parse and config --get. A repository's own configuration is untrusted (a cloned
 * repository can set programs to run), so every command switches off the settings that can start programs: the file-system
 * monitor, external diff programs and text conversion filters. A partial clone can also make git fetch missing objects
 * when a command needs them, and a fetch starts whatever the repository names as its ssh command, proxy or credential
 * helper, so every network transport is switched off as well (config and environment), as is lazy fetching, and those
 * settings are cleared. The environment is stripped of GIT_* variables so the repository cannot be redirected. Nothing is
 * ever written, fetched or checked out. A commit whose contents cannot be read without a fetch is skipped and reported.
 *
 * git itself is found by walking the PATH once and using an absolute path, never the repository folder: on Windows a
 * program called git.exe in the working directory would otherwise be started first.
 *
 * What it reads about people: the author e-mail of each commit, only to decide whether a commit made during a Copilot
 * session was made by the person running VS Code. It is compared and thrown away, never stored or sent.
 *
 * Commits are found three ways, strongest first:
 *   id      the story number (AB#1234, #1234) or the story's own ID appears in the commit message
 *   branch  the commit is on a branch whose name contains the story number, and is not on the main branch
 *   time    the commit was made by you during the hours you were chatting about this story
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { cleanText } = require('./text.js');

const LIMITS = { scan: 10000, commits: 300, files: 5000, totalFiles: 20000, pathChars: 400, timeoutMs: 30000, totalMs: 90000, buffer: 64 * 1024 * 1024, branchCommits: 1000, branches: 50 };
const BASE_CANDIDATES = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master', 'develop', 'origin/develop'];
const HASH_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');

/** Environment for git: the person's own, minus anything that could point git somewhere else or make it ask questions. */
function gitEnv(base) {
  const env = {};
  for (const [k, v] of Object.entries(base || process.env)) { if (!/^GIT_/i.test(k) && typeof v === 'string') { env[k] = v; } }
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C', LANG: 'C',
    // no transport at all, so nothing can be fetched and nothing the repository names as a transport helper can start
    GIT_ALLOW_PROTOCOL: 'none', GIT_NO_LAZY_FETCH: '1', GIT_SSH_COMMAND: 'false', GIT_ASKPASS: 'false', GIT_EXTERNAL_DIFF: '',
  });
  return env;
}

/**
 * Find git without looking in the working directory: the first absolute PATH entry that holds an executable file called
 * git (git.exe on Windows). Returns null when there is none. Relative and empty PATH entries are skipped, because they mean
 * "the current directory", which in a cloned repository is the attacker's.
 */
function findGit(env, platform) {
  const plat = platform || process.platform;
  const e = env || process.env;
  const raw = plat === 'win32' ? (e.Path || e.PATH || e.path || '') : (e.PATH || '');
  const names = plat === 'win32' ? ['git.exe'] : ['git'];
  const sep = plat === 'win32' ? ';' : ':';
  for (const dir0 of String(raw).split(sep)) {
    const dir = dir0.replace(/^"(.*)"$/, '$1');
    if (!dir || !(plat === 'win32' ? path.win32.isAbsolute(dir) : path.posix.isAbsolute(dir))) { continue; }
    for (const n of names) {
      const full = plat === 'win32' ? path.win32.join(dir, n) : path.posix.join(dir, n);
      try { if (fs.statSync(full).isFile()) { return full; } } catch { /* not here */ }
    }
  }
  return null;
}

// Settings that let a repository's config start a program, switched off for every command.
const SAFE_CONFIG = [
  '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'core.untrackedCache=false', '-c', 'diff.external=', '-c', 'log.showSignature=false', '-c', 'core.quotepath=false',
  // no transport, and nothing a repository can name to run while fetching (a partial clone fetches missing objects on demand)
  '-c', 'protocol.allow=never', '-c', 'core.sshCommand=false', '-c', 'core.gitProxy=', '-c', 'credential.helper=', '-c', 'core.askPass=',
];

function createReader(opts) {
  const o = opts || {};
  const found = o.command ? o.command : findGit(o.env || process.env);
  const command = found || 'git';
  const noGit = !found;
  const deadline = Date.now() + (Number.isFinite(o.totalMs) ? o.totalMs : LIMITS.totalMs);
  const env = gitEnv(o.env);

  function run(repo, args, extra) {
    return new Promise((resolve) => {
      const left = deadline - Date.now();
      if (left <= 0) { resolve({ ok: false, kind: 'timeout', stdout: '', stderr: '' }); return; }
      if (noGit) { resolve({ ok: false, kind: 'missing', stdout: '', stderr: '' }); return; }
      execFile(command, ['--no-pager', ...SAFE_CONFIG, ...args], {
        cwd: repo, env, shell: false, windowsHide: true, encoding: 'utf8',
        timeout: Math.min(left, (extra && extra.timeoutMs) || LIMITS.timeoutMs), maxBuffer: (extra && extra.maxBuffer) || LIMITS.buffer,
      }, (err, stdout, stderr) => {
        if (!err) { resolve({ ok: true, stdout, stderr }); return; }
        const kind = err.code === 'ENOENT' ? 'missing' : err.killed || err.signal ? 'timeout' : err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'big' : 'failed';
        resolve({ ok: false, kind, code: err.code, stdout: stdout || '', stderr: cleanText(stderr || err.message, 200) });
      });
    });
  }
  return { run };
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/** Parse `git show -z --numstat --format=` output: "added<TAB>deleted<TAB>path NUL", renames as "a<TAB>d<TAB> NUL old NUL new NUL". */
function parseNumstat(out) {
  const files = [];
  const tokens = String(out || '').split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i].replace(/^\n+/, '');
    if (!tok) { continue; }
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tok);
    if (!m) { continue; }
    let file = m[3];
    if (file === '') { file = tokens[i + 2] || ''; i += 2; } // a rename: the old and new names follow
    if (!file) { continue; }
    const binary = m[1] === '-' || m[2] === '-';
    files.push({ path: file.replace(/\\/g, '/').slice(-LIMITS.pathChars), added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), binary });
    if (files.length >= LIMITS.files) { break; }
  }
  return files;
}

/** Parse the `git log` records: hash, author date, author e-mail, subject, body. */
function parseLog(out) {
  const commits = [];
  for (const rec of String(out || '').split('\x1e')) {
    const r = rec.replace(/^\n+/, '');
    if (!r) { continue; }
    const f = r.split('\x1f');
    if (f.length < 4 || !HASH_RE.test(f[0])) { continue; }
    const t = Date.parse(f[1]);
    if (!Number.isFinite(t)) { continue; }
    commits.push({ hash: f[0], ts: t, email: String(f[2] || '').trim().toLowerCase(), subject: f[3], body: f.slice(4).join('\x1f') });
  }
  return commits;
}

/** The patterns that say "this text is about story N": AB#N, #N, and the story's own ID. */
function idMatchers(ids) {
  const out = [];
  const n = ids && Number.isInteger(ids.adoId) && ids.adoId > 0 ? ids.adoId : null;
  if (n != null) { out.push(new RegExp(`(?:^|[^A-Za-z0-9])(?:AB)?#${n}(?![0-9])`, 'i')); }
  const local = ids && typeof ids.localId === 'string' ? ids.localId.trim() : '';
  if (local && /^[A-Za-z0-9][A-Za-z0-9#._:\-]{0,39}$/.test(local) && !/^\d+$/.test(local.replace(/^AB#/i, ''))) {
    out.push(new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegex(local)}(?![A-Za-z0-9])`, 'i'));
  }
  return out;
}

/** Branch names that mention the story: the number between non-digits, or the story's own ID. */
function branchMatchers(ids) {
  const out = [];
  const n = ids && Number.isInteger(ids.adoId) && ids.adoId > 0 ? ids.adoId : null;
  if (n != null) { out.push(new RegExp(`(?:^|[^0-9])${n}(?![0-9])`)); }
  const local = ids && typeof ids.localId === 'string' ? ids.localId.trim() : '';
  if (local && /^[A-Za-z0-9][A-Za-z0-9#._:\-]{0,39}$/.test(local) && !/^\d+$/.test(local.replace(/^AB#/i, ''))) {
    out.push(new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegex(local)}(?![A-Za-z0-9])`, 'i'));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Collecting                                                          */
/* ------------------------------------------------------------------ */

const cleanWindows = (list) => (Array.isArray(list) ? list : []).filter((w) => w && Number.isFinite(w.from) && Number.isFinite(w.to) && w.to >= w.from).slice(0, 2000);

const FAILURE = {
  missing: 'Git was not found on this computer. Install git, or enter the hours by hand.',
  timeout: 'Git took too long to answer.',
  big: 'The repository history is too large to read here.',
};

/**
 * Find the commits for a story in some repositories and count their changes.
 * @param {object} a
 * @param {Array<{path:string, label?:string, windows?:Array<{from:number,to:number}>}>} a.repos    local repository folders (absolute paths); a repository's own windows replace the general ones
 * @param {{adoId:number|null, localId:string}} a.ids
 * @param {Array<{from:number, to:number}>} [a.windows]    times (ms) when you were working on the story, for time matches
 * @param {number} [a.maxCommits]
 * @param {string} [a.command]                             for tests: the git program
 * @returns {Promise<{repos:object[], commits:object[], notes:string[]}>}
 */
async function collect(a) {
  const args = a || {};
  const reader = createReader({ command: args.command, env: args.env, totalMs: args.totalMs });
  const max = Number.isInteger(args.maxCommits) && args.maxCommits > 0 ? Math.min(args.maxCommits, LIMITS.commits) : LIMITS.commits;
  const idRes = idMatchers(args.ids);
  const brRes = branchMatchers(args.ids);
  const windows = cleanWindows(args.windows);
  const notes = [];
  const repoInfo = [];
  const found = [];
  const seenPaths = new Set();

  for (const spec of Array.isArray(args.repos) ? args.repos.slice(0, 20) : []) {
    const repoPath = spec && typeof spec.path === 'string' ? spec.path : '';
    const label = cleanText(spec && spec.label || path.basename(repoPath), 80) || 'repository';
    const info = { label, ok: false, error: '', scanned: 0, capped: false };
    repoInfo.push(info);
    if (!repoPath || !path.isAbsolute(repoPath)) { info.error = 'The repository folder is not a full path.'; continue; }
    const real = path.resolve(repoPath);
    if (seenPaths.has(real)) { info.error = 'Listed twice.'; continue; }
    seenPaths.add(real);
    let st;
    try { st = fs.statSync(real); } catch { info.error = 'The repository folder no longer exists.'; continue; }
    if (!st.isDirectory() || !fs.existsSync(path.join(real, '.git'))) { info.error = 'This folder is not a git repository.'; continue; }
    const ri = repoInfo.length - 1;

    // times when you were working on the story in this repository (each repository may have its own), and who you are in git
    const repoWindows = Array.isArray(spec.windows) ? cleanWindows(spec.windows) : windows;
    let me = '';
    if (repoWindows.length) {
      const cfg = await reader.run(real, ['config', '--get', 'user.email']);
      if (!cfg.ok && cfg.kind === 'missing') { info.error = FAILURE.missing; continue; }
      me = cfg.ok ? cfg.stdout.trim().toLowerCase() : '';
    }

    const log = await reader.run(real, ['log', '--all', '--no-merges', '-n', String(LIMITS.scan), '--no-show-signature', '--format=%H%x1f%aI%x1f%ae%x1f%s%x1f%b%x1e']);
    if (!log.ok) {
      if (FAILURE[log.kind]) { info.error = FAILURE[log.kind]; continue; }
      if (/does not have any commits yet|bad default revision|unknown revision/i.test(log.stderr)) { info.ok = true; continue; }
      info.error = /dubious ownership|safe\.directory/i.test(log.stderr) ? 'Git refuses to read this repository because it belongs to another user.' : (log.stderr ? `Git could not read this repository: ${log.stderr}` : 'Git could not read this repository.');
      continue;
    }
    info.ok = true;
    const all = parseLog(log.stdout);
    info.scanned = all.length;
    if (all.length >= LIMITS.scan) { info.capped = true; notes.push(`${label}: only the newest ${LIMITS.scan.toLocaleString('en-US')} commits were searched.`); }

    const matched = new Map(); // hash -> {commit, match}
    const claim = (c, match) => { const old = matched.get(c.hash); if (!old || RANK[match] < RANK[old.match]) { matched.set(c.hash, { c, match }); } };
    const byHash = new Map(all.map((c) => [c.hash, c]));

    for (const c of all) {
      const text = `${c.subject}\n${String(c.body).slice(0, 2000)}`;
      if (idRes.some((re) => re.test(text))) { claim(c, 'id'); }
    }

    if (brRes.length) {
      const refs = await reader.run(real, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
      const names = refs.ok ? refs.stdout.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('refs/')) : [];
      const hit = names.filter((r) => !/\/HEAD$/.test(r) && brRes.some((re) => re.test(r.replace(/^refs\/(heads|remotes)\//, '')))).slice(0, LIMITS.branches);
      if (hit.length) {
        let base = '';
        for (const cand of BASE_CANDIDATES) {
          const v = await reader.run(real, ['rev-parse', '--verify', '--quiet', `${cand}^{commit}`]);
          if (v.ok && v.stdout.trim()) { base = cand; break; }
        }
        if (!base) { notes.push(`${label}: branches mention the story but no main branch (main, master or develop) was found to compare with, so they were not used.`); }
        for (const ref of base ? hit : []) {
          const r = await reader.run(real, ['log', '--no-merges', '-n', String(LIMITS.branchCommits), '--format=%H', ref, '--not', base]);
          if (!r.ok) { continue; }
          for (const h of r.stdout.split('\n')) { const c = byHash.get(h.trim()); if (c) { claim(c, 'branch'); } }
        }
      }
    }

    if (repoWindows.length && me) {
      for (const c of all) {
        if (c.email === me && repoWindows.some((w) => c.ts >= w.from && c.ts <= w.to)) { claim(c, 'time'); }
      }
    }
    for (const { c, match } of matched.values()) { found.push({ ri, c, match }); }
  }

  found.sort((x, y) => y.c.ts - x.c.ts || (x.c.hash < y.c.hash ? -1 : 1));
  let dropped = 0;
  if (found.length > max) { dropped = found.length - max; found.length = max; }
  if (dropped) { notes.push(`${dropped} older ${dropped === 1 ? 'commit was' : 'commits were'} left out; only the newest ${max} are shown.`); }

  const commits = [];
  let totalFiles = 0, unreadable = 0, tooBig = 0;
  for (const { ri, c, match } of found) {
    const real = path.resolve(args.repos[ri].path);
    const r = await reader.run(real, ['show', '-z', '--numstat', '--format=', '-M', '--no-ext-diff', '--no-textconv', c.hash]);
    if (!r.ok) {
      if (FAILURE[r.kind] && r.kind !== 'failed') { repoInfo[ri].error = repoInfo[ri].error || FAILURE[r.kind]; }
      else { unreadable++; }
      continue;
    }
    const files = parseNumstat(r.stdout);
    if (totalFiles + files.length > LIMITS.totalFiles) { tooBig++; continue; } // newest first, so the oldest are the ones left out
    totalFiles += files.length;
    commits.push({
      key: `${ri}:${c.hash}`, repo: ri, hash: c.hash, short: c.hash.slice(0, 8), date: new Date(c.ts).toISOString(), subject: cleanText(c.subject, 120), match, files,
      added: files.reduce((n, f) => n + f.added, 0), deleted: files.reduce((n, f) => n + f.deleted, 0),
    });
  }
  if (unreadable) { notes.push(`${unreadable} ${unreadable === 1 ? 'commit' : 'commits'} could not be read (git needed objects this computer does not have, for example in a partial clone, and AI Delivery Insights never fetches). ${unreadable === 1 ? 'It was' : 'They were'} left out.`); }
  if (tooBig) { notes.push(`${tooBig} older ${tooBig === 1 ? 'commit was' : 'commits were'} left out because the commits found touch more than ${LIMITS.totalFiles.toLocaleString('en-US')} files in all.`); }
  const failed = repoInfo.filter((r) => r.error && r.error !== 'Listed twice.');
  for (const r of failed) { notes.push(`${r.label}: ${r.error}`); }
  return { repos: repoInfo, commits, notes };
}

const RANK = { id: 0, branch: 1, time: 2 };

module.exports = { LIMITS, collect, parseNumstat, parseLog, idMatchers, branchMatchers, gitEnv, findGit, SAFE_CONFIG };
