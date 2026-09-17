// Turning a machine's live provider/model catalogs into something a Choice
// question can actually be asked about.
//
// Catalogs differ per machine and are wildly uneven: `codex` offers 5 models
// while `acp-omp` offers 800+. A Choice call with 800 labels is both useless
// and expensive, so every harness is curated down to at most
// MAX_MODELS_PER_HARNESS entries before TypeSafe ever sees it. Nothing here
// touches the network — the caller passes the lists it already fetched.
//
// One provider is filtered out unconditionally: this plugin's own picker stub.
// It is in `providers.list` so the New Thread page can enable Send, but a
// proposal that named it would route a thread to a harness that cannot run
// turns, so TypeSafe never sees it as a choice.

import { isRoutableProviderId } from "./provider.js";

/** One model as `bb.sdk.providers.models` reports it, narrowed to what routing needs. */
export interface CatalogModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
}

/** One harness (BB provider) plus the curated models we will offer for it. */
export interface CatalogHarness {
  id: string;
  displayName: string;
  models: CatalogModel[];
}

/** A provider as `bb.sdk.providers.list` reports it, narrowed to what routing needs. */
export interface CatalogProvider {
  id: string;
  displayName: string;
  available: boolean;
}

export const MAX_MODELS_PER_HARNESS = 8;

/**
 * Preference weights applied only when a harness has more models than we can
 * offer. They encode "which of these is worth a first message", not a ranking
 * of model quality — a name we have never heard of simply scores 0 and keeps
 * its catalog position, which is already provider-ranked.
 */
const PREFERENCE_RULES: readonly { pattern: RegExp; weight: number }[] = [
  { pattern: /opus/i, weight: 60 },
  { pattern: /gpt-6/i, weight: 58 },
  { pattern: /fable/i, weight: 55 },
  { pattern: /gpt-5\.6/i, weight: 52 },
  { pattern: /sonnet/i, weight: 45 },
  { pattern: /grok-4/i, weight: 40 },
  { pattern: /composer/i, weight: 38 },
  { pattern: /gemini-3|gemini-2\.5-pro/i, weight: 36 },
  { pattern: /deepseek-v4/i, weight: 30 },
  { pattern: /haiku|\bmini\b|flash|spark/i, weight: 25 },
  { pattern: /preview|nightly|legacy|deprecated|-exp\b|\bexp\b/i, weight: -40 },
  { pattern: /embed|whisper|\btts\b|image|vision/i, weight: -100 },
];

const EFFORT_SUFFIX = /-(?:none|low|medium|high|xhigh|max|ultra|ultracode)$/;
const DATE_SUFFIX = /-\d{6,8}$/;
const CONTEXT_TAG = /\[[^\]]*\]/g;

/**
 * The key two entries share when they are the same model wearing different
 * routing clothes: `cursor/claude-4.6-opus-high` and
 * `cursor/claude-4.6-opus-max` are one choice, not two.
 */
export function modelFamilyKey(id: string): string {
  const withoutVendor = id.split(/[/:]/).pop() ?? id;
  let key = withoutVendor.toLowerCase().replace(CONTEXT_TAG, "");
  key = key.replace(DATE_SUFFIX, "");
  key = key.replace(EFFORT_SUFFIX, "");
  return key;
}

function preferenceScore(model: CatalogModel): number {
  const haystack = `${model.id} ${model.displayName}`;
  let score = 0;
  for (const rule of PREFERENCE_RULES) {
    if (rule.pattern.test(haystack)) score += rule.weight;
  }
  return score;
}

/**
 * Reduce one harness's model list to at most `max` entries: the provider's own
 * default always survives, same-family duplicates collapse to their first
 * occurrence, and an oversized remainder is ranked by preference with catalog
 * order as the tie-break. Stable for a given input, so tests and two
 * consecutive routings agree.
 */
export function curateModels(
  models: readonly CatalogModel[],
  max: number = MAX_MODELS_PER_HARNESS,
): CatalogModel[] {
  if (max <= 0) return [];
  const byFamily = new Map<string, { model: CatalogModel; index: number }>();
  models.forEach((model, index) => {
    const key = modelFamilyKey(model.id);
    const existing = byFamily.get(key);
    // A default beats an earlier sibling; otherwise first occurrence wins.
    if (existing === undefined || (model.isDefault && !existing.model.isDefault)) {
      byFamily.set(key, { model, index });
    }
  });
  const deduped = [...byFamily.values()].sort((a, b) => a.index - b.index);
  if (deduped.length <= max) return deduped.map((entry) => entry.model);

  const ranked = [...deduped].sort((a, b) => {
    if (a.model.isDefault !== b.model.isDefault) return a.model.isDefault ? -1 : 1;
    const delta = preferenceScore(b.model) - preferenceScore(a.model);
    if (delta !== 0) return delta;
    return a.index - b.index;
  });
  const kept = new Set(ranked.slice(0, max).map((entry) => entry.index));
  return deduped.filter((entry) => kept.has(entry.index)).map((entry) => entry.model);
}

/**
 * Build the harness list a routing pass may choose from. Unavailable providers,
 * providers whose catalog came back empty, and this plugin's own picker stub
 * are dropped: offering a harness with nothing to run on would produce a
 * proposal we cannot apply.
 */
export function buildCatalog(
  providers: readonly CatalogProvider[],
  modelsByProvider: ReadonlyMap<string, readonly CatalogModel[]>,
  max: number = MAX_MODELS_PER_HARNESS,
): CatalogHarness[] {
  const harnesses: CatalogHarness[] = [];
  for (const provider of providers) {
    if (!provider.available) continue;
    // Not a caller's choice: a catalog containing the stub is a bug, however
    // the list was assembled.
    if (!isRoutableProviderId(provider.id)) continue;
    const models = curateModels(modelsByProvider.get(provider.id) ?? [], max);
    if (models.length === 0) continue;
    harnesses.push({ id: provider.id, displayName: provider.displayName, models });
  }
  return harnesses;
}

/** The model a harness falls back to when a proposal names one we do not have. */
export function defaultModelFor(harness: CatalogHarness): CatalogModel | null {
  return harness.models.find((model) => model.isDefault) ?? harness.models[0] ?? null;
}

export function findHarness(
  catalog: readonly CatalogHarness[],
  id: string,
): CatalogHarness | null {
  return catalog.find((harness) => harness.id === id) ?? null;
}
