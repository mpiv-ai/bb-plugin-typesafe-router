import { describe, expect, it } from "vitest";
import {
  buildCatalog,
  curateModels,
  defaultModelFor,
  findHarness,
  isHarnessAllowed,
  modelFamilyKey,
  type CatalogModel,
  type CatalogProvider,
  type HarnessFilter,
} from "./catalog.js";
import { STUB_PROVIDER_ID } from "./provider.js";

function filter(include: string[] = [], exclude: string[] = []): HarnessFilter {
  return { include: new Set(include), exclude: new Set(exclude) };
}

function model(id: string, overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    model: id,
    displayName: id,
    description: "",
    isDefault: false,
    ...overrides,
  };
}

describe("modelFamilyKey", () => {
  it("collapses vendor prefixes, context tags, dates, and effort suffixes", () => {
    expect(modelFamilyKey("cursor/claude-4.6-opus-high")).toBe("claude-opus-4-6");
    expect(modelFamilyKey("cursor/claude-4.6-opus-max")).toBe("claude-opus-4-6");
    expect(modelFamilyKey("claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(modelFamilyKey("anthropic:claude-sonnet-4-5-20250929")).toBe(
      "claude-sonnet-4-5",
    );
  });

  it("keeps genuinely different models apart", () => {
    expect(modelFamilyKey("gpt-5.6-sol")).not.toBe(modelFamilyKey("gpt-5.6-luna"));
  });
});

describe("curateModels", () => {
  it("returns a small catalog untouched and in order", () => {
    const models = [model("a"), model("b", { isDefault: true }), model("c")];
    expect(curateModels(models, 8).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("never exceeds the cap on a large catalog", () => {
    const models = Array.from({ length: 807 }, (_, index) =>
      model(`vendor-${index}/model-${index}`),
    );
    expect(curateModels(models, 8)).toHaveLength(8);
  });

  it("collapses same-family variants to one entry", () => {
    const models = [
      model("cursor/claude-4.6-opus-high"),
      model("cursor/claude-4.6-opus-max"),
      model("cursor/claude-4.6-opus-low"),
      model("cursor/claude-4.6-sonnet-medium"),
    ];
    expect(curateModels(models, 8).map((m) => m.id)).toEqual([
      "cursor/claude-4.6-opus-high",
      "cursor/claude-4.6-sonnet-medium",
    ]);
  });

  it("prefers a capable model over an obviously experimental one", () => {
    const models = [
      ...Array.from({ length: 10 }, (_, index) => model(`filler-${index}`)),
      model("deepinfra/DeepSeek-V4-Flash-Vision-Exp"),
      model("anthropic/claude-opus-5"),
    ];
    const ids = curateModels(models, 3).map((m) => m.id);
    expect(ids).toContain("anthropic/claude-opus-5");
    expect(ids).not.toContain("deepinfra/DeepSeek-V4-Flash-Vision-Exp");
  });

  it("is stable across repeated calls", () => {
    const models = Array.from({ length: 50 }, (_, index) =>
      model(`m-${index}`, { isDefault: index === 30 }),
    );
    expect(curateModels(models, 8)).toEqual(curateModels(models, 8));
  });

  it("returns nothing when the cap is zero", () => {
    expect(curateModels([model("a")], 0)).toEqual([]);
  });
});

describe("buildCatalog", () => {
  const providers: CatalogProvider[] = [
    { id: "codex", displayName: "Codex", available: true },
    { id: "acp-grok", displayName: "Grok Build", available: false },
    { id: "acp-omp", displayName: "omp", available: true },
    { id: "pi", displayName: "Pi", available: true },
  ];

  it("drops unavailable providers and providers with no models", () => {
    const catalog = buildCatalog(
      providers,
      new Map([
        ["codex", [model("gpt-6-astra", { isDefault: true })]],
        ["acp-grok", [model("grok-4.5", { isDefault: true })]],
        ["acp-omp", [model("cursor/claude-4.6-opus-high")]],
        ["pi", []],
      ]),
      { max: 8 },
    );
    expect(catalog.map((harness) => harness.id)).toEqual(["codex", "acp-omp"]);
  });

  it("caps every harness independently", () => {
    const big = Array.from({ length: 466 }, (_, index) => model(`m/${index}`));
    const catalog = buildCatalog(
      [{ id: "acp-opencode", displayName: "opencode", available: true }],
      new Map([["acp-opencode", big]]),
      { max: 8 },
    );
    expect(catalog[0]!.models.length).toBeLessThanOrEqual(8);
  });

  it("preserves provider order from the live catalog", () => {
    const catalog = buildCatalog(
      providers.filter((p) => p.available),
      new Map(providers.map((p) => [p.id, [model(`${p.id}-m`)]])),
      { max: 8 },
    );
    expect(catalog.map((h) => h.id)).toEqual(["codex", "acp-omp", "pi"]);
  });
});

describe("isHarnessAllowed", () => {
  it("allows everything when neither list is set", () => {
    expect(isHarnessAllowed("codex")).toBe(true);
    expect(isHarnessAllowed("codex", filter())).toBe(true);
  });

  it("narrows to the include list once it has an entry", () => {
    expect(isHarnessAllowed("codex", filter(["codex"]))).toBe(true);
    expect(isHarnessAllowed("pi", filter(["codex"]))).toBe(false);
  });

  it("applies exclude after include, so exclude wins", () => {
    expect(isHarnessAllowed("codex", filter(["codex"], ["codex"]))).toBe(false);
    expect(isHarnessAllowed("codex", filter([], ["codex"]))).toBe(false);
  });

  it("compares ids case-insensitively", () => {
    expect(isHarnessAllowed("Codex", filter([], ["codex"]))).toBe(false);
    expect(isHarnessAllowed("CODEX", filter(["codex"]))).toBe(true);
  });

  it("never allows the picker stub, however it is listed", () => {
    expect(isHarnessAllowed(STUB_PROVIDER_ID)).toBe(false);
    expect(isHarnessAllowed(STUB_PROVIDER_ID, filter([STUB_PROVIDER_ID]))).toBe(false);
  });
});

describe("buildCatalog and the user's filter", () => {
  const providers: CatalogProvider[] = [
    { id: "codex", displayName: "Codex", available: true },
    { id: "acp-omp", displayName: "omp", available: true },
    { id: "pi", displayName: "Pi", available: true },
  ];
  const models = new Map(
    providers.map((provider) => [provider.id, [model(`${provider.id}-m`)]]),
  );

  it("drops an excluded harness before TypeSafe sees the list", () => {
    const catalog = buildCatalog(providers, models, { filter: filter([], ["acp-omp"]) });
    expect(catalog.map((harness) => harness.id)).toEqual(["codex", "pi"]);
  });

  it("offers only the include list when it has entries", () => {
    const catalog = buildCatalog(providers, models, { filter: filter(["pi"]) });
    expect(catalog.map((harness) => harness.id)).toEqual(["pi"]);
  });

  it("skips an unknown id rather than failing", () => {
    const catalog = buildCatalog(providers, models, {
      filter: filter(["codex", "harness-that-left"], ["also-gone"]),
    });
    expect(catalog.map((harness) => harness.id)).toEqual(["codex"]);
  });

  it("returns an empty catalog when the filter leaves nothing", () => {
    expect(buildCatalog(providers, models, { filter: filter([], ["codex", "acp-omp", "pi"]) })).toEqual(
      [],
    );
    // The same outcome from the other direction: an include list naming only
    // harnesses this machine does not have.
    expect(buildCatalog(providers, models, { filter: filter(["nowhere"]) })).toEqual([]);
  });

  it("defaults to the built-in cap and every harness when given no options", () => {
    expect(buildCatalog(providers, models).map((harness) => harness.id)).toEqual([
      "codex",
      "acp-omp",
      "pi",
    ]);
  });
});

describe("defaultModelFor", () => {
  it("prefers the declared default, else the first entry", () => {
    expect(
      defaultModelFor({
        id: "x",
        displayName: "X",
        models: [model("a"), model("b", { isDefault: true })],
      })?.id,
    ).toBe("b");
    expect(
      defaultModelFor({ id: "x", displayName: "X", models: [model("a")] })?.id,
    ).toBe("a");
    expect(defaultModelFor({ id: "x", displayName: "X", models: [] })).toBeNull();
  });
});

describe("buildCatalog and the picker stub", () => {
  // The stub is a real entry in providers.list — that is the whole point of it.
  // It must never reach TypeSafe, or a proposal could name a harness that
  // cannot run a turn.
  const withStub: CatalogProvider[] = [
    { id: "codex", displayName: "Codex", available: true },
    { id: STUB_PROVIDER_ID, displayName: "TypeSafe Router", available: true },
    { id: "claude-code", displayName: "Claude Code", available: true },
  ];
  const models = new Map([
    ["codex", [model("gpt-6-astra", { isDefault: true })]],
    [STUB_PROVIDER_ID, [model("route", { isDefault: true })]],
    ["claude-code", [model("claude-opus-5", { isDefault: true })]],
  ]);

  it("omits the stub even when it is available and has a model", () => {
    const catalog = buildCatalog(withStub, models, { max: 8 });
    expect(catalog.map((harness) => harness.id)).toEqual(["codex", "claude-code"]);
  });

  it("leaves nothing for TypeSafe to choose when the stub is the only provider", () => {
    const catalog = buildCatalog(
      [{ id: STUB_PROVIDER_ID, displayName: "TypeSafe Router", available: true }],
      models,
      { max: 8 },
    );
    expect(catalog).toEqual([]);
  });

  it("cannot be looked up by id once the catalog is built", () => {
    const catalog = buildCatalog(withStub, models, { max: 8 });
    expect(findHarness(catalog, STUB_PROVIDER_ID)).toBeNull();
    expect(findHarness(catalog, "codex")?.id).toBe("codex");
  });
});
