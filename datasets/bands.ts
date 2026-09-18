// The cost-band vocabulary the capability cards are written against.
//
// Jev has no model catalog, so it cannot know that `gemini-3.8-flash` is cheap
// and `claude-opus-5` is not. A band is the coarsest useful thing to tell it:
// three buckets, borrowed verbatim from the Eve router prototype so the two
// experiments score against the same words.
//
// The band for a family is *derived*, never hand-typed into the dataset. The
// derivation below is the plugin's own PREFERENCE_RULES name heuristics
// re-read as a price signal: the names `catalog.ts` weights up are the ones we
// call frontier, the names it weights down to "keep one cheap option" are the
// ones we call cheap. That makes the membership table checkable (see
// `capability-cards.test.ts`) instead of a list of opinions.
//
// A family whose name matches nothing is `unassigned`. We do not guess: an
// invented band would be indistinguishable from a measured one in the replay
// report, which is the only number this dataset exists to produce.

export const BAND_KEYS = ["cheap", "mid", "frontier", "unassigned"] as const;

export type BandKey = (typeof BAND_KEYS)[number];

/** The band vocabulary as a Choice question would phrase it. */
export const BAND_SUMMARIES: Readonly<Record<BandKey, string>> = {
  cheap: "Fast, low-cost model for lookups, rewrites, and single-step asks.",
  mid: "Balanced model for multi-step work, light research, and file edits.",
  frontier:
    "Highest-capability model for ambiguous, high-stakes, or long-horizon work.",
  unassigned:
    "No band: this family's name matches no pricing heuristic we can defend.",
};

/**
 * Name patterns, most expensive first. Precedence is frontier > mid > cheap so
 * a hybrid name like `claude-opus-4-5-mini` would read as frontier rather than
 * silently becoming cheap; no family in the shipped table matches two rules.
 */
const BAND_RULES: readonly { band: Exclude<BandKey, "unassigned">; pattern: RegExp }[] = [
  { band: "frontier", pattern: /opus|fable|gpt-6/i },
  { band: "mid", pattern: /sonnet|composer|grok-4/i },
  { band: "cheap", pattern: /haiku|\bmini\b|flash|spark/i },
];

/**
 * The band for a `modelFamilyKey` output. Takes the family key, not a raw
 * model id, so `cursor/claude-4.6-opus-high` and `anthropic:claude-opus-4-6`
 * cannot land in different bands.
 */
export function bandForFamily(familyKey: string): BandKey {
  for (const rule of BAND_RULES) {
    if (rule.pattern.test(familyKey)) return rule.band;
  }
  return "unassigned";
}
