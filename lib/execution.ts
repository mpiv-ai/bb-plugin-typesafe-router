// The execution settings a routed thread starts with.
//
// A proposal replaces the harness and model. Everything else the user set on
// the New Thread page — reasoning effort, service tier, permission mode — is
// theirs, and should follow the message to the thread that runs it. The
// destination does not always accept what the picker offered, so each value
// is checked against the chosen model and harness and dropped when it cannot
// be honoured; core then resolves its own default, exactly as it does today.
// Pure: server.ts gathers the live facts, this decides.

/** BB's reasoning ladder, lowest to highest. */
export const REASONING_LADDER = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
] as const;
export type ReasoningLevel = (typeof REASONING_LADDER)[number];
export type ServiceTier = "default" | "fast";
export type PermissionMode = "accept-edits" | "auto" | "full";
/** Where a requested value came from; null means core defaulted it. */
export type ExecutionSource = "explicit" | "client-preference";

export interface RequestedExecution {
  reasoningLevel: ReasoningLevel | null;
  serviceTier: ServiceTier | null;
  permissionMode: PermissionMode | null;
}

export interface RequestedSources {
  reasoningLevel: ExecutionSource | null;
  serviceTier: ExecutionSource | null;
  permissionMode: ExecutionSource | null;
}

/** What the chosen model accepts; absent when the catalog did not say. */
export interface ModelSupport {
  reasoningLevels?: readonly ReasoningLevel[];
}

/** What the chosen harness accepts; absent when the catalog did not say. */
export interface HarnessSupport {
  permissionModes?: readonly PermissionMode[];
  serviceTiers?: readonly ServiceTier[];
}

export interface CarriedExecution {
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  permissionMode?: PermissionMode;
  /**
   * Provenance for the spawn. Core drops a requested provider or model that
   * carries no source and re-derives it from the project's stored defaults —
   * which, for a thread started on the picker row, is the picker row. So the
   * harness and model the router chose are always marked explicit, and each
   * carried field keeps the source it arrived with.
   */
  executionInputSources: { providerId: "explicit"; model: "explicit" } & Partial<
    Record<"reasoningLevel" | "serviceTier" | "permissionMode", ExecutionSource>
  >;
}

export function isServiceTier(value: string): value is ServiceTier {
  return value === "default" || value === "fast";
}

/**
 * The supported level closest to the one requested. A request past the top of
 * a model's ladder means "as much as it has", so ties round up.
 */
export function nearestReasoningLevel(
  requested: ReasoningLevel,
  supported: readonly ReasoningLevel[],
): ReasoningLevel | null {
  if (supported.includes(requested)) return requested;
  const rank = (level: ReasoningLevel) => REASONING_LADDER.indexOf(level);
  const target = rank(requested);
  let best: ReasoningLevel | null = null;
  for (const level of supported) {
    if (rank(level) < 0) continue;
    if (best === null) {
      best = level;
      continue;
    }
    const closer = Math.abs(rank(level) - target) - Math.abs(rank(best) - target);
    if (closer < 0 || (closer === 0 && rank(level) > rank(best))) best = level;
  }
  return best;
}

export function carryExecution(
  requested: RequestedExecution,
  sources: RequestedSources,
  model: ModelSupport,
  harness: HarnessSupport,
): CarriedExecution {
  const carried: CarriedExecution = {
    executionInputSources: { providerId: "explicit", model: "explicit" },
  };

  const levels = model.reasoningLevels ?? [];
  if (requested.reasoningLevel !== null && levels.length > 0) {
    const level = nearestReasoningLevel(requested.reasoningLevel, levels);
    if (level !== null) {
      carried.reasoningLevel = level;
      if (sources.reasoningLevel !== null) {
        carried.executionInputSources.reasoningLevel = sources.reasoningLevel;
      }
    }
  }

  const tiers = harness.serviceTiers ?? [];
  if (requested.serviceTier !== null && tiers.includes(requested.serviceTier)) {
    carried.serviceTier = requested.serviceTier;
    if (sources.serviceTier !== null) {
      carried.executionInputSources.serviceTier = sources.serviceTier;
    }
  }

  // Permission is the one field never carried from a default: the stub's own
  // default would otherwise decide how much a real harness may do, and the
  // machine ceiling is core's to apply.
  const modes = harness.permissionModes ?? [];
  if (
    requested.permissionMode !== null &&
    sources.permissionMode !== null &&
    modes.includes(requested.permissionMode)
  ) {
    carried.permissionMode = requested.permissionMode;
    carried.executionInputSources.permissionMode = sources.permissionMode;
  }

  return carried;
}
