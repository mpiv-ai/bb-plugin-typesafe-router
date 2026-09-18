// The picker stub.
//
// BB's New Thread page will not enable Send until a providerId and a model are
// chosen, and routing cannot run before Send. So the plugin registers one
// provider row whose only job is to be selectable: picking it satisfies
// `NewThreadRequest`, Send lights up, and the dispatch hook takes over from
// there — it holds the message, runs the TypeSafe pass, and moves the thread
// onto a harness that actually runs turns.
//
// Nothing here ever executes a turn. The bridge in `provider-bridge.ts`
// answers the handshake and the model probe and refuses `turn/start`, and
// `policy.ts` rejects any dispatch that would proceed on this id, so a
// routing failure surfaces as a clear message instead of a dead thread.

import type {
  PluginProviderFallbackModel,
  PluginProviderReasoningLevel,
} from "@get-bb/plugin-sdk";

/** Registered provider id. Persisted on thread rows — never change it. */
export const STUB_PROVIDER_ID = "typesafe-router";

export const STUB_PROVIDER_DISPLAY_NAME = "TypeSafe Router";

/**
 * The single model. It is not a model — it is the picker's way of saying
 * "decide later", which is why the display name reads as an action. It offers
 * a real effort ladder for the same reason: whatever is picked here follows
 * the message to the thread that runs it, rounded to what that model supports.
 */
export const STUB_MODEL_ID = "route";

export const STUB_REASONING_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly PluginProviderReasoningLevel[];

export const STUB_MODEL = {
  id: STUB_MODEL_ID,
  displayName: "Choose harness and model",
  description:
    "TypeSafe reads your first message, proposes a harness and model, and asks you to confirm before anything runs.",
  supportedReasoningEfforts: STUB_REASONING_LEVELS.map((reasoningEffort) => ({
    reasoningEffort,
    description: "Carried to the chosen model, rounded to the nearest effort it supports.",
  })),
  defaultReasoningEffort: "medium",
  isDefault: true,
} satisfies PluginProviderFallbackModel;

/** What the bridge says when asked to run a turn, and what a rejected dispatch explains. */
export const STUB_CANNOT_RUN =
  "TypeSafe Router chooses a harness; it cannot run a turn itself.";

/**
 * True for a provider a routing proposal may legitimately land on. The stub is
 * the only exclusion, and it is excluded everywhere — from the catalog TypeSafe
 * sees and from the dispatch it is allowed to release.
 */
export function isRoutableProviderId(providerId: string): boolean {
  return providerId !== STUB_PROVIDER_ID;
}
