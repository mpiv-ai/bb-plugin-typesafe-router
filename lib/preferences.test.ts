import { describe, expect, it } from "vitest";
import { isHarnessAllowed, MAX_MODELS_PER_HARNESS } from "./catalog.js";
import {
  clampMaxModels,
  emptyCatalogDetail,
  formatHarnessIds,
  MAX_MODELS_CEILING,
  MIN_MODELS_PER_HARNESS,
  parseCurationMode,
  parseHarnessIds,
  preferenceSignature,
  readPreferences,
  withHarnessAllowed,
  type StoredPreferences,
} from "./preferences.js";
import { STUB_PROVIDER_ID } from "./provider.js";

function stored(overrides: Partial<StoredPreferences> = {}): StoredPreferences {
  return {
    enabled: true,
    maxModelsPerHarness: MAX_MODELS_PER_HARNESS,
    curationMode: "weighted",
    includeHarnesses: "",
    excludeHarnesses: "",
    ...overrides,
  };
}

function filterOf(include: string, exclude: string) {
  return { include: parseHarnessIds(include), exclude: parseHarnessIds(exclude) };
}

describe("parseHarnessIds", () => {
  it("reads one id per line", () => {
    expect([...parseHarnessIds("codex\nacp-omp")]).toEqual(["codex", "acp-omp"]);
  });

  it("ignores blank lines, whitespace, and carriage returns", () => {
    expect([...parseHarnessIds("  codex  \r\n\n\r\n  acp-omp\n  ")]).toEqual([
      "codex",
      "acp-omp",
    ]);
  });

  it("drops whole-line and trailing comments", () => {
    const ids = parseHarnessIds("# everything below is off\ncodex # too slow today\n#acp-omp");
    expect([...ids]).toEqual(["codex"]);
  });

  it("lowercases, so a hand-typed id still matches the provider", () => {
    expect(parseHarnessIds("Codex\nACP-OMP").has("codex")).toBe(true);
    expect(parseHarnessIds("Codex\nACP-OMP").has("acp-omp")).toBe(true);
  });

  it("collapses duplicates and treats a missing value as empty", () => {
    expect([...parseHarnessIds("codex\ncodex")]).toEqual(["codex"]);
    expect(parseHarnessIds(undefined).size).toBe(0);
    expect(parseHarnessIds(null).size).toBe(0);
    expect(parseHarnessIds("").size).toBe(0);
  });
});

describe("formatHarnessIds", () => {
  it("writes a sorted one-per-line list", () => {
    expect(formatHarnessIds(new Set(["pi", "codex", "acp-omp"]))).toBe(
      "acp-omp\ncodex\npi",
    );
    expect(formatHarnessIds([])).toBe("");
  });

  it("round-trips through the parser", () => {
    const ids = parseHarnessIds("codex\nacp-omp");
    expect(parseHarnessIds(formatHarnessIds(ids))).toEqual(ids);
  });
});

describe("parseCurationMode", () => {
  it("accepts the two known modes", () => {
    expect(parseCurationMode("weighted")).toBe("weighted");
    expect(parseCurationMode("catalog_order")).toBe("catalog_order");
  });

  it("falls back to weighted for anything else", () => {
    expect(parseCurationMode("nonsense")).toBe("weighted");
    expect(parseCurationMode(undefined)).toBe("weighted");
    expect(parseCurationMode(7)).toBe("weighted");
  });
});

describe("clampMaxModels", () => {
  it("holds the value inside its bounds", () => {
    expect(clampMaxModels(1)).toBe(MIN_MODELS_PER_HARNESS);
    expect(clampMaxModels(0)).toBe(MIN_MODELS_PER_HARNESS);
    expect(clampMaxModels(-5)).toBe(MIN_MODELS_PER_HARNESS);
    expect(clampMaxModels(99)).toBe(MAX_MODELS_CEILING);
    expect(clampMaxModels(12)).toBe(12);
  });

  it("truncates a fractional value rather than rejecting it", () => {
    expect(clampMaxModels(5.9)).toBe(5);
  });

  it("falls back to the built-in default for a non-number", () => {
    expect(clampMaxModels(undefined)).toBe(MAX_MODELS_PER_HARNESS);
    expect(clampMaxModels("8")).toBe(MAX_MODELS_PER_HARNESS);
    expect(clampMaxModels(Number.NaN)).toBe(MAX_MODELS_PER_HARNESS);
    expect(clampMaxModels(Number.POSITIVE_INFINITY)).toBe(MAX_MODELS_PER_HARNESS);
  });
});

describe("readPreferences", () => {
  it("turns stored settings into the decisions routing makes", () => {
    const preferences = readPreferences(
      stored({
        maxModelsPerHarness: 40,
        curationMode: "catalog_order",
        includeHarnesses: "codex\n# keep omp off for now",
        excludeHarnesses: "acp-omp",
      }),
    );
    expect(preferences.enabled).toBe(true);
    expect(preferences.maxModelsPerHarness).toBe(MAX_MODELS_CEILING);
    expect(preferences.curationMode).toBe("catalog_order");
    expect([...preferences.filter.include]).toEqual(["codex"]);
    expect([...preferences.filter.exclude]).toEqual(["acp-omp"]);
  });
});

describe("withHarnessAllowed", () => {
  it("switching a harness off excludes it", () => {
    const next = withHarnessAllowed(filterOf("", ""), "codex", false);
    expect(next.excludeHarnesses).toBe("codex");
    expect(next.includeHarnesses).toBe("");
    expect(isHarnessAllowed("codex", filterOf(next.includeHarnesses, next.excludeHarnesses))).toBe(
      false,
    );
  });

  it("switching it back on restores exactly what was there", () => {
    const off = withHarnessAllowed(filterOf("", ""), "codex", false);
    const on = withHarnessAllowed(
      filterOf(off.includeHarnesses, off.excludeHarnesses),
      "codex",
      true,
    );
    expect(on).toEqual({ includeHarnesses: "", excludeHarnesses: "" });
  });

  it("names the harness in a narrowing include list, or turning it on would do nothing", () => {
    const next = withHarnessAllowed(filterOf("codex", ""), "pi", true);
    expect(next.includeHarnesses).toBe("codex\npi");
    expect(isHarnessAllowed("pi", filterOf(next.includeHarnesses, next.excludeHarnesses))).toBe(
      true,
    );
  });

  it("leaves nothing routable when the sole included harness is switched off", () => {
    const next = withHarnessAllowed(filterOf("codex", ""), "codex", false);
    const filter = filterOf(next.includeHarnesses, next.excludeHarnesses);
    expect(isHarnessAllowed("codex", filter)).toBe(false);
    expect(isHarnessAllowed("pi", filter)).toBe(false);
    // And it is reversible: the include list was never rewritten.
    const back = withHarnessAllowed(filter, "codex", true);
    expect(isHarnessAllowed("codex", filterOf(back.includeHarnesses, back.excludeHarnesses))).toBe(
      true,
    );
  });

  it("is case-insensitive about the id it is handed", () => {
    const next = withHarnessAllowed(filterOf("", ""), "  Codex  ", false);
    expect(next.excludeHarnesses).toBe("codex");
  });
});

describe("preferenceSignature", () => {
  it("changes when any preference that shapes the catalog changes", () => {
    const base = preferenceSignature(readPreferences(stored()));
    expect(preferenceSignature(readPreferences(stored({ maxModelsPerHarness: 4 })))).not.toBe(
      base,
    );
    expect(
      preferenceSignature(readPreferences(stored({ curationMode: "catalog_order" }))),
    ).not.toBe(base);
    expect(preferenceSignature(readPreferences(stored({ excludeHarnesses: "pi" })))).not.toBe(
      base,
    );
    expect(preferenceSignature(readPreferences(stored({ includeHarnesses: "pi" })))).not.toBe(
      base,
    );
  });

  it("does not change when only the order of a list changes", () => {
    expect(
      preferenceSignature(readPreferences(stored({ excludeHarnesses: "pi\ncodex" }))),
    ).toBe(preferenceSignature(readPreferences(stored({ excludeHarnesses: "codex\npi" }))));
  });

  it("ignores whether routing is enabled, which does not shape the catalog", () => {
    expect(preferenceSignature(readPreferences(stored({ enabled: false })))).toBe(
      preferenceSignature(readPreferences(stored({ enabled: true }))),
    );
  });
});

describe("emptyCatalogDetail", () => {
  it("tells a bare machine apart from one the user filtered to nothing", () => {
    expect(emptyCatalogDetail(0)).toContain("no harness on this machine");
    expect(emptyCatalogDetail(3)).toContain("settings");
  });
});

describe("the stub is beyond the reach of any setting", () => {
  it("cannot be included by naming it", () => {
    expect(isHarnessAllowed(STUB_PROVIDER_ID, filterOf(STUB_PROVIDER_ID, ""))).toBe(false);
  });
});
