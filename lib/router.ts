// The routing pass itself: two or three sequential TypeSafe (Jev) Choice
// calls.
//
// Hierarchical, not one flat question. Asking "which of these 40 models"
// mixes unrelated judgements — which agent harness suits the work, which
// model inside it, and how hard that model should think — and produces a
// label set too large to reason over. So: choose the harness from every
// harness this machine actually has, then a model from that harness's
// curated list, then — only when the model offers more than one level and
// the user did not already choose one on the New Thread page — an effort
// from that model's own ladder.
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
import { nearestReasoningLevel, type ReasoningLevel } from "./execution.js";

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
  /** Effort core already resolved for this dispatch, from the New Thread page or a client default. */
  requestedReasoningLevel: ReasoningLevel | null;
  /** True when the user deliberately chose the effort above; that choice always wins. */
  reasoningLevelIsExplicit: boolean;
}

export interface RouteResult {
  harness: CatalogHarness;
  model: CatalogModel;
  harnessConfidence: number;
  modelConfidence: number;
  /** Null when the model has no effort ladder and the user did not choose one. */
  reasoningLevel: ReasoningLevel | null;
  /** Null when no effort Choice call was made — explicit request or a one-entry ladder. */
  effortConfidence: number | null;
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

/** Five buckets across a ladder position, so a two-entry and an eight-entry model describe cost the same way. */
function relativeCost(position: number, total: number): "lowest" | "low" | "mid" | "high" | "highest" {
  const BUCKETS = ["lowest", "low", "mid", "high", "highest"] as const;
  const fraction = total <= 1 ? 0 : position / (total - 1);
  return BUCKETS[Math.round(fraction * (BUCKETS.length - 1))]!;
}

/**
 * Criteria for the effort question. Only called for a model with two or more
 * levels — a single-entry or empty ladder never reaches TypeSafe.
 */
export function effortCriteria(model: CatalogModel, axis: TaskAxis = "mixed"): ChoiceCriteria {
  const levels = model.reasoningLevels ?? [];
  const criteria: ChoiceCriteria = {};
  levels.forEach((level, index) => {
    criteria[level] = {
      ladder_position: `${index + 1} of ${levels.length}`,
      relative_cost: relativeCost(index, levels.length),
      is_model_default: level === model.defaultReasoningLevel,
      task_axis: axis,
    };
  });
  return criteria;
}

const HARNESS_INSTRUCTIONS =
  "Which agent harness should run this request? The harness is fixed for the whole thread once it starts, so pick the one whose tooling and workflow fit the work, not just the one with the strongest model. Prefer the current default unless the request clearly calls for something else.";

const MODEL_INSTRUCTIONS =
  "Which model inside the chosen harness should run this request? Pick the cheapest model that can do the work well; reserve the most capable models for ambiguous, high-stakes, or long-horizon work.";

const EFFORT_INSTRUCTIONS =
  "How much reasoning effort should this request get? Pick the lowest level that will do the work well; more effort costs more time and money. Reserve the top of the ladder for ambiguous, high-stakes, or long-horizon work; use the bottom for quick lookups and small mechanical edits.";

/**
 * Run the harness and model Choice calls, then a third for effort when the
 * chosen model has more than one level and the user did not already pick one.
 * Each label set depends on the previous answer, so the calls are sequential
 * by construction — there is no useful way to run them in parallel.
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

  // The user's own explicit choice wins outright; the model's ladder decides
  // whether there is even a question to ask.
  let reasoningLevel: ReasoningLevel | null = null;
  let effortConfidence: number | null = null;
  if (request.reasoningLevelIsExplicit) {
    // Rounded here as well as at spawn, so the card shows the level the
    // thread will actually get rather than one this model cannot run.
    const requested = request.requestedReasoningLevel;
    reasoningLevel =
      requested === null
        ? null
        : (nearestReasoningLevel(requested, model.reasoningLevels ?? []) ?? requested);
  } else {
    const levels = model.reasoningLevels ?? [];
    if (levels.length < 2) {
      reasoningLevel = levels[0] ?? null;
    } else {
      const effortAnswer = await client.systemOne({
        model: JEV_MODEL,
        state: { ...state, chosen_harness: harness.displayName, chosen_model: model.displayName },
        questions: { effort: choice(EFFORT_INSTRUCTIONS, effortCriteria(model, axis)) },
      });
      inputTokens += effortAnswer.usage.input_tokens ?? 0;

      const chosen = effortAnswer.answers.effort.choice;
      const match = levels.find((level) => level === chosen);
      if (match === undefined) {
        usedFallback = true;
        reasoningLevel = model.defaultReasoningLevel ?? null;
      } else {
        reasoningLevel = match;
        effortConfidence = effortAnswer.answers.effort.confidence;
      }
    }
  }

  return {
    harness,
    model,
    harnessConfidence: harnessAnswer.answers.harness.confidence,
    modelConfidence: modelAnswer.answers.model.confidence,
    reasoningLevel,
    effortConfidence,
    usedFallback,
    inputTokens,
    elapsedMs: Date.now() - started,
  };
}
