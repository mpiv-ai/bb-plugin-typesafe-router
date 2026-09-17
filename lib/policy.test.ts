import { describe, expect, it } from "vitest";
import {
  CONFIRMING_REASON,
  decideDispatch,
  isFirstMessage,
  parseRoutingRecord,
  SELECTING_REASON,
  STUB_PROVIDER_ID,
  type PolicyInput,
  type RoutingRecord,
} from "./policy.js";

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    enabled: true,
    hasApiKey: true,
    pluginId: "typesafe-router",
    requestedProviderId: "codex",
    attempt: "start-turn",
    threadStatus: "pending",
    threadVisibility: "visible",
    origin: "app",
    originPluginId: null,
    startedOnBehalfOf: null,
    routing: null,
    ...overrides,
  };
}

function routing(overrides: Partial<RoutingRecord> = {}): RoutingRecord {
  return {
    phase: "selecting",
    providerId: null,
    model: null,
    replacementThreadId: null,
    detail: null,
    updatedAt: 1,
    ...overrides,
  };
}

describe("isFirstMessage", () => {
  it("is true only while the thread is pending", () => {
    expect(isFirstMessage("pending")).toBe(true);
    for (const status of ["active", "idle", "error", "starting", "stopping"] as const) {
      expect(isFirstMessage(status)).toBe(false);
    }
  });
});

describe("decideDispatch", () => {
  it("routes a fresh first message from the app", () => {
    expect(decideDispatch(input())).toEqual({
      action: "route",
      reason: SELECTING_REASON,
    });
  });

  it("keeps waiting while a pass is in flight", () => {
    expect(decideDispatch(input({ routing: routing({ phase: "selecting" }) }))).toEqual({
      action: "wait",
      reason: SELECTING_REASON,
    });
  });

  it("keeps waiting while the user has a proposal to confirm", () => {
    expect(decideDispatch(input({ routing: routing({ phase: "proposed" }) }))).toEqual({
      action: "wait",
      reason: CONFIRMING_REASON,
    });
  });

  it("proceeds once confirmed", () => {
    const decision = decideDispatch(
      input({ routing: routing({ phase: "confirmed", providerId: "codex" }) }),
    );
    expect(decision.action).toBe("proceed");
  });

  it("rejects the placeholder after the message moved to a new thread", () => {
    const decision = decideDispatch(
      input({
        routing: routing({ phase: "redirected", replacementThreadId: "thr_new" }),
      }),
    );
    expect(decision.action).toBe("reject");
  });

  it("settles terminal phases before re-reading settings", () => {
    // A key removed mid-flight must not turn a confirmed thread back into a
    // fresh routing candidate.
    for (const phase of ["confirmed", "skipped", "failed"] as const) {
      expect(
        decideDispatch(input({ enabled: false, hasApiKey: false, routing: routing({ phase }) }))
          .action,
      ).toBe("proceed");
    }
  });

  it.each<[string, Partial<PolicyInput>]>([
    ["the plugin is disabled", { enabled: false }],
    ["there is no API key", { hasApiKey: false }],
    ["the attempt joins a running turn", { attempt: "join-turn" }],
    ["the thread is a hidden worker", { threadVisibility: "hidden" }],
    [
      "an agent started the thread",
      { startedOnBehalfOf: { initiator: "agent", senderThreadId: "thr_parent" } },
    ],
    [
      "another plugin spawned it",
      { origin: "plugin", originPluginId: "github" },
    ],
    ["it is not the first message", { threadStatus: "idle" }],
  ])("proceeds untouched when %s", (_label, overrides) => {
    expect(decideDispatch(input(overrides)).action).toBe("proceed");
  });

  it("still routes our own replacement spawns", () => {
    // Our spawns seed `confirmed` metadata, but the origin check must not be
    // what lets them through — it must not veto our own plugin id.
    const decision = decideDispatch(
      input({ origin: "plugin", originPluginId: "typesafe-router" }),
    );
    expect(decision.action).toBe("route");
  });

  it("routes a CLI-started first message too", () => {
    expect(decideDispatch(input({ origin: "cli" })).action).toBe("route");
  });
});

describe("parseRoutingRecord", () => {
  it("accepts a well-formed record", () => {
    expect(
      parseRoutingRecord({
        phase: "confirmed",
        providerId: "codex",
        model: "gpt-6-astra",
        replacementThreadId: null,
        detail: null,
        updatedAt: 42,
      }),
    ).toEqual({
      phase: "confirmed",
      providerId: "codex",
      model: "gpt-6-astra",
      replacementThreadId: null,
      detail: null,
      updatedAt: 42,
    });
  });

  it("rejects anything an untrusted writer could put there", () => {
    for (const value of [
      undefined,
      null,
      "confirmed",
      42,
      [],
      {},
      { phase: "bogus" },
      { phase: 1 },
    ]) {
      expect(parseRoutingRecord(value)).toBeNull();
    }
  });

  it("nulls out fields of the wrong type rather than trusting them", () => {
    const parsed = parseRoutingRecord({
      phase: "proposed",
      providerId: { evil: true },
      model: 7,
      updatedAt: "soon",
    });
    expect(parsed).toEqual({
      phase: "proposed",
      providerId: null,
      model: null,
      replacementThreadId: null,
      detail: null,
      updatedAt: 0,
    });
  });
});

describe("decideDispatch on the picker stub", () => {
  // Everything below is a case that proceeds on a real harness. On the stub it
  // must not, because the stub's bridge refuses turn/start: proceeding would
  // trade a readable message for a dead thread.
  const onStub = (overrides: Partial<PolicyInput> = {}): PolicyInput =>
    input({ requestedProviderId: STUB_PROVIDER_ID, ...overrides });

  it("rejects when the user declined the proposal", () => {
    const decision = decideDispatch(
      onStub({ routing: routing({ phase: "skipped", detail: "declined by the user" }) }),
    );
    expect(decision.action).toBe("reject");
    expect(decision.action === "reject" && decision.message).toContain(
      "declined by the user",
    );
    expect(decision.action === "reject" && decision.message).toMatch(/Codex or Claude/);
  });

  it("rejects when there is no TypeSafe API key", () => {
    const decision = decideDispatch(onStub({ hasApiKey: false }));
    expect(decision.action).toBe("reject");
    expect(decision.action === "reject" && decision.message).toContain(
      "no TypeSafe API key",
    );
  });

  it("rejects when routing failed outright", () => {
    const decision = decideDispatch(
      onStub({ routing: routing({ phase: "failed", detail: "TypeSafe timed out" }) }),
    );
    expect(decision.action).toBe("reject");
    expect(decision.action === "reject" && decision.message).toContain(
      "TypeSafe timed out",
    );
  });

  it("rejects a confirmation that somehow landed back on the stub", () => {
    const decision = decideDispatch(
      onStub({
        routing: routing({ phase: "confirmed", providerId: STUB_PROVIDER_ID }),
      }),
    );
    expect(decision.action).toBe("reject");
  });

  it("rejects every other pass-through reason too", () => {
    const passThrough: Partial<PolicyInput>[] = [
      { enabled: false },
      { attempt: "join-turn" },
      { threadVisibility: "hidden" },
      { startedOnBehalfOf: { initiator: "agent", senderThreadId: "thr_1" } },
      { origin: "plugin", originPluginId: "some-other-plugin" },
      { threadStatus: "active" },
    ];
    for (const overrides of passThrough) {
      expect(decideDispatch(input(overrides)).action).toBe("proceed");
      expect(decideDispatch(onStub(overrides)).action).toBe("reject");
    }
  });

  it("still holds the message while the pass is running", () => {
    expect(decideDispatch(onStub()).action).toBe("route");
    expect(decideDispatch(onStub({ routing: routing({ phase: "selecting" }) }))).toEqual({
      action: "wait",
      reason: SELECTING_REASON,
    });
    expect(decideDispatch(onStub({ routing: routing({ phase: "proposed" }) }))).toEqual({
      action: "wait",
      reason: CONFIRMING_REASON,
    });
  });

  it("leaves a redirected thread's own rejection wording alone", () => {
    const decision = decideDispatch(
      onStub({ routing: routing({ phase: "redirected", replacementThreadId: "thr_2" }) }),
    );
    expect(decision.action).toBe("reject");
    expect(decision.action === "reject" && decision.message).toContain(
      "moved this message to a new thread",
    );
  });
});
