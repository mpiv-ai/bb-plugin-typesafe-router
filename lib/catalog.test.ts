import { describe, expect, it } from "vitest";
import {
  buildCatalog,
  curateModels,
  defaultModelFor,
  modelFamilyKey,
  type CatalogModel,
  type CatalogProvider,
} from "./catalog.js";

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
    expect(modelFamilyKey("cursor/claude-4.6-opus-high")).toBe("claude-4.6-opus");
    expect(modelFamilyKey("cursor/claude-4.6-opus-max")).toBe("claude-4.6-opus");
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

  it("always keeps the provider default even when it would rank low", () => {
    const models = [
      ...Array.from({ length: 20 }, (_, index) => model(`opus-${index}`)),
      model("obscure-house-model", { isDefault: true }),
    ];
    const curated = curateModels(models, 8);
    expect(curated).toHaveLength(8);
    expect(curated.map((m) => m.id)).toContain("obscure-house-model");
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
      8,
    );
    expect(catalog.map((harness) => harness.id)).toEqual(["codex", "acp-omp"]);
  });

  it("caps every harness independently", () => {
    const big = Array.from({ length: 466 }, (_, index) => model(`m/${index}`));
    const catalog = buildCatalog(
      [{ id: "acp-opencode", displayName: "opencode", available: true }],
      new Map([["acp-opencode", big]]),
      8,
    );
    expect(catalog[0]!.models.length).toBeLessThanOrEqual(8);
  });

  it("preserves provider order from the live catalog", () => {
    const catalog = buildCatalog(
      providers.filter((p) => p.available),
      new Map(providers.map((p) => [p.id, [model(`${p.id}-m`)]])),
      8,
    );
    expect(catalog.map((h) => h.id)).toEqual(["codex", "acp-omp", "pi"]);
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
