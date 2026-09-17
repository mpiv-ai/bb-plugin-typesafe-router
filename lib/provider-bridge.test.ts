// The bridge only has to do two things right: be listable, and refuse to run.

import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STUB_MODEL_ID } from "./provider.js";
import { handleLine } from "./provider-bridge.js";

let harness: ReturnType<typeof experimental_createBridgeJsonRpcTestHarness>;

beforeEach(() => {
  harness = experimental_createBridgeJsonRpcTestHarness(handleLine);
});
afterEach(() => {
  harness.restore();
});

type Params = Parameters<typeof harness.sendRequest>[2];

async function call(
  id: string,
  method: string,
  params: Params = {},
): Promise<{ result?: unknown; error?: unknown }> {
  harness.sendRequest(id, method, params);
  return await harness.waitForResponse(id);
}

const INITIALIZE_PARAMS = {
  client: { name: "bb-test", version: "0.0.0" },
  protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
};

/** The smallest session options the protocol schemas accept. */
const SESSION_OPTIONS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} as const;

describe("the picker stub's bridge", () => {
  it("completes the handshake at the one protocol version the runtime accepts", async () => {
    const response = await call("1", BRIDGE_REQUEST_METHODS.initialize, INITIALIZE_PARAMS);
    const result = response.result as {
      protocolVersion: number;
      capabilities: { fork: string; sessionRestore: boolean };
    };
    expect(result.protocolVersion).toBe(PROVIDER_BRIDGE_PROTOCOL_VERSION);
    expect(result.capabilities.fork).toBe("none");
    expect(result.capabilities.sessionRestore).toBe(false);
  });

  it("offers exactly one model, which is what makes the picker enable Send", async () => {
    const response = await call("2", BRIDGE_REQUEST_METHODS.modelList, { cwd: "/tmp" });
    const result = response.result as {
      models: { id: string; model: string; isDefault: boolean }[];
    };
    expect(result.models).toHaveLength(1);
    expect(result.models[0]!.id).toBe(STUB_MODEL_ID);
    expect(result.models[0]!.model).toBe(STUB_MODEL_ID);
    expect(result.models[0]!.isDefault).toBe(true);
  });

  it("refuses turn/start rather than pretending to run", async () => {
    const response = await call("3", BRIDGE_REQUEST_METHODS.turnStart, {
      threadId: "thr_1",
      providerThreadId: "typesafe-router_x_1",
      cwd: "/tmp",
      clientRequestId: "creq_abcdefghij",
      input: [{ type: "text", text: "build the thing" }],
      options: SESSION_OPTIONS,
    });
    const error = response.error as { code: number; message: string };
    expect(error.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
    expect(error.message).toContain("cannot run a turn");
  });

  it("answers thread/start so a placeholder thread can exist at all", async () => {
    const response = await call("4", BRIDGE_REQUEST_METHODS.threadStart, {
      threadId: "thr_1",
      cwd: "/tmp",
      instructionMode: "append",
      options: SESSION_OPTIONS,
    });
    const result = response.result as {
      providerThreadId: string;
      sessionRestorable: boolean;
    };
    expect(result.providerThreadId).toMatch(/^typesafe-router_/);
    expect(result.sessionRestorable).toBe(false);
  });

  it("fails the turn when thread/start arrives carrying input", async () => {
    harness.takeMessages();
    await call("5", BRIDGE_REQUEST_METHODS.threadStart, {
      threadId: "thr_2",
      cwd: "/tmp",
      instructionMode: "append",
      input: [{ type: "text", text: "build the thing" }],
      options: SESSION_OPTIONS,
    });
    const deltas = harness
      .takeMessages()
      .filter((message) => (message as { method?: string }).method === "thread/delta")
      .flatMap(
        (message) =>
          (message.params as unknown as {
            deltas: { kind: string; status?: string }[];
          }).deltas,
      );
    expect(deltas.some((delta) => delta.kind === "session.reset")).toBe(true);
    expect(
      deltas.some((delta) => delta.kind === "turn.boundary" && delta.status === "failed"),
    ).toBe(true);
  });

  it("reports an unknown method instead of dropping it", async () => {
    const response = await call("6", "provider/usage", {});
    expect((response.error as { code: number }).code).toBe(
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
    );
  });

  it("reports invalid params with the issues attached", async () => {
    const response = await call("7", BRIDGE_REQUEST_METHODS.initialize, {
      protocolVersion: "two",
    });
    expect((response.error as { code: number }).code).toBe(
      BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
    );
  });
});
