'use strict';

/**
 * GitHub AI Credits: 1 credit = $0.01. Copilot's debug logs report an exact
 * per-call cost (copilotUsageNanoAiu; 1 nanoAIU = 1e-11 USD) which this
 * extension always prefers. The rates below are ONLY a fallback for calls that
 * have token counts but no billed cost, or for prompts with no usage data at all.
 * They are approximate USD per 1M tokens, so edit them via the
 * `aiDeliveryInsights.pricing` setting if you want tighter estimates.
 */
const NANO_PER_CREDIT = 1e9;

const DEFAULT_RATES = {
  // Models GitHub documents as not consuming credits (utility models)
  'gpt-4o-mini': { input: 0, cachedInput: 0, output: 0 },
  'gpt-4o': { input: 0, cachedInput: 0, output: 0 },
  'gpt-4.1': { input: 0, cachedInput: 0, output: 0 },
  'gpt-5.4-nano': { input: 0, cachedInput: 0, output: 0 },
  // Approximate list prices
  'claude-opus': { input: 5, cachedInput: 0.5, output: 25 },
  'claude-sonnet': { input: 3, cachedInput: 0.3, output: 15 },
  'claude-haiku': { input: 1, cachedInput: 0.1, output: 5 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gemini': { input: 1.25, cachedInput: 0.31, output: 10 },
  'o3': { input: 2, cachedInput: 0.5, output: 8 },
  'o4-mini': { input: 1.1, cachedInput: 0.275, output: 4.4 },
};
const FALLBACK_RATE = { input: 3, cachedInput: 0.3, output: 15 };

/** Rough system prompt + tool schema overhead Copilot sends with each request. */
const BASE_CONTEXT_TOKENS = 2500;

function normModel(id) {
  if (!id) { return ''; }
  return String(id).replace(/^copilot\//i, '').trim();
}

function rateFor(model, overrides) {
  const m = normModel(model).toLowerCase().replace(/\s+/g, '-');
  // Overrides come from a settings file (which a repository could once write): keep only entries that are rate tables, so a null,
  // a number or a "__proto__" key cannot break pricing for every session.
  const table = Object.assign({}, DEFAULT_RATES);
  for (const [k, v] of Object.entries(overrides && typeof overrides === 'object' ? overrides : {})) {
    if (k !== '__proto__' && v && typeof v === 'object' && !Array.isArray(v)) { table[k] = v; }
  }
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (m.includes(k.toLowerCase())) {
      const r = table[k];
      const rate = (x) => { const n = Number(x); return Number.isFinite(n) && n >= 0 && n <= 10000 ? n : 0; };   // dollars per million tokens: never negative or infinite
      return {
        input: rate(r.input),
        cachedInput: r.cachedInput != null ? rate(r.cachedInput) : rate(r.input) * 0.1,
        output: rate(r.output),
      };
    }
  }
  return FALLBACK_RATE;
}

/** Credits for a call, given FRESH (uncached) input, cached input and output tokens. */
function creditsFromTokens(model, freshIn, cachedIn, out, overrides) {
  const r = rateFor(model, overrides);
  const usd = (freshIn * r.input + cachedIn * r.cachedInput + out * r.output) / 1e6;
  return usd * 100;
}

function estimateTokens(chars) {
  return Math.round((chars || 0) / 4);
}

module.exports = { NANO_PER_CREDIT, BASE_CONTEXT_TOKENS, normModel, rateFor, creditsFromTokens, estimateTokens };
