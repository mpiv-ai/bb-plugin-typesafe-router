import cardsJson from "../datasets/capability-cards.json";
import snapshot from "../datasets/axis-scores.json";
import type { CapabilityCards } from "../datasets/load.js";
import { modelFamilyKey } from "./family.js";
import type { TaskAxis } from "./task-axis.js";

const cards = cardsJson as CapabilityCards;
const families = new Map(cards.families.map(card => [modelFamilyKey(card.family_key), card]));
const harnesses = new Map(cards.harnesses.map(card => [card.id, card]));
export const familyCard = (id: string) => families.get(modelFamilyKey(id));
export const harnessCard = (id: string) => harnesses.get(id);

/** Scores compare published results within the same benchmark, never raw Elo to %. */
export function axisScore(id: string, axis: TaskAxis): number | null {
  const key = modelFamilyKey(id);
  if (axis === "mixed") {
    const scores = (["coding", "agents", "general", "scientific", "writing"] as const)
      .map(a => axisScore(id, a)).filter((score): score is number => score !== null);
    return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  }
  const scores: number[] = [];
  for (const metric of Object.values(snapshot.metrics)) {
    if (metric.axis !== axis) continue;
    const values: Record<string, number> = metric.values;
    const value = values[key];
    if (value === undefined) continue;
    const peers = Object.values(values);
    const below = peers.filter(peer => peer < value).length;
    const equal = peers.filter(peer => peer === value).length;
    scores.push(100 * (below + (equal - 1) / 2) / Math.max(1, peers.length - 1));
  }
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

export function capabilityProse(card: ReturnType<typeof familyCard> | ReturnType<typeof harnessCard>) {
  return card ? { what: card.what, not_for: card.not_for, tools: card.tools, examples: card.examples } : {
    what: "No authored capability card yet; use the live description and do not infer tools from the name.",
    not_for: ["Work requiring unverified capabilities"], tools: [], examples: [],
  };
}
