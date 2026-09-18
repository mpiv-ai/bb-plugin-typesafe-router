import { describe, expect, it } from "vitest";
import { modelFamilyKey } from "../lib/catalog.js";
import { isRoutableProviderId } from "../lib/provider.js";
import { BAND_KEYS, bandForFamily } from "./bands.js";
import { loadCards, loadSnapshot } from "./load.js";

const cards = loadCards();
const snapshot = loadSnapshot();

/** The harnesses the hub actually reports, minus this plugin's own picker stub. */
const LIVE_HARNESS_IDS = [
  "codex",
  "claude-code",
  "pi",
  "acp-cursor",
  "acp-omp",
  "acp-grok",
  "acp-hermes-agent",
];

function expectProse(value: unknown, what: string): void {
  expect(typeof value, what).toBe("string");
  expect((value as string).trim().length, what).toBeGreaterThan(0);
}

function expectStringList(value: unknown, what: string, min: number, max = Infinity): void {
  expect(Array.isArray(value), what).toBe(true);
  const list = value as unknown[];
  expect(list.length, what).toBeGreaterThanOrEqual(min);
  expect(list.length, what).toBeLessThanOrEqual(max);
  for (const entry of list) expectProse(entry, `${what} entry`);
}

describe("capability card schema", () => {
  it("covers every live harness and nothing else", () => {
    expect(cards.harnesses.map((h) => h.id).sort()).toEqual([...LIVE_HARNESS_IDS].sort());
  });

  it("never offers the picker stub as a routing target", () => {
    for (const harness of cards.harnesses) {
      expect(isRoutableProviderId(harness.id), harness.id).toBe(true);
    }
  });

  it("gives every harness card the structured fields a Choice criterion needs", () => {
    for (const harness of cards.harnesses) {
      expectProse(harness.display_name, `${harness.id}.display_name`);
      expectProse(harness.what, `${harness.id}.what`);
      expectProse(harness.context, `${harness.id}.context`);
      expectStringList(harness.not_for, `${harness.id}.not_for`, 1);
      expectStringList(harness.tools, `${harness.id}.tools`, 1);
      expectStringList(harness.examples, `${harness.id}.examples`, 2, 4);
      // A harness has no price of its own; the model inside it does.
      expect(harness.cost_band, `${harness.id}.cost_band`).toBeNull();
    }
  });

  it("gives every family card the same structured fields", () => {
    for (const family of cards.families) {
      expectProse(family.label, `${family.family_key}.label`);
      expectProse(family.what, `${family.family_key}.what`);
      expectProse(family.context, `${family.family_key}.context`);
      expectStringList(family.not_for, `${family.family_key}.not_for`, 1);
      expectStringList(family.tools, `${family.family_key}.tools`, 1);
      expectStringList(family.examples, `${family.family_key}.examples`, 2, 4);
    }
  });

  it("uses one card per family key", () => {
    const keys = cards.families.map((f) => f.family_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("documents every band the vocabulary defines", () => {
    expect(Object.keys(cards.band_vocabulary).sort()).toEqual([...BAND_KEYS].sort());
  });
});

describe("family membership", () => {
  it("keys every family card by a real modelFamilyKey output", () => {
    // A key that is not a fixed point of modelFamilyKey could never be matched
    // against a live model id at routing time.
    for (const family of cards.families) {
      expect(modelFamilyKey(family.family_key), family.family_key).toBe(family.family_key);
    }
  });

  it("derives every cost_band from the name heuristic rather than asserting one", () => {
    for (const family of cards.families) {
      expect(bandForFamily(family.family_key), family.family_key).toBe(family.cost_band);
    }
  });

  it("marks families the heuristic cannot price as unassigned, not as a guess", () => {
    const unassigned = cards.families.filter((f) => f.cost_band === "unassigned");
    // The GPT-5.x names match no rule; inventing a band for them would be
    // indistinguishable from a measured one in the replay report.
    expect(unassigned.map((f) => f.family_key).sort()).toEqual([
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-sol-900k",
      "gpt-5.6-terra",
    ]);
  });

  it("states reachability that matches the captured catalog exactly", () => {
    for (const family of cards.families) {
      const actual = snapshot.familyIndex[family.family_key] ?? [];
      expect([...family.reachable_from].sort(), family.family_key).toEqual([...actual].sort());
      expect(family.reachable_from.length, `${family.family_key} is unreachable`)
        .toBeGreaterThan(0);
    }
  });

  it("states shortlist survival that matches the captured shortlists exactly", () => {
    const expected = new Map<string, string[]>();
    for (const provider of snapshot.providers) {
      for (const model of provider.shortlist) {
        expected.set(model.familyKey, [...(expected.get(model.familyKey) ?? []), provider.id]);
      }
    }
    for (const family of cards.families) {
      expect([...family.shortlisted_on].sort(), family.family_key).toEqual(
        [...(expected.get(family.family_key) ?? [])].sort(),
      );
    }
  });

  it("writes a card for every family that survives a default 8-cap shortlist", () => {
    const carded = new Set(cards.families.map((f) => f.family_key));
    const survivors = new Set(
      snapshot.providers.flatMap((p) => p.shortlist.map((m) => m.familyKey)),
    );
    expect([...survivors].filter((key) => !carded.has(key))).toEqual([]);
  });

  it("covers all six of Claude Code's models", () => {
    const claudeCode = snapshot.providers.find((p) => p.id === "claude-code");
    expect(claudeCode?.modelCount).toBe(6);
    const carded = new Set(cards.families.map((f) => f.family_key));
    for (const model of claudeCode!.shortlist) {
      expect(carded.has(model.familyKey), model.id).toBe(true);
    }
  });

  it("stays far short of one card per model on the aggregator harnesses", () => {
    const omp = snapshot.providers.find((p) => p.id === "acp-omp")!;
    expect(omp.modelCount).toBeGreaterThan(600);
    // Cards are per family, and only for families routing can actually reach.
    expect(cards.families.length).toBeLessThan(omp.modelCount / 10);
  });
});

describe("catalog snapshot", () => {
  it("records the empty-description problem the cards exist to solve", () => {
    const omp = snapshot.providers.find((p) => p.id === "acp-omp")!;
    expect(omp.emptyDescriptions).toBe(omp.modelCount);
  });

  it("never retains more than the curated cap per harness", () => {
    for (const provider of snapshot.providers) {
      expect(provider.shortlist.length, provider.id).toBeLessThanOrEqual(8);
    }
  });
});
