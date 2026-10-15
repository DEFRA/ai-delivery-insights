'use strict';
/**
 * Small text helpers for anything that comes from outside the extension (Azure DevOps replies, a work item's text).
 * Pure functions: no files, no network. Cleaning functions return plain text; escapeHtml is the only one that makes text safe to put inside markup.
 */

// Invisible characters that reorder or hide text (bidirectional controls, zero-width no-break space).
const INVISIBLE_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/g;

/** One line of plain text: control and invisible characters removed, spaces collapsed, cut to `max` characters. */
function cleanText(s, max) {
  return String(s == null ? '' : s).replace(INVISIBLE_RE, '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const NAMED = { nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

/** Decode the HTML entities a rich-text editor produces. `&amp;` is handled in the same pass so `&amp;lt;` stays `&lt;`. */
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, body) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(n) && n >= 32 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) && n !== 127 ? String.fromCodePoint(n) : ' ';
    }
    const k = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED, k) ? NAMED[k] : whole;
  });
}

/** Escape text for putting inside HTML that this extension writes. */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Escape text that goes between tags (not inside an attribute): only the characters that start markup. */
function escapeText(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** ASCII lower-casing that never changes the length of the text (toLowerCase can), so positions line up with the original. */
const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const BLOCK_END_RE = /^\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?$/i;

/**
 * Drop tags and scripts from HTML, keeping line breaks where blocks end. Text from Azure DevOps is untrusted and can be
 * megabytes of nothing but "<", so this is one pass with indexOf and no regular expression that can backtrack: the cost is
 * linear in the length of the text whatever it contains. An unclosed "<" is text, as a browser would treat it.
 */
function stripTags(html) {
  const s = String(html == null ? '' : html);
  const lower = asciiLower(s);
  const n = s.length;
  const parts = [];
  let i = 0;
  let gt = -2;                 // position of the next ">" at or after the current "<" (Infinity: there is none)
  const noClose = { script: false, style: false };
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt === -1) { parts.push(s.slice(i)); break; }
    if (lt > i) { parts.push(s.slice(i, lt)); }
    if (gt < lt) { const g = s.indexOf('>', lt); gt = g === -1 ? Infinity : g; }
    if (gt === Infinity) { parts.push(s.slice(lt)); break; }   // no ">" anywhere after this: everything left is text
    let skipped = false;
    for (const name of ['script', 'style']) {
      if (!noClose[name] && lower.startsWith('<' + name, lt)) {
        const close = lower.indexOf('</' + name + '>', lt + name.length + 1);
        if (close === -1) { noClose[name] = true; } else { parts.push(' '); i = close + name.length + 3; skipped = true; }
        break;
      }
    }
    if (skipped) { continue; }
    const body = s.slice(lt + 1, gt);
    if (body.length <= 24 && BLOCK_END_RE.test(body)) { parts.push('\n'); }
    i = gt + 1;
  }
  return decodeEntities(parts.join(''));
}

module.exports = { cleanText, decodeEntities, escapeHtml, escapeText, stripTags };
