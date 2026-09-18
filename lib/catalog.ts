import { axisScore } from "./knowledge.js";
import { modelFamilyKey } from "./family.js";
import type { TaskAxis } from "./task-axis.js";
import type { PermissionMode, ReasoningLevel, ServiceTier } from "./execution.js";
export { modelFamilyKey } from "./family.js";

import { isRoutableProviderId } from "./provider.js";

/** One model as `bb.sdk.providers.models` reports it, narrowed to what routing needs. */
export interface CatalogModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  /** Efforts the model accepts, lowest to highest; absent when the catalog did not say. */
  reasoningLevels?: readonly ReasoningLevel[];
  /** The model's own default effort; absent when the catalog did not say. */
  defaultReasoningLevel?: ReasoningLevel;
}

/** One harness (BB provider) plus the curated models we will offer for it. */
export interface CatalogHarness {
  id: string;
  displayName: string;
  models: CatalogModel[];
  permissionModes?: readonly PermissionMode[];
  /** Empty or absent when the harness has no service-tier choice. */
  serviceTiers?: readonly ServiceTier[];
}

/** A provider as `bb.sdk.providers.list` reports it, narrowed to what routing needs. */
export interface CatalogProvider {
  id: string;
  displayName: string;
  available: boolean;
  permissionModes?: readonly PermissionMode[];
  serviceTiers?: readonly ServiceTier[];
}

export const MAX_MODELS_PER_HARNESS = 8;

/**
 * The user's harness allow-list, already parsed from the settings text.
 * An empty `include` means "every available harness"; `exclude` is applied
 * after it, so a harness named in both is excluded.
 */
export interface HarnessFilter {
  include: ReadonlySet<string>;
  exclude: ReadonlySet<string>;
}

/** A filter that narrows nothing — the default, and what tests start from. */
export const ALLOW_ALL_HARNESSES: HarnessFilter = {
  include: new Set<string>(),
  exclude: new Set<string>(),
};

/**
 * Whether a routing pass may offer this harness. The stub is refused here too,
 * so no include list can ever talk the router onto a provider that cannot run
 * a turn. Ids are compared case-insensitively because the exclude list is
 * hand-typed.
 */
export function isHarnessAllowed(
  providerId: string,
  filter: HarnessFilter = ALLOW_ALL_HARNESSES,
): boolean {
  if (!isRoutableProviderId(providerId)) return false;
  const id = providerId.toLowerCase();
  if (filter.exclude.has(id)) return false;
  return filter.include.size === 0 || filter.include.has(id);
}

export function curateModels(
  models: readonly CatalogModel[],
  max: number = MAX_MODELS_PER_HARNESS,
  axis: TaskAxis = "mixed",
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

  const ranked = [...deduped].sort((a, b) => {
    const delta = (axisScore(b.model.id, axis) ?? -1) - (axisScore(a.model.id, axis) ?? -1);
    if (delta !== 0) return delta;
    return a.index - b.index;
  });
  return ranked.slice(0, max).map((entry) => entry.model);
}

export interface CatalogOptions {
  /** Models offered per harness. Defaults to MAX_MODELS_PER_HARNESS. */
  max?: number;
  axis?: TaskAxis;
  /** Cache the full catalog so each message can rank before truncating. */
  deferShortlist?: boolean;
  /** The user's include/exclude lists; defaults to allowing every harness. */
  filter?: HarnessFilter;
}

/**
 * Build the harness list a routing pass may choose from. Unavailable providers,
 * providers whose catalog came back empty, providers the user filtered out, and
 * this plugin's own picker stub are dropped: offering a harness with nothing to
 * run on would produce a proposal we cannot apply.
 *
 * The filter is applied here rather than only at the call site so that no
 * future caller can assemble a catalog that skips the user's preferences.
 */
export function buildCatalog(
  providers: readonly CatalogProvider[],
  modelsByProvider: ReadonlyMap<string, readonly CatalogModel[]>,
  options: CatalogOptions = {},
): CatalogHarness[] {
  const { max = MAX_MODELS_PER_HARNESS, axis = "mixed", filter, deferShortlist = false } = options;
  const harnesses: CatalogHarness[] = [];
  for (const provider of providers) {
    if (!provider.available) continue;
    // The stub half of this is not a caller's choice: a catalog containing it
    // is a bug, however the list was assembled.
    if (!isHarnessAllowed(provider.id, filter)) continue;
    const availableModels = modelsByProvider.get(provider.id) ?? [];
    const models = deferShortlist ? [...availableModels] : curateModels(availableModels, max, axis);
    if (models.length === 0) continue;
    harnesses.push({
      id: provider.id,
      displayName: provider.displayName,
      models,
      ...(provider.permissionModes === undefined ? {} : { permissionModes: provider.permissionModes }),
      ...(provider.serviceTiers === undefined ? {} : { serviceTiers: provider.serviceTiers }),
    });
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
