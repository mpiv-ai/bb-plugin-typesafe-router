# Configuration and UI

## Settings

There is one declared setting, defined with `bb.settings.define` in `server.ts`:

| Key | Type | Where it shows |
| --- | --- | --- |
| `typesafeApiKey` | secret string | The automatic form under **Settings → Tools → TypeSafe Router**, and `bb plugin config typesafe-router set typesafeApiKey '…'`. |

The key is read at the moment a pass needs it, never cached across passes, and
never sent to the app — `settings_state` reports only `hasApiKey`. Without a
key the plugin calls `bb.status.needsConfiguration(...)` at load and proceeds
every dispatch, with the usual exception for the picker row.

## Preferences

The routing switch and the harness allow-list are *not* declared settings.
They live in plugin storage (`bb.storage.kv`, key `routing-preferences-v1`)
and are edited through the plugin's own settings section, because the useful
question — "which of the harnesses **on this machine** may Jev pick from" —
needs live server state to answer, not a text box of provider ids.

```ts
interface StoredPreferences {
  enabled: boolean;            // the "Route first messages" switch; default true
  includeHarnesses: string;    // one provider id per line, `#` comments, lowercased
  excludeHarnesses: string;    // same; applied after include, so exclude wins
}
```

`readPreferences()` in `lib/preferences.ts` turns the stored text into a
`HarnessFilter` of two `Set`s. An empty include set means "every available
harness". Unknown ids are kept, not rejected: a machine that lacks `acp-omp`
today may have it tomorrow, and an id that matches nothing filters nothing.

Toggling a harness on the settings page calls `withHarnessAllowed()`, which
writes the exclude list only and leaves the include list as typed — except
when turning *on* a harness that a narrowing include list does not name, in
which case it is added there too, or the toggle would appear to do nothing.

`preferenceSignature()` is the cache key half that makes a preference change
miss the catalog cache (see [The routing pass](routing-pass.md)).

### The store and its migration

`createPreferenceStore(bb)` in `lib/preference-store.ts`:

- On first load with nothing under `routing-preferences-v1`, it migrates once
  from the legacy declared settings. Plugin SDK 0.4.87 cannot read settings a
  plugin no longer declares, so the migration opens `bb.db` under
  `bb.server.experimental_dataDir` **read-only** with `better-sqlite3` and
  selects only this plugin's five legacy non-secret keys (`enabled`,
  `includeHarnesses`, `excludeHarnesses`, `maxModelsPerHarness`,
  `curationMode`) from `plugin_settings`. Include/exclude and the switch keep
  their values; the retired cap and mode are stored under `legacy` as
  evidence and never read. It never reads key material and never writes core
  tables. A migration error fails the load *without* recording completion, so
  an upgrade cannot silently widen exclusions.
- `update(change)` serialises read-modify-write through a promise chain, so
  two harness toggles in quick succession cannot lose each other's exclusion.

This is a deliberate dependency on BB's legacy table schema and is covered by
`lib/preference-store.test.ts` with a temporary SQLite fixture.

## The RPC contract

Defined with `defineRpcContract` in `server.ts` and typed end to end into
`app.tsx` via `useRpc<typeof rpcContract>()`.

| Method | Input | Output | Used by |
| --- | --- | --- | --- |
| `routing_get` | `{ threadId }` | `{ routing: RoutingView \| null }` | The composer banner. |
| `settings_state` | `null` | `SettingsState` | The settings section on open. |
| `settings_update` | `{ enabled? }` | `SettingsState` | The routing switch. |
| `settings_set_harness` | `{ providerId, allowed }` | `SettingsState` | A harness toggle. Refuses the picker row. |

`RoutingView` is the routing record plus display names (`providerName`,
`modelName`) resolved from the in-memory map, falling back to the ids after a
reload. `SettingsState` is `{ enabled, hasApiKey, harnesses, harnessError }`
where each harness row is `{ id, displayName, available, allowed }`, listed
live from `bb.sdk.providers.list` every time so a harness installed or signed
in since the page opened appears on the next read. If that list cannot be
read, the section still renders the switch and shows the error.

## Realtime

One channel, `routing-changed`. Every write to a routing record publishes
`{ threadId, phase }` (plus `replacementThreadId` on redirect). The banner
subscribes with `useRealtime` and refetches only when the signalled thread is
its own.

## The four surfaces

All four are registered in `definePluginApp` in `app.tsx`.

### The composer banner

`app.composer.customize({ scopes: ["thread"], banners: [...] })`. A held
dispatch writes nothing to the timeline (a `wait` is not a thread event), so
this bare line above the composer is the only place a person can see what is
happening before the card appears:

| Phase | Banner |
| --- | --- |
| `selecting` | spinner — "TypeSafe is selecting the right harness and model…" |
| `proposed` | "TypeSafe proposed **Harness** · Model. Confirm below to start." |
| `confirmed` | lock — "Harness locked to **Harness** for this thread. The model (…) can still be changed." |
| `redirected` | "Moving this message to its new thread…" — and it navigates there. |
| `skipped`, `failed`, none | nothing |

The navigation on `redirected` is what moves the reader off the placeholder
thread before its rejection lands.

### The confirmation card

`app.slots.pendingInteraction({ id: "typesafe-confirm", component: ConfirmCard })`.
The id must match `CONFIRM_RENDERER_ID` in `server.ts`. BB renders it in place
of the composer while the server's `bb.ui.requestInput` is open.

Payload from the server:

```ts
{
  providerId, providerName, model, modelName, modelDescription,
  keepsHarness, currentProviderId,
  harnessConfidence, modelConfidence,
  reasoningLevel: ReasoningLevel | null,   // proposed effort
  reasoningLevels: ReasoningLevel[],       // the model's ladder; [] if unknown
  effortConfidence: number | null,
}
```

The card shows Harness, Model, and — when there is anything to show — Effort,
as a `<select>` over the ladder when it has more than one rung and as text
otherwise. **Yep** submits `{ accept: true, reasoningLevel }`; **Cancel**
cancels, and since the thread is on the picker row, nothing runs. The footnote explains that the harness locks once the thread
starts while model and effort stay changeable.

The payload is treated as untrusted on both sides: the card coerces every field
with a fallback, and the server validates the returned effort against the
ladder before using it.

### The settings section

`app.slots.settingsSection({ id: "routing-preferences", title: "Routing preferences", ... })`,
rendered on the plugin's settings page beside the automatic form.
`SettingsPanel` loads `settings_state`, then renders `SettingsControls`
(`components/settings-controls.tsx`): the routing switch and one switch per
live harness, disabled while a write is in flight, with a warning when the
allowed count reaches zero. Every control writes through RPC and re-renders
from the returned state.

### The settings guide

`app.slots.settingsSection({ id: "routing-guide", title: "How routing works", ... })`,
registered after the preferences so it sits under the switches it explains.
`components/settings-guide.tsx` is a Markdown string rendered with BB's own
`Markdown` component — the short user guide: how to start a routed thread,
what the card shows, what follows the message, what is never routed, what
each setting does, the common error messages, and privacy — with links to
the README and these pages. Keep it in step with the README's first-use and
troubleshooting sections.

## The skill

`skills/typesafe-router/SKILL.md` is imported into agent threads by BB. It
tells an agent what the plugin intercepts and does not, what a held message
looks like, how to start a routed thread, and what to check when a thread
lands on an unexpected harness. Keep it in step with the README and
`PLUGIN_OVERVIEW.md` whenever user-visible behaviour changes — the
marketplace listing is generated from the overview.
