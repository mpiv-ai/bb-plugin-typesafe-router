import { describe, expect, it } from "vitest";
import { BAND_KEYS } from "./bands.js";
import { loadCards, loadEvalCases, loadSnapshot } from "./load.js";

const cards = loadCards();
const cases = loadEvalCases();
const snapshot = loadSnapshot();

const harnessIds = new Set(cards.harnesses.map((h) => h.id));
const familyByKey = new Map(cards.families.map((f) => [f.family_key, f]));

describe("eval case schema", () => {
  it("has enough cases to say anything about a difference in scores", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });

  it("gives every case a unique id", () => {
    const ids = cases.map((c) => c.id);
    const seen = new Set<string>();
    const duplicates = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    expect(duplicates).toEqual([]);
    expect(seen.size).toBe(cases.length);
  });

  it("uses ids shaped like a category prefix and a number", () => {
    for (const evalCase of cases) {
      expect(evalCase.id, evalCase.id).toMatch(/^[a-z]+-\d{3}$/);
    }
  });

  it("gives every case a message and a note explaining the gold answer", () => {
    for (const evalCase of cases) {
      expect(evalCase.message.trim().length, evalCase.id).toBeGreaterThan(0);
      // Without a stated reason a gold label is unfalsifiable, and a disagreeing
      // replay result cannot be triaged into "model was wrong" vs "gold was wrong".
      expect(evalCase.notes.trim().length, evalCase.id).toBeGreaterThan(20);
    }
  });
});

describe("gold labels resolve against the cards", () => {
  it("names a harness that has a card", () => {
    for (const evalCase of cases) {
      expect(harnessIds.has(evalCase.gold_harness), `${evalCase.id} -> ${evalCase.gold_harness}`)
        .toBe(true);
    }
  });

  it("names a band in the vocabulary", () => {
    for (const evalCase of cases) {
      expect(BAND_KEYS, evalCase.id).toContain(evalCase.gold_band);
    }
  });

  it("names a family that exists, matches the gold band, and is reachable from the gold harness", () => {
    for (const evalCase of cases) {
      if (evalCase.gold_family === undefined) continue;
      const family = familyByKey.get(evalCase.gold_family);
      expect(family, `${evalCase.id} -> ${evalCase.gold_family}`).toBeDefined();
      expect(family!.cost_band, `${evalCase.id} band`).toBe(evalCase.gold_band);
      expect(family!.reachable_from, `${evalCase.id} reachability`).toContain(
        evalCase.gold_harness,
      );
    }
  });

  it("omits gold_family only with a written reason", () => {
    // A missing gold_family is a claim about the catalog, not an oversight, so
    // the case has to say which claim it is making.
    for (const evalCase of cases) {
      if (evalCase.gold_family !== undefined) {
        expect(evalCase.no_gold_family, evalCase.id).toBeUndefined();
        continue;
      }
      expect(evalCase.no_gold_family?.trim().length ?? 0, evalCase.id).toBeGreaterThan(20);
    }
  });

  it("backs each of those reasons with the snapshot", () => {
    // trap-005: Cursor offers nothing at all on the captured machine.
    const cursorFamilies = cards.families.filter((f) => f.reachable_from.includes("acp-cursor"));
    expect(cursorFamilies.map((f) => f.family_key)).toEqual([]);

    // trap-007: the user asked for Qwen, and no Qwen family is offerable.
    const qwen = cards.families.filter((f) => /qwen/i.test(f.family_key));
    expect(qwen.map((f) => f.family_key)).toEqual([]);
    const shortlisted = snapshot.providers.flatMap((p) => p.shortlist.map((m) => m.familyKey));
    expect(shortlisted.filter((key) => /qwen/i.test(key))).toEqual([]);
  });
});

describe("coverage", () => {
  const byCategory = new Map<string, number>();
  for (const evalCase of cases) {
    byCategory.set(evalCase.category, (byCategory.get(evalCase.category) ?? 0) + 1);
  }

  it("covers every shape the brief asked for", () => {
    for (const category of ["trivial", "implementation", "architecture", "research", "harness-trap"]) {
      expect(byCategory.get(category) ?? 0, category).toBeGreaterThan(0);
    }
  });

  it("carries at least five harness traps", () => {
    expect(byCategory.get("harness-trap") ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("points its harness traps at more than one harness", () => {
    const traps = cases.filter((c) => c.category === "harness-trap");
    const targets = new Set(traps.map((c) => c.gold_harness));
    // A trap set that all resolves to one harness measures nothing.
    expect(targets.size).toBeGreaterThanOrEqual(5);
  });

  it("exercises every harness that has a card", () => {
    const used = new Set(cases.map((c) => c.gold_harness));
    expect([...harnessIds].filter((id) => !used.has(id))).toEqual([]);
  });

  it("exercises every band the vocabulary defines", () => {
    const used = new Set(cases.map((c) => c.gold_band));
    expect([...BAND_KEYS].filter((band) => !used.has(band))).toEqual([]);
  });
});
