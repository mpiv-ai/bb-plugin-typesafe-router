import { describe, expect, it } from "vitest";
import { isHarnessAllowed, MAX_MODELS_PER_HARNESS } from "./catalog.js";
import {
  emptyCatalogDetail,
  formatHarnessIds,
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

describe("readPreferences", () => {
  it("turns stored settings into the decisions routing makes", () => {
    const preferences = readPreferences(
      stored({
        includeHarnesses: "codex\n# keep omp off for now",
        excludeHarnesses: "acp-omp",
      }),
    );
    expect(preferences.enabled).toBe(true);
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
