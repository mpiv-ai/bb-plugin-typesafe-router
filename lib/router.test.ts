import { describe, expect, it } from "vitest";
import type { CatalogHarness } from "./catalog.js";
import {
  effortCriteria,
  harnessCriteria,
  MAX_MESSAGE_CHARS,
  modelCriteria,
  routeFirstMessage,
  truncateMessage,
  type SystemOneCaller,
} from "./router.js";

const catalog: CatalogHarness[] = [
  {
    id: "codex",
    displayName: "Codex",
    models: [
      {
        id: "gpt-6-astra",
        model: "gpt-6-astra",
        displayName: "GPT-6-Astra",
        description: "",
        isDefault: true,
      },
      {
        id: "gpt-5.5",
        model: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "",
        isDefault: false,
      },
    ],
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    models: [
      {
        id: "claude-opus-5[1m]",
        model: "claude-opus-5[1m]",
        displayName: "Opus 5 (1M)",
        description: "",
        isDefault: true,
      },
    ],
  },
];

/** A harness whose one model has an effort ladder, for the third-call tests. */
const effortCatalog: CatalogHarness[] = [
  {
    id: "codex",
    displayName: "Codex",
    models: [
      {
        id: "gpt-6-astra",
        model: "gpt-6-astra",
        displayName: "GPT-6-Astra",
        description: "",
        isDefault: true,
        reasoningLevels: ["low", "medium", "high"],
        defaultReasoningLevel: "medium",
      },
    ],
  },
];

/** Same, but the ladder has only one rung — never worth a Choice call. */
const singleEffortCatalog: CatalogHarness[] = [
  {
    id: "codex",
    displayName: "Codex",
    models: [
      {
        id: "gpt-6-astra",
        model: "gpt-6-astra",
        displayName: "GPT-6-Astra",
        description: "",
        isDefault: true,
        reasoningLevels: ["medium"],
        defaultReasoningLevel: "medium",
      },
    ],
  },
];

/** Fields every RouteRequest needs beyond the ones a given test cares about. */
const noExplicitEffort = {
  requestedReasoningLevel: null,
  reasoningLevelIsExplicit: false,
} as const;

/** Answers each Choice call in order from a scripted list of labels. */
function fakeClient(labels: string[]): SystemOneCaller & { states: unknown[] } {
  const states: unknown[] = [];
  let call = 0;
  return {
    states,
    systemOne: async (request: any) => {
      states.push(request.state);
      const name = Object.keys(request.questions)[0]!;
      const label = labels[call++]!;
      return {
        model: "jev-1.13.0",
        usage: { input_tokens: 10, output_tokens: 1 },
        answers: {
          [name]: { type: "choice", choice: label, confidence: 0.9, probabilities: {} },
        },
      } as any;
    },
  };
}

describe("truncateMessage", () => {
  it("leaves a short message alone", () => {
    expect(truncateMessage("  hello  ")).toBe("hello");
  });

  it("caps a long message so the whole prompt is never sent", () => {
    const long = "x".repeat(MAX_MESSAGE_CHARS + 500);
    const result = truncateMessage(long);
    expect(result.startsWith("x".repeat(MAX_MESSAGE_CHARS))).toBe(true);
    expect(result).toContain("[truncated]");
    expect(result.length).toBeLessThan(long.length);
  });
});

describe("criteria", () => {
  it("offers every harness, marking the current default", () => {
    const criteria = harnessCriteria(catalog, "codex");
    expect(Object.keys(criteria)).toEqual(["codex", "claude-code"]);
    expect((criteria.codex as any).is_current_default).toBe(true);
    expect((criteria["claude-code"] as any).is_current_default).toBe(false);
  });

  it("offers only the chosen harness's models", () => {
    expect(Object.keys(modelCriteria(catalog[0]!))).toEqual([
      "gpt-6-astra",
      "gpt-5.5",
    ]);
  });
});

describe("effortCriteria", () => {
  it("describes ladder position, relative cost, and the model default", () => {
    const criteria = effortCriteria(effortCatalog[0]!.models[0]!, "mixed");
    expect(Object.keys(criteria)).toEqual(["low", "medium", "high"]);
    expect((criteria.low as any).ladder_position).toBe("1 of 3");
    expect((criteria.low as any).relative_cost).toBe("lowest");
    expect((criteria.high as any).ladder_position).toBe("3 of 3");
    expect((criteria.high as any).relative_cost).toBe("highest");
    expect((criteria.medium as any).is_model_default).toBe(true);
    expect((criteria.low as any).is_model_default).toBe(false);
    expect((criteria.medium as any).task_axis).toBe("mixed");
  });
});

describe("routeFirstMessage", () => {
  it("makes two sequential calls and returns the chosen pair", async () => {
    const client = fakeClient(["claude-code", "claude-opus-5[1m]"]);
    const result = await routeFirstMessage(client, {
      messageText: "Design a router",
      projectName: "TypeSafe Router",
      catalog,
      currentProviderId: "codex",
      ...noExplicitEffort,
    });
    expect(result.harness.id).toBe("claude-code");
    expect(result.model.id).toBe("claude-opus-5[1m]");
    expect(result.usedFallback).toBe(false);
    expect(result.inputTokens).toBe(20);
    expect(client.states).toHaveLength(2);
    // Neither model in `catalog` declares an effort ladder.
    expect(result.reasoningLevel).toBeNull();
  });

  it("sends only the (truncated) message, project, and harness names", async () => {
    const client = fakeClient(["codex", "gpt-6-astra"]);
    await routeFirstMessage(client, {
      messageText: "y".repeat(MAX_MESSAGE_CHARS + 100),
      projectName: "proj",
      catalog,
      currentProviderId: "codex",
      ...noExplicitEffort,
    });
    const state = client.states[0] as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual([
      "current_harness",
      "project",
      "user_message",
    ]);
    expect((state.user_message as string).length).toBeLessThanOrEqual(
      MAX_MESSAGE_CHARS + 20,
    );
  });

  it("only offers models from the harness the first call chose", async () => {
    const client = fakeClient(["claude-code", "claude-opus-5[1m]"]);
    await routeFirstMessage(client, {
      messageText: "hi",
      projectName: null,
      catalog,
      currentProviderId: "codex",
      ...noExplicitEffort,
    });
    const second = client.states[1] as Record<string, unknown>;
    expect(second.chosen_harness).toBe("Claude Code");
  });

  it("falls back to the current harness when the answer is not on offer", async () => {
    const client = fakeClient(["not-a-harness", "gpt-5.5"]);
    const result = await routeFirstMessage(client, {
      messageText: "hi",
      projectName: null,
      catalog,
      currentProviderId: "codex",
      ...noExplicitEffort,
    });
    expect(result.harness.id).toBe("codex");
    expect(result.model.id).toBe("gpt-5.5");
    expect(result.usedFallback).toBe(true);
  });

  it("falls back to the harness default when the model is not on offer", async () => {
    const client = fakeClient(["codex", "gpt-9-imaginary"]);
    const result = await routeFirstMessage(client, {
      messageText: "hi",
      projectName: null,
      catalog,
      currentProviderId: "codex",
      ...noExplicitEffort,
    });
    expect(result.model.id).toBe("gpt-6-astra");
    expect(result.usedFallback).toBe(true);
  });

  it("refuses to route when the machine has no usable harness", async () => {
    await expect(
      routeFirstMessage(fakeClient([]), {
        messageText: "hi",
        projectName: null,
        catalog: [],
        currentProviderId: "codex",
        ...noExplicitEffort,
      }),
    ).rejects.toThrow(/no harness/i);
  });
});

describe("routeFirstMessage effort", () => {
  it("makes a third call with the model's ladder as its labels", async () => {
    const client = fakeClient(["codex", "gpt-6-astra", "high"]);
    const result = await routeFirstMessage(client, {
      messageText: "hi",
      projectName: null,
      catalog: effortCatalog,
      currentProviderId: "codex",
      ...noExplicitEffort,
    });
    expect(client.states).toHaveLength(3);
    const thirdState = client.states[2] as Record<string, unknown>;
    expect(thirdState.chosen_model).toBe("GPT-6-Astra");
    expect(result.reasoningLevel).toBe("high");
    expect(result.effortConfidence).toBe(0.9);
    expect(result.usedFallback).toBe(false);
    // Three calls at 10 input tokens each, per fakeClient.
    expect(result.inputTokens).toBe(30);
  });

  it("skips the call when the user already chose an effort explicitly", async () => {
    const client = fakeClient(["codex", "gpt-6-astra"]);
    const result = await routeFirstMessage(client, {
      messageText: "hi",
      projectName: null,
      catalog: effortCatalog,
      currentProviderId: "codex",
      requestedReasoningLevel: "low",
      reasoningLevelIsExplicit: true,
    });
    expect(client.states).toHaveLength(2);
    expect(result.reasoningLevel).toBe("low");
    expect(result.effortConfidence).toBeNull();
  });

  it("rounds an explicit effort the model cannot reach, still without a call", async () => {
    const client = fakeClient(["codex", "gpt-6-astra"]);
    const result = await routeFirstMessage(client, {
      messageText: "hi",
      projectName: null,
      catalog: effortCatalog,
      currentProviderId: "codex",
      requestedReasoningLevel: "max",
      reasoningLevelIsExplicit: true,
    });
    expect(client.states).toHaveLength(2);
    expect(result.reasoningLevel).toBe("high");
  });

  it("skips the call when the model's ladder has only one rung", async () => {
    const client = fakeClient(["codex", "gpt-6-astra"]);
    const result = await routeFirstMessage(client, {
      messageText: "hi",
      projectName: null,
      catalog: singleEffortCatalog,
      currentProviderId: "codex",
      ...noExplicitEffort,
    });
    expect(client.states).toHaveLength(2);
    expect(result.reasoningLevel).toBe("medium");
    expect(result.effortConfidence).toBeNull();
  });

  it("falls back to the model default on an unknown effort label", async () => {
    const client = fakeClient(["codex", "gpt-6-astra", "not-a-level"]);
    const result = await routeFirstMessage(client, {
      messageText: "hi",
      projectName: null,
      catalog: effortCatalog,
      currentProviderId: "codex",
      ...noExplicitEffort,
    });
    expect(result.reasoningLevel).toBe("medium");
    expect(result.usedFallback).toBe(true);
  });
});
