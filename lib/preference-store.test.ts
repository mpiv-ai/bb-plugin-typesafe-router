import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPreferenceStore, PREFERENCES_KEY, readLegacyPreferences } from "./preference-store.js";
import { readPreferences, withHarnessAllowed } from "./preferences.js";
import { buildCatalog } from "./catalog.js";
import plugin from "../server.js";
import { readFileSync } from "node:fs";

const dirs: string[] = [];
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup(legacy: Record<string, unknown> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "router-migration-")); dirs.push(dataDir);
  const db = new Database(join(dataDir, "bb.db"));
  db.exec("CREATE TABLE plugin_settings (plugin_id TEXT, key TEXT, value TEXT)");
  const put = db.prepare("INSERT INTO plugin_settings VALUES (?, ?, ?)");
  for (const [key, value] of Object.entries(legacy)) put.run("typesafe-router", key, JSON.stringify(value));
  put.run("other-plugin", "enabled", "false");
  db.close();
  const host = createFakePluginHost({ pluginId: "typesafe-router", dataDir, sdk: { providers: { list: async () => [] } } }); hosts.push(host);
  return { ...host, dataDir };
}
describe("storage preferences", () => {
  it("migrates all five legacy prefs once, preserving false and exclusion", async () => {
    const legacy = { enabled: false, includeHarnesses: "codex", excludeHarnesses: "codex", maxModelsPerHarness: 12, curationMode: "catalog_order" };
    const { bb, dataDir } = setup(legacy);
    expect(readLegacyPreferences(dataDir, bb.pluginId)).toEqual(legacy);
    const store = await createPreferenceStore(bb);
    expect(await store.get()).toEqual({ enabled: false, includeHarnesses: "codex", excludeHarnesses: "codex" });
    expect(await bb.storage.kv.get(PREFERENCES_KEY)).toMatchObject({ legacy });
    await store.update(current => ({ ...current, enabled: true }));
    const again = await createPreferenceStore(bb);
    expect((await again.get()).enabled).toBe(true);
  });
  it("serializes simultaneous toggles and leaves exclude-all empty", async () => {
    const { bb } = setup(); const store = await createPreferenceStore(bb);
    await Promise.all(["codex", "pi"].map(id => store.update(current => ({ ...current, ...withHarnessAllowed(readPreferences(current).filter, id, false) }))));
    const filter = readPreferences(await store.get()).filter;
    expect([...filter.exclude]).toEqual(["codex", "pi"]);
    const m = { id: "m", model: "m", displayName: "M", description: "", isDefault: true };
    expect(buildCatalog(["codex", "pi"].map(id => ({ id, displayName: id, available: true })), new Map([["codex", [m]], ["pi", [m]]]), { filter })).toEqual([]);
  });
  it("does not mark a corrupt legacy row migrated", async () => {
    const { bb } = setup({ enabled: "not-a-boolean" });
    await expect(createPreferenceStore(bb)).rejects.toThrow("Invalid enabled");
    expect(await bb.storage.kv.get(PREFERENCES_KEY)).toBeUndefined();
  });
  it("defines only the API key and changes routing through storage RPC", async () => {
    const { bb, harness } = setup();
    const keys: string[] = []; const define = bb.settings.define.bind(bb.settings);
    bb.settings.define = ((descriptors: any) => { keys.push(...Object.keys(descriptors)); return define(descriptors); }) as typeof bb.settings.define;
    await plugin(bb);
    expect(keys).toEqual(["typesafeApiKey"]);
    expect(await harness.behavior.callRpc("settings_update", { enabled: false })).toMatchObject({ enabled: false });
    expect(await bb.storage.kv.get(PREFERENCES_KEY)).toMatchObject({ enabled: false });
    await expect(harness.behavior.callRpc("settings_update", { maxModelsPerHarness: 12 })).rejects.toThrow();
  });
});
