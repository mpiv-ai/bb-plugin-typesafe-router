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

import type { PluginProviderFallbackModel } from "@get-bb/plugin-sdk";

/** Registered provider id. Persisted on thread rows — never change it. */
export const STUB_PROVIDER_ID = "typesafe-router";

export const STUB_PROVIDER_DISPLAY_NAME = "TypeSafe Router";

/**
 * The single model. It is not a model — it is the picker's way of saying
 * "decide later", which is why the display name reads as an action.
 */
export const STUB_MODEL_ID = "route";

export const STUB_MODEL = {
  id: STUB_MODEL_ID,
  displayName: "Choose harness and model",
  description:
    "TypeSafe reads your first message, proposes a harness and model, and asks you to confirm before anything runs.",
  supportedReasoningEfforts: [
    {
      reasoningEffort: "medium",
      description: "Routing only; the chosen harness decides its own effort.",
    },
  ],
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
