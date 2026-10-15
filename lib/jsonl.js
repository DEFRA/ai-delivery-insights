'use strict';
const fs = require('fs');
const readline = require('readline');

/** Stream a text file line by line (handles multi-MB lines). */
async function* readLines(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (line) { yield line; }
    }
  } finally {
    rl.close();
  }
}

/**
 * A path in a mutation log comes from a file on disk (a chat session), so it is untrusted. These keys reach an object's prototype,
 * and writing or deleting through them would change every object in the extension host, so a path that names one is ignored.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const safePath = (keys) => Array.isArray(keys) && keys.every((k) => (typeof k === 'string' || (typeof k === 'number' && Number.isFinite(k))) && !UNSAFE_KEYS.has(String(k)));

function getAt(root, keys) {
  let cur = root;
  for (const k of keys) {
    if (cur == null) { return undefined; }
    cur = cur[k];
  }
  return cur;
}

function setAt(root, keys, value) {
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] == null || typeof cur[k] !== 'object') {
      cur[k] = typeof keys[i + 1] === 'number' ? [] : {};
    }
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function deleteAt(root, keys) {
  const parent = getAt(root, keys.slice(0, -1));
  if (parent == null) { return; }
  const last = keys[keys.length - 1];
  if (Array.isArray(parent) && typeof last === 'number') { parent.splice(last, 1); }
  else { delete parent[last]; }
}

/**
 * VS Code (1.109+) persists chat sessions as an append-only mutation log:
 *   kind 0 = initial full state   { kind:0, v: state }
 *   kind 1 = set a value          { kind:1, k: path[], v: value }
 *   kind 2 = push / splice array  { kind:2, k: path[], v: items[], i?: startIndex }
 *   kind 3 = delete               { kind:3, k: path[] }
 * Replaying every line yields the same object the legacy .json format stored.
 */
async function replayMutationLog(lines) {
  let state = null;
  for await (const line of lines) {
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (!m || typeof m !== 'object') { continue; }
    switch (m.kind) {
      case 0:
        state = m.v;
        break;
      case 1:
        // VS Code rotates old lines out of a long-running log, so the kind:0 snapshot this log started from can be gone;
        // starting from {} still lets every kind:1/2 operation below rebuild as much of the session as the remaining lines carry.
        if (state == null) { state = {}; }
        if (!m.k || (Array.isArray(m.k) && m.k.length === 0)) { state = m.v; } else if (safePath(m.k)) { setAt(state, m.k, m.v); }
        break;
      case 2: {
        if (m.k && !safePath(m.k)) { break; }
        if (state == null) { state = {}; }
        const items = Array.isArray(m.v) ? m.v : [];
        let arr = getAt(state, m.k || []);
        if (!Array.isArray(arr)) { setAt(state, m.k, (arr = [])); }
        if (typeof m.i === 'number') { arr.length = Math.min(arr.length, m.i); }
        for (const it of items) { arr.push(it); }
        break;
      }
      case 3:
        if (state != null && safePath(m.k) && m.k.length) { deleteAt(state, m.k); }
        break;
      default:
        break;
    }
  }
  return state;
}

module.exports = { readLines, replayMutationLog };
