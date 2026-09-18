import cards from "./capability-cards.json";
import { modelFamilyKey } from "../lib/family.js";
export const BAND_KEYS = ["cheap", "mid", "frontier", "unassigned"] as const;
export type BandKey = typeof BAND_KEYS[number];
export const BAND_SUMMARIES = cards.band_vocabulary;
/** Authored relative tiers; never used to rank the production shortlist. */
export function bandForFamily(key: string): BandKey {
  return (cards.families.find(card => card.family_key === modelFamilyKey(key))?.cost_band ?? "unassigned") as BandKey;
}
