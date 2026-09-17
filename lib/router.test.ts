import { describe, expect, it } from "vitest";
import type { CatalogHarness } from "./catalog.js";
import {
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

describe("routeFirstMessage", () => {
  it("makes two sequential calls and returns the chosen pair", async () => {
    const client = fakeClient(["claude-code", "claude-opus-5[1m]"]);
    const result = await routeFirstMessage(client, {
      messageText: "Design a router",
      projectName: "TypeSafe Router",
      catalog,
      currentProviderId: "codex",
    });
    expect(result.harness.id).toBe("claude-code");
    expect(result.model.id).toBe("claude-opus-5[1m]");
    expect(result.usedFallback).toBe(false);
    expect(result.inputTokens).toBe(20);
    expect(client.states).toHaveLength(2);
  });

  it("sends only the (truncated) message, project, and harness names", async () => {
    const client = fakeClient(["codex", "gpt-6-astra"]);
    await routeFirstMessage(client, {
      messageText: "y".repeat(MAX_MESSAGE_CHARS + 100),
      projectName: "proj",
      catalog,
      currentProviderId: "codex",
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
      }),
    ).rejects.toThrow(/no harness/i);
  });
});
