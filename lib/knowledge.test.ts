import { describe, expect, it } from "vitest";
import { classifyTask } from "./task-axis.js";
import { axisScore, familyCard } from "./knowledge.js";
import { buildCatalog, curateModels, modelFamilyKey, type CatalogModel } from "./catalog.js";
import { harnessCriteria, modelCriteria, routeFirstMessage, type SystemOneCaller } from "./router.js";

const model = (id: string): CatalogModel => ({ id, model: id, displayName: id, description: "", isDefault: false });
const models = ["gemini-3-flash", "claude-opus-4.5", "claude-opus-5", "claude-fable-5-1", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-5.5", "composer-2.5"].map(model);

describe("local task axes", () => {
  it.each([
    ["Debug the TypeScript code and add unit tests", "coding"],
    ["Monitor incident triage and automate ops", "agents"],
    ["Research and compare sources", "general"],
    ["Analyze the physics experiment and statistical hypothesis", "scientific"],
    ["Draft a prose essay with a warm tone", "writing"],
    ["Debug code and draft an email", "mixed"],
    ["hello", "mixed"],
  ] as const)("%s → %s", (message, expected) => expect(classifyTask(message)).toBe(expected));
  it("does not count repeated keywords as extra evidence", () => expect(classifyTask("code code code draft")).toBe("mixed"));
});

describe("knowledge shortlist", () => {
  it("normalizes dotted, hyphenated, vendor and effort aliases", () => {
    expect(modelFamilyKey("anthropic/claude-opus-4.5")).toBe(modelFamilyKey("claude-opus-4-5-20251101"));
    expect(modelFamilyKey("cursor/claude-4.6-opus-high")).toBe(modelFamilyKey("claude-opus-4-6"));
    for (const tier of ["sol", "terra", "luna"]) expect(familyCard(`openai/gpt-5.6-${tier}-high`)?.cost_band).not.toBe("unassigned");
  });
  it("ranks Opus above Flash for coding and changes order for writing/research", () => {
    const coding = curateModels(models, 8, classifyTask("Debug TypeScript code")).map(m => m.id);
    const writing = curateModels(models, 8, classifyTask("Draft a prose essay")).map(m => m.id);
    const research = curateModels(models, 8, classifyTask("Research and compare sources")).map(m => m.id);
    expect(coding).toHaveLength(8);
    expect(coding.indexOf("claude-opus-4.5")).toBeLessThan(coding.indexOf("gemini-3-flash"));
    expect(writing[0]).toBe("claude-fable-5-1");
    expect(writing).not.toEqual(coding);
    expect(research).not.toEqual(coding);
    console.log(JSON.stringify({ coding, writing, research }));
  });
  it("retains catalog order for unmeasured models without inventing scores", () => {
    const unknown = [model("new-model"), model("house-model")];
    expect(curateModels(unknown)).toEqual(unknown);
    expect(axisScore("new-model", "coding")).toBeNull();
  });
  it("puts what/not_for/tools/examples into both criteria", () => {
    const harness = { id: "codex", displayName: "Codex", models: [model("gpt-5.6-sol")] };
    for (const criterion of [harnessCriteria([harness], null).codex, modelCriteria(harness)["gpt-5.6-sol"]]) {
      expect(criterion).toMatchObject({ what: expect.any(String), not_for: expect.any(Array), tools: expect.any(Array), examples: expect.any(Array) });
      expect((criterion as any).examples.length).toBeGreaterThan(0);
    }
  });
  it("ranks the full catalog inside production routing and makes exactly two calls", async () => {
    const catalog = buildCatalog([{ id: "pi", displayName: "Pi", available: true }], new Map([["pi", [...models.slice(4), ...models.slice(0, 4)]]]), { deferShortlist: true });
    expect(catalog[0]!.models).toHaveLength(10);
    const calls: any[] = [];
    const client: SystemOneCaller = { systemOne: async (request: any) => {
      calls.push(request);
      const name = calls.length === 1 ? "harness" : "model";
      return { usage: { input_tokens: 1 }, answers: { [name]: { choice: name === "harness" ? "pi" : "claude-fable-5-1", confidence: 1 } } } as any;
    } };
    const result = await routeFirstMessage(client, { messageText: "Draft a prose essay", projectName: null, currentProviderId: null, catalog });
    expect(calls).toHaveLength(2);
    expect(result.harness.models).toHaveLength(8);
    expect(result.harness.models[0]!.id).toBe("claude-fable-5-1");
    expect(JSON.stringify(calls)).toContain(familyCard("claude-fable-5-1")!.what);
  });
});
