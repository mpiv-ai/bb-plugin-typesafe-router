import { describe, expect, it } from "vitest";
import {
  carryExecution,
  nearestReasoningLevel,
  type RequestedExecution,
  type RequestedSources,
} from "./execution.js";

const codexLevels = ["low", "medium", "high", "xhigh"] as const;

function requested(patch: Partial<RequestedExecution> = {}): RequestedExecution {
  return { reasoningLevel: null, serviceTier: null, permissionMode: null, ...patch };
}

function sources(patch: Partial<RequestedSources> = {}): RequestedSources {
  return { reasoningLevel: null, serviceTier: null, permissionMode: null, ...patch };
}

describe("nearestReasoningLevel", () => {
  it("returns an exact match", () => {
    expect(nearestReasoningLevel("high", codexLevels)).toBe("high");
  });

  it("clamps a request above the ladder to its top", () => {
    expect(nearestReasoningLevel("max", codexLevels)).toBe("xhigh");
  });

  it("clamps a request below the ladder to its bottom", () => {
    expect(nearestReasoningLevel("none", codexLevels)).toBe("low");
  });

  it("rounds a tie up", () => {
    expect(nearestReasoningLevel("medium", ["low", "high"])).toBe("high");
  });

  it("has nothing to offer from an empty ladder", () => {
    expect(nearestReasoningLevel("medium", [])).toBeNull();
  });
});

describe("carryExecution", () => {
  it("carries an exact effort with the source it came with", () => {
    const carried = carryExecution(
      requested({ reasoningLevel: "high" }),
      sources({ reasoningLevel: "explicit" }),
      { reasoningLevels: codexLevels },
      {},
    );
    expect(carried.reasoningLevel).toBe("high");
    expect(carried.executionInputSources).toEqual({ reasoningLevel: "explicit" });
  });

  it("clamps an explicit effort the model cannot reach and keeps it explicit", () => {
    const carried = carryExecution(
      requested({ reasoningLevel: "max" }),
      sources({ reasoningLevel: "explicit" }),
      { reasoningLevels: codexLevels },
      {},
    );
    expect(carried.reasoningLevel).toBe("xhigh");
    expect(carried.executionInputSources.reasoningLevel).toBe("explicit");
  });

  it("carries a defaulted effort as a value but not as a choice", () => {
    const carried = carryExecution(
      requested({ reasoningLevel: "medium" }),
      sources(),
      { reasoningLevels: codexLevels },
      {},
    );
    expect(carried.reasoningLevel).toBe("medium");
    expect(carried.executionInputSources).toEqual({});
  });

  it("drops effort when the catalog did not say what the model supports", () => {
    const carried = carryExecution(
      requested({ reasoningLevel: "high" }),
      sources({ reasoningLevel: "explicit" }),
      {},
      {},
    );
    expect(carried.reasoningLevel).toBeUndefined();
    expect(carried.executionInputSources).toEqual({});
  });

  it("carries fast mode only onto a harness that offers it", () => {
    const onto = (serviceTiers: readonly ("default" | "fast")[]) =>
      carryExecution(
        requested({ serviceTier: "fast" }),
        sources({ serviceTier: "explicit" }),
        {},
        { serviceTiers },
      );
    expect(onto(["default", "fast"])).toMatchObject({
      serviceTier: "fast",
      executionInputSources: { serviceTier: "explicit" },
    });
    expect(onto([]).serviceTier).toBeUndefined();
    expect(onto(["default"]).serviceTier).toBeUndefined();
  });

  it("never carries a permission mode core defaulted", () => {
    const carried = carryExecution(
      requested({ permissionMode: "full" }),
      sources(),
      {},
      { permissionModes: ["accept-edits", "auto", "full"] },
    );
    expect(carried.permissionMode).toBeUndefined();
  });

  it("carries a chosen permission mode the harness runs in, and drops one it does not", () => {
    const harness = { permissionModes: ["auto", "full"] as const };
    expect(
      carryExecution(
        requested({ permissionMode: "full" }),
        sources({ permissionMode: "client-preference" }),
        {},
        harness,
      ),
    ).toMatchObject({
      permissionMode: "full",
      executionInputSources: { permissionMode: "client-preference" },
    });
    expect(
      carryExecution(
        requested({ permissionMode: "accept-edits" }),
        sources({ permissionMode: "explicit" }),
        {},
        harness,
      ).permissionMode,
    ).toBeUndefined();
  });

  it("carries nothing when nothing was requested", () => {
    expect(
      carryExecution(requested(), sources(), { reasoningLevels: codexLevels }, {
        permissionModes: ["auto"],
        serviceTiers: ["default", "fast"],
      }),
    ).toEqual({ executionInputSources: {} });
  });
});
