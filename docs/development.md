# Development

[CONTRIBUTING.md](../CONTRIBUTING.md) has the short version. This page is the
long one: where things are, how they are tested, and the traps already hit.

## Layout

```
server.ts                  wiring: provider registration, settings, hook, pass, spawn, RPC
host.ts                    the bb.host artifact; re-exports the bridge
app.tsx                    composer banner, confirmation card, settings section
components/
  settings-controls.tsx    the settings section's controls
  ui/                      vendored shadcn-style primitives (yours to edit)
lib/                       pure, tested, no network
  provider.ts              picker row id/model, isRoutableProviderId
  provider-bridge.ts       JSON-RPC bridge for the picker row
  policy.ts                decideDispatch, RoutingRecord, parseRoutingRecord
  catalog.ts               harness filter, family de-dup, ranking, cap
  router.ts                the three Choice calls
  execution.ts             carryExecution, nearestReasoningLevel
  preferences.ts           stored text → HarnessFilter, toggles, cache signature
  preference-store.ts      bb.storage.kv store + legacy migration
  knowledge.ts             capability cards + axis percentiles
  task-axis.ts             local task classifier
  family.ts                modelFamilyKey
datasets/                  capability cards, axis scores, eval cases, catalog snapshot
scripts/replay-routing-eval.mjs
skills/typesafe-router/SKILL.md
docs/                      these pages
```

The dependency direction is one way: `server.ts` and `app.tsx` import from
`lib/`; nothing in `lib/` imports from `server.ts`, the SDK's runtime, or the
network. `lib/router.ts` takes a `SystemOneCaller` interface, which is why the
whole pass is testable with a fake.

## Checks

```
npm test                  # vitest: lib/, datasets/, the bridge in-process
npx tsc --noEmit -p .     # types, including the SDK's bundled declarations
npm run replay:dry        # dataset and criteria validation, no key, no network
bb plugin build           # server/app/host bundles into dist/ (gitignored)
```

CI (`.github/workflows/test.yml`) runs the first three on every pull request
and push to `main`, on Node 22, with `--skipLibCheck` on the type check.

### What the tests cover

| File | Covers |
| --- | --- |
| `lib/policy.test.ts` | Every decision branch; a table asserting each pass-through reason proceeds on a real harness and rejects on the picker row; record parsing. |
| `lib/router.test.ts` | The three calls against a fake client: criteria contents, label sets, sequencing, fallbacks, when the effort call is skipped, token accounting. |
| `lib/execution.test.ts` | Rounding on the ladder, tier and permission gating, provenance passthrough. |
| `lib/catalog.test.ts` | Filter semantics, family de-dup, ranking, the cap, the picker row's exclusion. |
| `lib/preferences.test.ts` | Parsing the list text, toggles against include/exclude, cache signature, empty-catalog detail. |
| `lib/preference-store.test.ts` | Migration from a temporary SQLite `bb.db`, corrupt rows, serialised updates. Needs `better-sqlite3`'s native module to load — see below. |
| `lib/provider-bridge.test.ts` | The bridge driven through the SDK's own JSON-RPC harness: handshake, one model, `turn/start` refused. |
| `lib/knowledge.test.ts`, `datasets/*.test.ts` | Cards resolve, reachability claims match the snapshot, percentile maths, eval-case schema. |

No test reaches the network. Keep it that way: a test that needs a TypeSafe
key is a test nobody else can run.

## Running a checkout in BB

Install by path on the machine that runs BB, then reload after every change:

```
bb plugin install . --yes
bb plugin config typesafe-router set typesafeApiKey 'YOUR_KEY'
bb plugin reload typesafe-router
```

BB builds a path-installed plugin itself, so `npm install` is only needed when
dependencies change. To confirm what is live:

```
bb plugin list | grep -A2 typesafe-router        # running, and from which path
bb provider list --json                          # the picker row's modes and tiers
bb provider models typesafe-router --json        # the picker row's effort ladder
```

The routing pass logs one line per routed thread through `bb.log.info`:
`routed <thread> to <harness>/<model>@<effort> in <ms> (<tokens> input tokens)`.
A pass that settles early logs a warning with the reason.

To check a routed thread end to end: start a thread on the picker row with a
non-default effort, confirm the card, then read the new thread's first turn
(`bb thread log <id> --json` carries `model`, `reasoningLevel`, `serviceTier`,
`permissionMode` on the turn) and compare to what was chosen.

## Traps already hit

**`better-sqlite3` ABI mismatch.** `lib/preference-store.test.ts` fails with
"The module … was compiled against a different Node.js version" when the
native module was built for another Node. `npm rebuild better-sqlite3` fixes
it. Unrelated to any code change.

**Vitest crawling into nested checkouts.** `vitest.config.ts` excludes
`**/node_modules/**` and `.claude/**` because a worktree left under the
repository once pulled zod's own test suite into the run. If a foreign test
file ever shows up in the output, that is what happened.

**The SDK's bridge bundle needs `require`.** `@get-bb/plugin-sdk@0.4.87`
ships `dist/provider-bridge.js` as ESM with cross-spawn inlined behind an
esbuild CommonJS shim that calls `require` at module load. `bb plugin build`
prepends a `createRequire` banner to `dist/host.js`; `vitest.setup.ts` does the
same for the test run. Remove the shim when the SDK ships a clean bundle.

**Thread plugin metadata is writable by anyone with thread access.** Never
trust a routing record; `parseRoutingRecord` returns `null` for anything
malformed, and the pass writes a fresh one.

**A `wait` must always be restartable.** Any state that a pass needs and that
lives only in memory (the in-flight set, the open card, display names) is lost
on reload. The record in metadata is the source of truth, and a `wait`
re-attempt restarts the pass. If you add in-memory state, ask what happens
when it is gone.

**Every release path goes through `decideDispatch`.** The picker-row guard is a
wrapper over the whole decision. A new branch that returns `proceed` from
somewhere else would be the first way to start a turn on the row.

## Adding things

- **A new routing question.** Add the call in `lib/router.ts` after the one it
  depends on, extend `RouteRequest`/`RouteResult`, add its criteria builder
  beside the others, and cover it in `lib/router.test.ts` with the fake client.
  Then carry the answer in `server.ts` (`runPass` → payload → `apply`) and show
  it on the card. `npm run replay:dry` must still pass.
- **A new carried execution field.** Extend `carryExecution` and its tests
  first; the rule for what may be carried lives there, not in `server.ts`.
- **A new preference.** Add it to `StoredPreferences`, parse it defensively in
  `parseStoredPreferences`, include it in `preferenceSignature` if the catalog
  depends on it, and expose it through the RPC contract and `SettingsControls`.
- **User-visible behaviour.** Update `README.md`, `PLUGIN_OVERVIEW.md`, and
  `skills/typesafe-router/SKILL.md` together, and the relevant page here.
