import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { StoredPreferences } from "./preferences.js";

export const PREFERENCES_KEY = "routing-preferences-v1";
const LEGACY_KEYS = ["enabled", "includeHarnesses", "excludeHarnesses", "maxModelsPerHarness", "curationMode"] as const;

/** BB 0.4.87 cannot read undeclared settings. Read only this plugin's old rows. */
export function readLegacyPreferences(dataDir: string, pluginId: string): Record<string, unknown> {
  const path = join(dataDir, "bb.db");
  if (!existsSync(path)) return {};
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`SELECT key, value FROM plugin_settings WHERE plugin_id = ? AND key IN (${LEGACY_KEYS.map(() => "?").join(",")})`)
      .all(pluginId, ...LEGACY_KEYS) as { key: string; value: string }[];
    return Object.fromEntries(rows.map(row => [row.key, JSON.parse(row.value)]));
  } finally { db.close(); }
}

export function parseStoredPreferences(raw: unknown): StoredPreferences {
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid routing preferences");
  const values = raw as Record<string, unknown>;
  if (values.enabled !== undefined && typeof values.enabled !== "boolean") throw new Error("Invalid enabled preference");
  for (const key of ["includeHarnesses", "excludeHarnesses"]) {
    if (values[key] !== undefined && typeof values[key] !== "string") throw new Error(`Invalid ${key} preference`);
  }
  return {
    enabled: values.enabled as boolean ?? true,
    includeHarnesses: values.includeHarnesses as string ?? "",
    excludeHarnesses: values.excludeHarnesses as string ?? "",
  };
}

export async function createPreferenceStore(bb: Pick<BbPluginApi, "storage" | "pluginId" | "server">) {
  if (await bb.storage.kv.get(PREFERENCES_KEY) === undefined) {
    const legacy = readLegacyPreferences(bb.server.experimental_dataDir, bb.pluginId);
    const preferences = parseStoredPreferences(legacy);
    // Preserve retired values as migration evidence; routing never reads them.
    await bb.storage.kv.set(PREFERENCES_KEY, { ...preferences, legacy });
  }
  const get = async () => parseStoredPreferences(await bb.storage.kv.get(PREFERENCES_KEY));
  // Serialize read/modify/write so concurrent harness toggles cannot lose exclusions.
  let pending: Promise<unknown> = Promise.resolve();
  return {
    get,
    update(change: (current: StoredPreferences) => StoredPreferences) {
      const operation = pending.then(async () => {
        const previous = await bb.storage.kv.get<Record<string, unknown>>(PREFERENCES_KEY);
        const next = parseStoredPreferences(change(parseStoredPreferences(previous)));
        await bb.storage.kv.set(PREFERENCES_KEY, { ...previous, ...next });
      });
      pending = operation.catch(() => undefined);
      return operation;
    },
  };
}
