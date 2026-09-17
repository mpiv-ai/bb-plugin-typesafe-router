// The smallest bridge that makes a picker row real.
//
// BB refuses a provider declaration from a plugin with no `bb.host` artifact,
// because a row nobody can run on is a trap. This bridge is the artifact: it
// answers the handshake so the provider is listed, answers `model/list` with
// the one routing pseudo-model, and refuses `turn/start` outright. A thread
// only ever sits on this provider for the moments between Send and the
// confirmation, and `policy.ts` guarantees the held message is redirected or
// rejected rather than released here.

import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  createBridgeIo,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  modelListParamsSchema,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  type ProviderHealthResult,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { randomUUID } from "node:crypto";
import { STUB_CANNOT_RUN, STUB_MODEL, STUB_MODEL_ID } from "./provider.js";

type JsonRpcId = string | number;

const io = createBridgeIo<{ jsonrpc: "2.0" } & Record<string, unknown>>();

const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
let threadCounter = 0;

function notify(method: string, params: Record<string, unknown>): void {
  io.send({ jsonrpc: "2.0", method, params });
}

function emitDeltas(threadId: string, deltas: readonly ThreadDelta[]): void {
  notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });
}

function invalidParams(id: JsonRpcId, method: string, issues: unknown): void {
  io.send({
    jsonrpc: "2.0",
    id,
    error: {
      code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      message: `Invalid params for ${method}`,
      data: issues,
    },
  });
}

/**
 * `provider/health` is declared unsupported, so BB should never ask. Answered
 * anyway: a probe that arrives from a future core version should read "ready
 * and nothing to install", not "method not found".
 */
const ROUTER_HEALTH: ProviderHealthResult = {
  supported: true,
  health: {
    status: "ready",
    statusMessage: null,
    accountEmail: null,
    planLabel: null,
    installedVersion: null,
    minimumSupportedVersion: null,
    canInstall: false,
    canUpdate: false,
    loginCommand: null,
  },
};

type RequestHandler = (id: JsonRpcId, params: unknown) => void;

const handlers: Record<string, RequestHandler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id, params) => {
    const parsed = initializeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.initialize, parsed.error.issues);
      return;
    }
    io.sendResult(id, {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
        sessionRestore: false,
        threadArchive: false,
        threadRename: false,
        threadGoalClear: false,
        fork: "none",
        approvalEnforcedBy: "runtime",
        steerMode: "queue",
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.modelList]: (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.modelList, parsed.error.issues);
      return;
    }
    io.sendResult(id, {
      models: [{ ...STUB_MODEL, model: STUB_MODEL_ID }],
      selectedOnlyModels: [],
    });
  },

  [BRIDGE_REQUEST_METHODS.providerHealth]: (id, params) => {
    const parsed = providerMaintenanceParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.providerHealth, parsed.error.issues);
      return;
    }
    io.sendResult(id, ROUTER_HEALTH);
  },

  // A session is allowed to exist — BB may construct one the moment a thread is
  // created, before routing has had a chance to move it. Carrying input is the
  // case that must not slip through: the turn is closed as failed immediately.
  [BRIDGE_REQUEST_METHODS.threadStart]: (id, params) => {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStart, parsed.error.issues);
      return;
    }
    threadCounter += 1;
    const providerThreadId = `typesafe-router_${nonce}_${threadCounter}`;
    const { threadId } = parsed.data;
    notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
      threadId,
      providerThreadId,
    });
    emitDeltas(threadId, [{ kind: "session.reset" }]);
    io.sendResult(id, { providerThreadId, sessionRestorable: false });
    if (parsed.data.input !== undefined && parsed.data.input.length > 0) {
      emitDeltas(threadId, refusalDeltas(providerThreadId));
    }
  },

  // `sessionRestore: false`, so this should never arrive.
  [BRIDGE_REQUEST_METHODS.threadResume]: (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadResume, parsed.error.issues);
      return;
    }
    io.sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE,
      STUB_CANNOT_RUN,
    );
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
      return;
    }
    io.sendResult(id, {});
  },

  // The whole point of the bridge, stated once: this provider does not run turns.
  [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
      return;
    }
    io.sendError(id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, STUB_CANNOT_RUN);
  },
};

function refusalDeltas(providerTurnId: string): ThreadDelta[] {
  const key = { providerItemId: `${providerTurnId}-refusal` };
  return [
    { kind: "turn.open", providerTurnId },
    {
      kind: "item.open",
      key,
      item: { type: "agentMessage", text: "" },
      providerTurnId,
    },
    {
      kind: "item.textClose",
      key,
      channel: "agentMessage",
      text: STUB_CANNOT_RUN,
      providerTurnId,
    },
    { kind: "turn.boundary", status: "failed", providerTurnId },
  ];
}

export function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return;
  }
  const { id, method, params } = message as {
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };
  // Responses to requests we never make, and notifications, are both ignored.
  if (typeof method !== "string") return;
  if (typeof id !== "string" && typeof id !== "number") return;

  const handler = handlers[method];
  if (handler === undefined) {
    io.sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Method not found: ${method}`,
    );
    return;
  }
  runBridgeRequest({
    request: { id, method, params },
    sendError: io.sendError,
    handleRequest: async (request) => handler(request.id, request.params),
  });
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
});
