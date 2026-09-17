// Reading the two datasets from disk with enough typing that the tests and the
// replay script agree on what a card is. Deliberately no validation here: the
// tests are the validation, and a loader that silently repaired a malformed
// card would hide exactly the failure they exist to catch.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BandKey } from "./bands.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface HarnessCard {
  id: string;
  display_name: string;
  what: string;
  not_for: string[];
  tools: string[];
  cost_band: null;
  context: string;
  examples: string[];
}

export interface FamilyCard {
  family_key: string;
  label: string;
  cost_band: BandKey;
  what: string;
  not_for: string[];
  tools: string[];
  context: string;
  examples: string[];
  /** Harnesses that offer at least one model in this family, per the snapshot. */
  reachable_from: string[];
  /** Harnesses whose 8-slot curated shortlist this family actually survives. */
  shortlisted_on: string[];
}

export interface CapabilityCards {
  schema_version: number;
  description: string;
  band_vocabulary: Record<BandKey, string>;
  harnesses: HarnessCard[];
  families: FamilyCard[];
}

export interface EvalCase {
  id: string;
  category: string;
  message: string;
  gold_harness: string;
  gold_band: BandKey;
  gold_family?: string;
  /** Why no family is named. Present exactly when `gold_family` is absent. */
  no_gold_family?: string;
  notes: string;
}

export interface CatalogSnapshot {
  schema_version: number;
  captured: string;
  source: string;
  note: string;
  providers: {
    id: string;
    displayName: string;
    available: boolean;
    modelCount: number;
    familyCount: number;
    emptyDescriptions: number;
    shortlist: { id: string; displayName: string; familyKey: string; isDefault: boolean }[];
  }[];
  familyIndex: Record<string, string[]>;
}

export function loadCards(): CapabilityCards {
  return JSON.parse(readFileSync(join(HERE, "capability-cards.json"), "utf8"));
}

export function loadSnapshot(): CatalogSnapshot {
  return JSON.parse(readFileSync(join(HERE, "catalog-snapshot.json"), "utf8"));
}

export function loadEvalCases(): EvalCase[] {
  const text = readFileSync(join(HERE, "eval-cases.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line) as EvalCase;
      } catch (cause) {
        throw new Error(`eval-cases.jsonl line ${index + 1} is not valid JSON`, { cause });
      }
    });
}
