'use strict';
/**
 * The lifecycle-phase rule, written out by hand from the spec (docs/ai-delivery-insights/ui-spec.md, "Lifecycle phase").
 * Tests compare the product against this file and never against the product's own code, so a change to the
 * rule in media/story-core.js fails the tests until the spec and this file are changed on purpose.
 *
 * Order of precedence: your choice, then the Plan agent, then planning words, then investigating words,
 * then the prompt's work type.
 */
const PLAN = /\b(plan(s|ning|ned)?|roadmap|architect(ure|ural)?|design(s|ing)?|proposal|outline|break(ing)? (it |this |that )?down|approach(es)?|trade-?offs?|strategy|milestones?|acceptance criteria|user stories)\b/i;
const ANALYSIS = /\b(analy[sz](e|es|ing|is)|investigat(e|es|ing|ion)|research|estimate|feasib(le|ility)|impact|root cause|assess(ment)?|compare|comparison|evaluate)\b/i;
const FROM_TAG = { 'Bug fix': 'bugfix', Tests: 'test', Refactor: 'refactor', Docs: 'docs', DevOps: 'release', Review: 'review', Explain: 'analysis', Feature: 'build' };

/** Guessed phase of a scanned prompt. */
function guess(p) {
  if (p.agent === 'Plan' || PLAN.test(p.text || '')) { return 'plan'; }
  if (ANALYSIS.test(p.text || '')) { return 'analysis'; }
  return Object.prototype.hasOwnProperty.call(FROM_TAG, p.tag) ? FROM_TAG[p.tag] : 'other';
}

const ORDER = ['analysis', 'plan', 'build', 'test', 'bugfix', 'review', 'refactor', 'docs', 'release', 'other'];
const LABEL = { analysis: 'Analysis', plan: 'Plan & design', build: 'Build', test: 'Test', bugfix: 'Bug fix', review: 'Review', refactor: 'Refactor', docs: 'Docs', release: 'Release & ops', other: 'Other' };

module.exports = { guess, ORDER, LABEL };
