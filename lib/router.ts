// The routing pass itself: two sequential TypeSafe (Jev) Choice calls.
//
// Hierarchical, not one flat question. Asking "which of these 40 models"
// mixes two unrelated judgements — which agent harness suits the work, and
// which model inside it — and produces a label set too large to reason over.
// So: choose the harness from every harness this machine actually has, then
// choose a model from that harness's curated list only.
//
// The caller passes a `SystemOneCaller`, so tests drive this with a fake and
// never reach the network.

import { choice } from "@typesafe-ai/sdk";
import type { ChoiceCriteria, Questions, SystemOneResult } from "@typesafe-ai/sdk";
import {
  MAX_MODELS_PER_HARNESS,
  curateModels,
  defaultModelFor,
  findHarness,
  type CatalogHarness,
  type CatalogModel,
} from "./catalog.js";

import { classifyTask, type TaskAxis } from "./task-axis.js";
import { axisScore, capabilityProse, familyCard, harnessCard } from "./knowledge.js";

export const JEV_MODEL = "jev-1.13.0";

/**
 * Only the user's first message text is ever sent, and only this much of it.
 * The repository, the timeline, and every later message stay here.
 */
export const MAX_MESSAGE_CHARS = 4000;

export interface SystemOneCaller {
  systemOne<const Q extends Questions>(request: {
    state: unknown;
    questions: Q;
    model?: string;
  }): Promise<SystemOneResult<Q>>;
}

export interface RouteRequest {
  /** The user's first message. Truncated to MAX_MESSAGE_CHARS before sending. */
  messageText: string;
  /** Project name for context; never the project's contents. */
  projectName: string | null;
  catalog: readonly CatalogHarness[];
  /** Harness BB resolved on its own, offered to Jev as the status quo. */
  currentProviderId: string | null;
}

export interface RouteResult {
  harness: CatalogHarness;
  model: CatalogModel;
  harnessConfidence: number;
  modelConfidence: number;
  /** True when a returned label was not in the offered set and we fell back. */
  usedFallback: boolean;
  inputTokens: number;
  elapsedMs: number;
}

export function truncateMessage(text: string, max: number = MAX_MESSAGE_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n[truncated]`;
}

/** Live choices enriched with authored harness capabilities. */
export function harnessCriteria(
  catalog: readonly CatalogHarness[],
  currentProviderId: string | null,
): ChoiceCriteria {
  const criteria: ChoiceCriteria = {};
  for (const harness of catalog) {
    criteria[harness.id] = {
      harness: harness.displayName,
      ...capabilityProse(harnessCard(harness.id)),
      models: harness.models.map((model) => model.displayName),
      is_current_default: harness.id === currentProviderId,
    };
  }
  return criteria;
}

export function modelCriteria(harness: CatalogHarness, axis: TaskAxis = "mixed"): ChoiceCriteria {
  const criteria: ChoiceCriteria = {};
  for (const model of harness.models) {
    criteria[model.id] = {
      name: model.displayName,
      ...capabilityProse(familyCard(model.id)),
      relative_tier: familyCard(model.id)?.cost_band ?? "unassigned",
      task_axis: axis,
      snapshot_rank: axisScore(model.id, axis),
      description: model.description,
      is_harness_default: model.isDefault,
    };
  }
  return criteria;
}

const HARNESS_INSTRUCTIONS =
  "Which agent harness should run this request? The harness is fixed for the whole thread once it starts, so pick the one whose tooling and workflow fit the work, not just the one with the strongest model. Prefer the current default unless the request clearly calls for something else.";

const MODEL_INSTRUCTIONS =
  "Which model inside the chosen harness should run this request? Pick the cheapest model that can do the work well; reserve the most capable models for ambiguous, high-stakes, or long-horizon work.";

/**
 * Run the two Choice calls. The second call's label set depends on the first
 * call's answer, so they are sequential by construction — there is no useful
 * way to run them in parallel.
 */
export async function routeFirstMessage(
  client: SystemOneCaller,
  request: RouteRequest,
): Promise<RouteResult> {
  const axis = classifyTask(truncateMessage(request.messageText));
  const catalog = request.catalog.map(h => ({ ...h, models: curateModels(h.models, MAX_MODELS_PER_HARNESS, axis) })).filter(h => h.models.length > 0);
  if (catalog.length === 0) {
    throw new Error("No harness on this machine has any models to route to.");
  }
  const started = Date.now();
  const state = {
    user_message: truncateMessage(request.messageText),
    project: request.projectName,
    current_harness: request.currentProviderId,
  };
  let inputTokens = 0;
  let usedFallback = false;

  const harnessAnswer = await client.systemOne({
    model: JEV_MODEL,
    state,
    questions: {
      harness: choice(
        HARNESS_INSTRUCTIONS,
        harnessCriteria(catalog, request.currentProviderId),
      ),
    },
  });
  inputTokens += harnessAnswer.usage.input_tokens ?? 0;

  let harness = findHarness(catalog, harnessAnswer.answers.harness.choice);
  if (harness === null) {
    usedFallback = true;
    harness =
      findHarness(catalog, request.currentProviderId ?? "") ??
      catalog[0]!;
  }

  const modelAnswer = await client.systemOne({
    model: JEV_MODEL,
    state: { ...state, chosen_harness: harness.displayName },
    questions: { model: choice(MODEL_INSTRUCTIONS, modelCriteria(harness, axis)) },
  });
  inputTokens += modelAnswer.usage.input_tokens ?? 0;

  const chosenId = modelAnswer.answers.model.choice;
  let model = harness.models.find((candidate) => candidate.id === chosenId) ?? null;
  if (model === null) {
    usedFallback = true;
    model = defaultModelFor(harness);
  }
  if (model === null) {
    throw new Error(`Harness ${harness.id} reported no usable model.`);
  }

  return {
    harness,
    model,
    harnessConfidence: harnessAnswer.answers.harness.confidence,
    modelConfidence: modelAnswer.answers.model.confidence,
    usedFallback,
    inputTokens,
    elapsedMs: Date.now() - started,
  };
}
