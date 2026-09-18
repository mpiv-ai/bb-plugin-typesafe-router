// The plugin's settings, turned into the few decisions routing actually makes.
//
// Everything here is pure. server.ts reads the stored values on each routing
// pass and hands them to these functions, so changing a preference takes effect
// on the next message rather than on the next plugin reload.
//
// Stored values are not trusted: `bb plugin config set` and the settings page
// both write through the same validators, but a value that predates a schema
// change still has to parse into something routable. Unknown provider ids are
// kept rather than rejected — a machine that does not have `acp-omp` today may
// have it tomorrow, and an id that matches nothing simply filters nothing.

import type { HarnessFilter } from "./catalog.js";
export type { HarnessFilter };
export interface StoredPreferences {
  enabled: boolean;
  includeHarnesses: string;
  excludeHarnesses: string;
}
export interface RouterPreferences {
  enabled: boolean;
  filter: HarnessFilter;
}

/**
 * Parse one of the harness list settings: one provider id per line, `#` starts
 * a comment, blank lines are ignored, and ids are lowercased so a hand-typed
 * `Codex` still matches the `codex` provider.
 */
export function parseHarnessIds(raw: string | undefined | null): Set<string> {
  const ids = new Set<string>();
  if (typeof raw !== "string") return ids;
  for (const line of raw.split(/\r?\n/)) {
    const id = (line.split("#")[0] ?? "").trim().toLowerCase();
    if (id !== "") ids.add(id);
  }
  return ids;
}

/** The inverse of parseHarnessIds, for writing a list back from the toggles. */
export function formatHarnessIds(ids: Iterable<string>): string {
  return [...ids].sort().join("\n");
}

export function readPreferences(values: StoredPreferences): RouterPreferences {
  return {
    enabled: values.enabled,
    filter: {
      include: parseHarnessIds(values.includeHarnesses),
      exclude: parseHarnessIds(values.excludeHarnesses),
    },
  };
}

/**
 * The settings text that turns one harness toggle on or off.
 *
 * Toggling writes the exclude list only. The include list stays whatever the
 * user typed, because exclude is applied after it: turning off the sole entry
 * of a narrowing include list correctly leaves nothing routable, and turning it
 * back on restores exactly what was there before. The one exception is turning
 * a harness ON that a narrowing include list does not name — without adding it
 * there, the toggle would appear to do nothing.
 */
export function withHarnessAllowed(
  filter: HarnessFilter,
  providerId: string,
  allowed: boolean,
): { includeHarnesses: string; excludeHarnesses: string } {
  const id = providerId.trim().toLowerCase();
  const include = new Set(filter.include);
  const exclude = new Set(filter.exclude);
  if (allowed) {
    exclude.delete(id);
    if (include.size > 0) include.add(id);
  } else {
    exclude.add(id);
  }
  return {
    includeHarnesses: formatHarnessIds(include),
    excludeHarnesses: formatHarnessIds(exclude),
  };
}

/**
 * Cache identity for a built catalog. The catalog is a function of the machine
 * AND of these preferences, so a preference change has to miss the cache rather
 * than serve the list the previous settings produced.
 */
export function preferenceSignature(preferences: RouterPreferences): string {
  return [
    formatHarnessIds(preferences.filter.include).replace(/\n/g, ","),
    formatHarnessIds(preferences.filter.exclude).replace(/\n/g, ","),
  ].join("|");
}

/**
 * Why a routing pass found nothing to choose from. Told apart deliberately: a
 * machine with no usable harness is a different problem from a machine whose
 * harnesses are all switched off on the settings page, and the second one is
 * fixable in ten seconds by the person reading the message.
 */
export function emptyCatalogDetail(routableBeforeFilter: number): string {
  return routableBeforeFilter === 0
    ? "no harness on this machine can run a turn"
    : "every available harness is switched off in this plugin's settings";
}
