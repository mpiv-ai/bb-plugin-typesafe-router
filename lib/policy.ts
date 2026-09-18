// Which dispatches this plugin is allowed to hold, and what it answers on a
// re-attempt. Pure: the hook handler gathers facts, this decides.
//
// The one rule behind all of it — a BB thread's harness is fixed once the
// thread runs, so the only moment routing can change it is the first message.
// Everything else proceeds untouched.
//
// With one exception that overrides every "proceed": the thread may be sitting
// on this plugin's own picker stub, which exists so Send can be enabled and
// cannot run a turn. Releasing a message onto it would start a turn that dies
// in the bridge, so any proceed on the stub becomes a reject that says what to
// do instead. Fail closed, and only on the stub — every real harness is
// untouched.

import { STUB_CANNOT_RUN, STUB_PROVIDER_ID, isRoutableProviderId } from "./provider.js";

// Re-exported so a caller reasoning about dispatch has one import, not two.
export { STUB_PROVIDER_ID };

export const SELECTING_REASON =
  "TypeSafe is selecting the right harness and model.";
export const CONFIRMING_REASON =
  "TypeSafe proposed a harness and model — confirm to start.";

export type RoutingPhase =
  | "selecting"
  | "proposed"
  | "confirmed"
  | "redirected"
  | "skipped"
  | "failed";

export interface RoutingRecord {
  phase: RoutingPhase;
  /** Provider the proposal landed on; null before a proposal exists. */
  providerId: string | null;
  model: string | null;
  /** Set only in `redirected`: the thread that replaced this one. */
  replacementThreadId: string | null;
  /** Human-readable cause for `skipped` / `failed`, else null. */
  detail: string | null;
  updatedAt: number;
}

export interface PolicyInput {
  enabled: boolean;
  hasApiKey: boolean;
  /** This plugin's own id, to tell our spawns from another plugin's. */
  pluginId: string;
  /** The provider this dispatch would actually run on, from `requestedExecution`. */
  requestedProviderId: string;
  attempt: "join-turn" | "start-turn";
  threadStatus: "active" | "error" | "idle" | "pending" | "starting" | "stopping";
  threadVisibility: "hidden" | "visible";
  origin: "app" | "cli" | "plugin" | "sdk" | null;
  originPluginId: string | null;
  startedOnBehalfOf: { initiator: string; senderThreadId: string } | null;
  routing: RoutingRecord | null;
}

export type PolicyDecision =
  /** Hold the message and begin a routing pass. */
  | { action: "route"; reason: string }
  /** Hold the message; a pass is already in flight or awaiting confirmation. */
  | { action: "wait"; reason: string }
  | { action: "proceed"; why: string }
  | { action: "reject"; message: string };

/**
 * A thread is on its first message exactly while it is `pending`: creation is
 * unhooked and provisions nothing, so `pending` is the window between the row
 * existing and its first turn starting. Re-attempts of our own queued row see
 * the same `pending`, which is what keeps a held message routable.
 */
export function isFirstMessage(
  threadStatus: PolicyInput["threadStatus"],
): boolean {
  return threadStatus === "pending";
}

/**
 * The message a user sees when routing did not produce a runnable harness.
 * Carries the underlying cause so "declined" and "no API key" are told apart
 * without reading a log.
 */
export function stubRejectionMessage(why: string): string {
  return [
    `${STUB_CANNOT_RUN} This thread never got one (${why}).`,
    "Pick Codex or Claude in the composer and send again, or set the TypeSafe API key and start a new thread.",
  ].join(" ");
}

/**
 * The rule the whole plugin rests on: a turn never starts on the stub. Applied
 * over the decision rather than inside it, so no future branch can forget it.
 */
export function decideDispatch(input: PolicyInput): PolicyDecision {
  const decision = decide(input);
  if (decision.action === "proceed" && !isRoutableProviderId(input.requestedProviderId)) {
    return { action: "reject", message: stubRejectionMessage(decision.why) };
  }
  return decision;
}

function decide(input: PolicyInput): PolicyDecision {
  const { routing } = input;

  // Terminal states first, so a settled thread is never re-examined against
  // settings that may have changed underneath it.
  if (routing !== null) {
    switch (routing.phase) {
      case "redirected":
        return {
          action: "reject",
          message:
            "TypeSafe moved this message to a new thread on the harness you confirmed. This placeholder thread is finished.",
        };
      case "confirmed":
        return { action: "proceed", why: "confirmed" };
      case "skipped":
        if (routing.detail === "every available harness is switched off in this plugin's settings") {
          return { action: "reject", message: routing.detail };
        }
        return { action: "proceed", why: `skipped: ${routing.detail ?? "user declined"}` };
      case "failed":
        return { action: "proceed", why: `failed: ${routing.detail ?? "routing error"}` };
      default:
        break;
    }
  }

  if (!input.enabled) return { action: "proceed", why: "plugin disabled" };
  if (!input.hasApiKey) return { action: "proceed", why: "no TypeSafe API key" };

  // Joining a turn asks for nothing new; the harness is already running.
  if (input.attempt === "join-turn") return { action: "proceed", why: "join-turn" };

  // Background workers have no user to confirm with.
  if (input.threadVisibility === "hidden") {
    return { action: "proceed", why: "hidden thread" };
  }

  // An agent or the system started this thread on someone's behalf; the
  // harness is that caller's deliberate choice, not an unanswered question.
  if (input.startedOnBehalfOf !== null) {
    return { action: "proceed", why: "started on behalf of an agent" };
  }

  // Another plugin's spawn carries its own execution intent.
  if (
    input.origin === "plugin" &&
    input.originPluginId !== null &&
    input.originPluginId !== input.pluginId
  ) {
    return { action: "proceed", why: `spawned by plugin ${input.originPluginId}` };
  }

  if (!isFirstMessage(input.threadStatus)) {
    return { action: "proceed", why: "not the thread's first message" };
  }

  if (routing?.phase === "selecting") {
    return { action: "wait", reason: SELECTING_REASON };
  }
  if (routing?.phase === "proposed") {
    return { action: "wait", reason: CONFIRMING_REASON };
  }
  return { action: "route", reason: SELECTING_REASON };
}

const ROUTING_PHASES: readonly RoutingPhase[] = [
  "selecting",
  "proposed",
  "confirmed",
  "redirected",
  "skipped",
  "failed",
];

/**
 * Thread plugin metadata is writable by anything with thread access, so the
 * stored record is parsed, never trusted. An unreadable record routes again
 * rather than wedging the thread.
 */
export function parseRoutingRecord(value: unknown): RoutingRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const phase = record.phase;
  if (typeof phase !== "string" || !ROUTING_PHASES.includes(phase as RoutingPhase)) {
    return null;
  }
  const str = (key: string): string | null =>
    typeof record[key] === "string" ? (record[key] as string) : null;
  return {
    phase: phase as RoutingPhase,
    providerId: str("providerId"),
    model: str("model"),
    replacementThreadId: str("replacementThreadId"),
    detail: str("detail"),
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
  };
}
