'use strict';
/**
 * Story store: validated edits, atomic file persistence and backup import/export.
 * All input is treated as untrusted (it arrives from the webview or from a file the person picked).
 * Everything here is plain Node so it can be tested without VS Code.
 */
const fs = require('fs');
const path = require('path');
const core = require('../media/story-core.js');

const FILE = 'stories.json';
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const KIND = 'copilot-lens-story-tags';

const storePath = (dir) => path.join(dir, FILE);

/** Load the store. A missing file is an empty store. A damaged file is kept aside, never overwritten. */
function load(dir) {
  const file = storePath(dir);
  let text;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_FILE_BYTES) { throw new Error('file too large'); }
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') { return { store: core.emptyStore(), recovered: false }; }
    return { store: core.emptyStore(), recovered: keepAside(file) };
  }
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object') { throw new Error('not an object'); }
    return { store: core.normalizeStore(raw), recovered: false };
  } catch {
    return { store: core.emptyStore(), recovered: keepAside(file) };
  }
}

function keepAside(file) {
  try { fs.copyFileSync(file, `${file}.damaged-${Date.now()}`); return true; } catch { return true; }
}

/**
 * Write to a temporary file in the same folder, then rename over the target.
 * Returns the file's stamp (see stampOf), taken from the temporary file, which the rename keeps unchanged.
 */
function save(dir, store) {
  const file = storePath(dir);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(core.toPlain(store)), 'utf8');
  const stamp = stampFor(fs.statSync(tmp));
  fs.renameSync(tmp, file);
  return stamp;
}

const stampFor = (st) => `${st.mtimeMs}:${st.size}:${st.ino}`;

/** A cheap fingerprint of the saved file ('missing' when there is none). It changes whenever another window saves. */
function stampOf(dir) {
  try { return stampFor(fs.statSync(storePath(dir))); } catch { return 'missing'; }
}

/**
 * Several VS Code windows share one stories file but each keeps its own copy in memory.
 * refresh() re-reads the file only when its stamp is not `prevStamp`:
 *   {changed:false, stamp}                     nothing new, keep what you have
 *   {changed:true, stamp, store}               another window saved (or the file was removed): use this store
 *   {changed:false, stamp, damaged:true}       the file is unreadable: keep what you have and do not touch the file
 */
function refresh(dir, prevStamp) {
  const stamp = stampOf(dir);
  if (stamp === prevStamp) { return { changed: false, stamp }; }
  if (stamp === 'missing') { return { changed: true, stamp, store: core.emptyStore() }; }
  const file = storePath(dir);
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) { throw new Error('file too large'); }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') { throw new Error('not an object'); }
    return { changed: true, stamp, store: core.normalizeStore(raw) };
  } catch {
    return { changed: false, stamp, damaged: true };
  }
}

function countTags(store) {
  let prompts = 0; for (const sid of Object.keys(store.promptTags)) { prompts += Object.keys(store.promptTags[sid]).length; }
  let phases = 0; for (const sid of Object.keys(store.phaseTags)) { phases += Object.keys(store.phaseTags[sid]).length; }
  return { sessions: Object.keys(store.sessionTags).length, prompts, phases };
}

/**
 * Context describing the scanned history, so tags can only point at things that exist.
 * @param {object} data scan result
 */
function contextFor(data) {
  const sessions = new Map();
  for (const s of (data && data.sessions) || []) { sessions.set(s.id, new Set(s.prompts.map(core.promptKey))); }
  return { sessions };
}

const fail = (error) => ({ ok: false, error });

function setSessionTags(store, ctx, ids, storyId, opts) {
  if (!Array.isArray(ids) || !ids.length) { return fail('Choose at least one session.'); }
  if (ids.length > core.LIMITS.bulk) { return fail(`Tag at most ${core.LIMITS.bulk} sessions at a time.`); }
  if (storyId !== null && !(typeof storyId === 'string' && core.hasOwn(store.stories, storyId))) { return fail('That story does not exist.'); }
  let changed = 0, skipped = 0, cleared = 0;
  for (const id of ids) {
    if (typeof id !== 'string' || !ctx.sessions.has(id)) { skipped++; continue; }
    if (opts.onlyUntagged && core.hasOwn(store.sessionTags, id)) { skipped++; continue; }
    if (storyId === null) {
      if (core.hasOwn(store.sessionTags, id)) { delete store.sessionTags[id]; changed++; }
    } else {
      if (!core.hasOwn(store.sessionTags, id) && Object.keys(store.sessionTags).length >= core.LIMITS.sessionTags) { return fail('Too many tagged sessions.'); }
      if (store.sessionTags[id] !== storyId) { changed++; }
      store.sessionTags[id] = storyId;
    }
    if (opts.clearOverrides && core.hasOwn(store.promptTags, id)) { cleared += Object.keys(store.promptTags[id]).length; delete store.promptTags[id]; }
  }
  if (!changed && cleared) { return { ok: true, message: `${cleared} prompt${cleared === 1 ? ' now follows' : 's now follow'} the session.` }; }
  const what = storyId === null ? 'Removed the story from' : `Tagged`;
  return { ok: true, message: `${what} ${changed} session${changed === 1 ? '' : 's'}${storyId === null ? '' : ' as ' + storyId}${skipped ? ` (${skipped} skipped)` : ''}.` };
}

function setPromptTag(store, ctx, sessionId, key, value) {
  if (typeof sessionId !== 'string' || !ctx.sessions.has(sessionId)) { return fail('That session was not found. Rescan and try again.'); }
  if (typeof key !== 'string' || !ctx.sessions.get(sessionId).has(key)) { return fail('That prompt was not found. Rescan and try again.'); }
  if (value === 'inherit') {
    if (core.hasOwn(store.promptTags, sessionId)) {
      delete store.promptTags[sessionId][key];
      if (!Object.keys(store.promptTags[sessionId]).length) { delete store.promptTags[sessionId]; }
    }
    return { ok: true, message: 'Prompt now follows its session.' };
  }
  if (value !== 'none' && !(typeof value === 'string' && core.hasOwn(store.stories, value))) { return fail('That story does not exist.'); }
  if (countTags(store).prompts >= core.LIMITS.promptTags) { return fail('Too many prompt overrides.'); }
  if (!core.hasOwn(store.promptTags, sessionId)) { store.promptTags[sessionId] = core.dict(); }
  store.promptTags[sessionId][key] = value === 'none' ? null : value;
  return { ok: true, message: value === 'none' ? 'Prompt set to no story.' : `Prompt tagged as ${value}.` };
}

const countPhases = (store) => { let n = 0; for (const sid of Object.keys(store.phaseTags)) { n += Object.keys(store.phaseTags[sid]).length; } return n; };

/** Set (or, with 'auto', clear) the lifecycle phase of some prompts in one session. */
function setPhase(store, ctx, sessionId, keys, phase) {
  if (typeof sessionId !== 'string' || !ctx.sessions.has(sessionId)) { return fail('That session was not found. Rescan and try again.'); }
  if (!Array.isArray(keys) || !keys.length) { return fail('Choose at least one prompt.'); }
  if (keys.length > core.LIMITS.bulk) { return fail(`Change at most ${core.LIMITS.bulk} prompts at a time.`); }
  if (phase !== 'auto' && !core.validPhase(phase)) { return fail('That is not a lifecycle phase.'); }
  const known = ctx.sessions.get(sessionId);
  let changed = 0, skipped = 0;
  let total = countPhases(store);
  for (const k of keys) {
    if (typeof k !== 'string' || !known.has(k)) { skipped++; continue; }
    if (phase === 'auto') {
      if (core.hasOwn(store.phaseTags, sessionId) && core.hasOwn(store.phaseTags[sessionId], k)) { delete store.phaseTags[sessionId][k]; changed++; total--; }
      continue;
    }
    const had = core.hasOwn(store.phaseTags, sessionId) && core.hasOwn(store.phaseTags[sessionId], k);
    if (!had && total >= core.LIMITS.phaseTags) { return fail('Too many prompts have a phase set by hand.'); }
    if (!core.hasOwn(store.phaseTags, sessionId)) { store.phaseTags[sessionId] = core.dict(); }
    if (store.phaseTags[sessionId][k] !== phase) { changed++; }
    if (!had) { total++; }
    store.phaseTags[sessionId][k] = phase;
  }
  if (core.hasOwn(store.phaseTags, sessionId) && !Object.keys(store.phaseTags[sessionId]).length) { delete store.phaseTags[sessionId]; }
  const n = `${changed} prompt${changed === 1 ? '' : 's'}`;
  const tail = skipped ? ` (${skipped} skipped)` : '';
  return { ok: true, message: phase === 'auto' ? `${n} now use${changed === 1 ? 's' : ''} the automatic phase${tail}.` : `Set the phase to ${core.phaseLabel(phase)} for ${n}${tail}.` };
}

/**
 * Apply one edit. Returns {ok:true, store, message} with a NEW store, or {ok:false, error}.
 * The input store is never modified.
 * ops the page may send: saveStory, deleteStory, tagSessions, tagPrompt, tagPhase, saveEffort, clearEffort
 * ops only the extension may send: import (a backup), setEffortEstimate, adoRecord, adoImport
 */
function applyOp(store, op, ctx, now) {
  if (!op || typeof op !== 'object' || typeof op.type !== 'string') { return fail('Unknown request.'); }
  const next = core.cloneStore(store);
  const t = Number.isFinite(now) ? now : Date.now();
  let res;

  switch (op.type) {
    case 'saveStory': {
      if (op.mode !== 'new' && op.mode !== 'edit') { return fail('Unknown request.'); }
      const n = core.normalizeStory(op.story);
      if (!n.ok) { return n; }
      const exists = core.hasOwn(next.stories, n.story.id);
      if (op.mode === 'new' && exists) { return fail(`A story with ID ${n.story.id} already exists.`); }
      if (op.mode === 'edit' && !exists) { return fail('That story no longer exists.'); }
      if (!exists && Object.keys(next.stories).length >= core.LIMITS.stories) { return fail('Too many stories.'); }
      n.story.created = exists ? next.stories[n.story.id].created : t;
      n.story.updated = t;
      next.stories[n.story.id] = n.story;
      res = { ok: true, message: exists ? `Saved ${n.story.id}.` : `Created ${n.story.id}.` };
      const a = op.apply;
      if (a && typeof a === 'object') {
        const r2 = a.kind === 'sessions' ? setSessionTags(next, ctx, a.ids, n.story.id, { onlyUntagged: !!a.onlyUntagged, clearOverrides: !!a.clearOverrides })
          : a.kind === 'prompt' ? setPromptTag(next, ctx, a.sessionId, a.key, n.story.id)
            : fail('Unknown request.');
        if (!r2.ok) { return r2; }
        res = { ok: true, message: `${res.message} ${r2.message}` };
      }
      break;
    }
    case 'deleteStory': {
      if (typeof op.id !== 'string' || !core.hasOwn(next.stories, op.id)) { return fail('That story no longer exists.'); }
      let sessions = 0, prompts = 0;
      delete next.stories[op.id];
      delete next.efforts[op.id]; delete next.ado[op.id];
      for (const sid of Object.keys(next.sessionTags)) { if (next.sessionTags[sid] === op.id) { delete next.sessionTags[sid]; sessions++; } }
      for (const sid of Object.keys(next.promptTags)) {
        for (const k of Object.keys(next.promptTags[sid])) { if (next.promptTags[sid][k] === op.id) { delete next.promptTags[sid][k]; prompts++; } }
        if (!Object.keys(next.promptTags[sid]).length) { delete next.promptTags[sid]; }
      }
      res = { ok: true, message: `Deleted ${op.id} and removed it from ${sessions} session${sessions === 1 ? '' : 's'} and ${prompts} prompt${prompts === 1 ? '' : 's'}.` };
      break;
    }
    case 'tagSessions':
      res = setSessionTags(next, ctx, op.ids, op.storyId, { onlyUntagged: !!op.onlyUntagged, clearOverrides: !!op.clearOverrides });
      break;
    case 'tagPrompt':
      res = setPromptTag(next, ctx, op.sessionId, op.key, op.value);
      break;
    case 'tagPhase':
      res = setPhase(next, ctx, op.sessionId, op.keys, op.phase);
      break;
    case 'saveEffort': {
      // From the page: a number of hours someone typed. (An estimate is only ever stored by the extension itself.)
      if (typeof op.storyId !== 'string' || !core.hasOwn(next.stories, op.storyId)) { return fail('That story does not exist.'); }
      const r = core.normalizeEffort({ hours: op.hours, source: 'manual', note: op.note, setAt: t });
      if (!r.ok) { return r; }
      if (!core.hasOwn(next.efforts, op.storyId) && Object.keys(next.efforts).length >= core.LIMITS.efforts) { return fail('Too many stories have an effort.'); }
      next.efforts[op.storyId] = r.effort;
      res = { ok: true, message: `Saved ${r.effort.hours} hours as the traditional effort for ${op.storyId}.` };
      break;
    }
    case 'clearEffort': {
      if (typeof op.storyId !== 'string' || !core.hasOwn(next.stories, op.storyId)) { return fail('That story does not exist.'); }
      delete next.efforts[op.storyId];
      res = { ok: true, message: `Removed the traditional effort from ${op.storyId}.` };
      break;
    }
    case 'setEffortEstimate': {
      // Extension only (not on the page's list): the result of the estimate, worked out from the story and its commits.
      if (typeof op.storyId !== 'string' || !core.hasOwn(next.stories, op.storyId)) { return fail('That story does not exist.'); }
      const r = core.normalizeEffort({ ...(op.effort || {}), source: 'estimated', setAt: t });
      if (!r.ok) { return r; }
      if (!core.hasOwn(next.efforts, op.storyId) && Object.keys(next.efforts).length >= core.LIMITS.efforts) { return fail('Too many stories have an effort.'); }
      next.efforts[op.storyId] = r.effort;
      res = { ok: true, message: `Estimated ${r.effort.hours} hours without AI for ${op.storyId}.` };
      break;
    }
    case 'adoRecord': {
      // Extension only: remember what Azure DevOps said about a story, or what was last synced.
      if (typeof op.storyId !== 'string' || !core.hasOwn(next.stories, op.storyId)) { return fail('That story does not exist.'); }
      const merged = core.normalizeAdoLink({ ...(core.hasOwn(next.ado, op.storyId) ? next.ado[op.storyId] : {}), ...(op.link || {}) });
      if (!core.hasOwn(next.ado, op.storyId) && Object.keys(next.ado).length >= core.LIMITS.ado) { return fail('Too many stories are linked.'); }
      if (merged) { next.ado[op.storyId] = merged; } else { delete next.ado[op.storyId]; }
      res = { ok: true, message: 'Saved.' };
      break;
    }
    case 'adoImport': {
      // Extension only: stories chosen from the backlog. Skips any story whose ID or Azure DevOps number is already here.
      if (!Array.isArray(op.items) || !op.items.length) { return fail('Choose at least one story to import.'); }
      if (op.items.length > 200) { return fail('Import at most 200 stories at a time.'); }
      const have = new Set(Object.values(next.stories).map((x) => core.adoIdOf(x)).filter((x) => x != null));
      let added = 0, skipped = 0;
      for (const it of op.items) {
        const pts = it && typeof it.points === 'number' && it.points > 0 && it.points <= core.LIMITS.points ? it.points : null; // 0 or missing points mean "not estimated"
        const n = core.normalizeStory({ id: it && it.id, title: it && it.title, points: pts, group: it && it.group, adoId: it && it.id, created: t, updated: t });
        if (!n.ok) { skipped++; continue; }
        if (core.hasOwn(next.stories, n.story.id) || have.has(n.story.adoId)) { skipped++; continue; }
        if (Object.keys(next.stories).length >= core.LIMITS.stories) { return fail('Too many stories.'); }
        next.stories[n.story.id] = n.story; have.add(n.story.adoId); added++;
        const link = core.normalizeAdoLink({ org: op.org, adoId: n.story.adoId, project: it.project, type: it.type, state: it.state, iteration: it.iteration, fetchedAt: t });
        if (link && Object.keys(next.ado).length < core.LIMITS.ado) { next.ado[n.story.id] = link; }
      }
      res = { ok: true, message: `Imported ${added} stor${added === 1 ? 'y' : 'ies'} from Azure DevOps${skipped ? ` (${skipped} already here or not valid)` : ''}.` };
      break;
    }
    case 'import': {
      const incoming = core.normalizeStore(op.data);
      const replace = op.mode === 'replace';
      const base = replace ? core.emptyStore() : next;
      let added = 0, kept = 0;
      for (const id of Object.keys(incoming.stories)) {
        if (core.hasOwn(base.stories, id)) { kept++; continue; }
        if (Object.keys(base.stories).length >= core.LIMITS.stories) { break; }
        base.stories[id] = incoming.stories[id]; added++;
      }
      let tags = 0;
      for (const sid of Object.keys(incoming.sessionTags)) {
        const v = incoming.sessionTags[sid];
        if (!core.hasOwn(base.stories, v) || (!replace && core.hasOwn(base.sessionTags, sid))) { continue; }
        base.sessionTags[sid] = v; tags++;
      }
      for (const sid of Object.keys(incoming.promptTags)) {
        for (const k of Object.keys(incoming.promptTags[sid])) {
          const v = incoming.promptTags[sid][k];
          if (v !== null && !core.hasOwn(base.stories, v)) { continue; }
          if (!replace && core.hasOwn(base.promptTags, sid) && core.hasOwn(base.promptTags[sid], k)) { continue; }
          if (!core.hasOwn(base.promptTags, sid)) { base.promptTags[sid] = core.dict(); }
          base.promptTags[sid][k] = v; tags++;
        }
      }
      for (const sid of Object.keys(incoming.phaseTags)) {
        for (const k of Object.keys(incoming.phaseTags[sid])) {
          if (!replace && core.hasOwn(base.phaseTags, sid) && core.hasOwn(base.phaseTags[sid], k)) { continue; }
          if (!core.hasOwn(base.phaseTags, sid)) { base.phaseTags[sid] = core.dict(); }
          base.phaseTags[sid][k] = incoming.phaseTags[sid][k]; tags++;
        }
      }
      // Traditional effort travels with a backup. What this machine knows about Azure DevOps (tasks, synced sessions) does not.
      for (const id of Object.keys(incoming.efforts)) {
        if (!core.hasOwn(base.stories, id) || (!replace && core.hasOwn(base.efforts, id))) { continue; }
        base.efforts[id] = incoming.efforts[id]; tags++;
      }
      res = { ok: true, message: `${replace ? 'Replaced everything with' : 'Imported'} ${added} stor${added === 1 ? 'y' : 'ies'} and ${tags} tag${tags === 1 ? '' : 's'}${kept ? ` (${kept} existing stor${kept === 1 ? 'y' : 'ies'} kept)` : ''}.`, replaced: base };
      break;
    }
    default: return fail('Unknown request.');
  }
  if (!res.ok) { return res; }
  const finalStore = res.replaced || next;
  return { ok: true, store: finalStore, message: res.message };
}

/**
 * Text for the backup file. Contains story details, tags and effort only: no prompt text, no paths.
 * What this machine knows about Azure DevOps (the tracking task, which sessions were synced) is per machine and is left out.
 */
function exportText(store) {
  return JSON.stringify({ kind: KIND, ...core.toPlain(store), ado: {}, exportedAt: new Date().toISOString() }, null, 2);
}

/** Parse a backup file's text. Returns {ok, data} or {ok:false, error}. */
function parseImport(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) { return fail('That file is too large to be an AI Delivery Insights backup.'); }
  let raw;
  try { raw = JSON.parse(text); } catch { return fail('That file is not valid JSON.'); }
  if (!raw || typeof raw !== 'object' || raw.kind !== KIND || raw.version !== 1) { return fail('That file is not an AI Delivery Insights story backup.'); }
  return { ok: true, data: raw };
}

/** Read and validate a backup file, checking its size before reading it. */
function readImportFile(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_IMPORT_BYTES) { return fail('That file is too large to be an AI Delivery Insights backup.'); }
    return parseImport(fs.readFileSync(file, 'utf8'));
  } catch { return fail('That file could not be read.'); }
}

module.exports = { FILE, KIND, load, save, stampOf, refresh, keepAside, applyOp, exportText, parseImport, readImportFile, contextFor, countTags, storePath };
