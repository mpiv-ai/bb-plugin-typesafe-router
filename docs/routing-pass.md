# The routing pass

Everything TypeSafe (Jev) knows about the choice it is asked to make arrives
inside the Choice criteria. It has no model catalog of its own, has never heard
of the harnesses on your machine, and cannot know that one model costs a
fraction of another. So the pass has two halves: **building what Jev is
shown**, and **asking**.

## Building the catalog

`loadCatalog(hostId, preferences)` in `server.ts`, then `buildCatalog()` and
`curateModels()` in `lib/catalog.ts`.

1. **List providers for the thread's host.** `bb.sdk.providers.list({ hostId })`.
   Catalogs are per machine: one machine may have Codex and Claude Code, another
   only Codex, a third an ACP harness with 600 models. Routing only ever offers
   what the thread's machine can actually run.
2. **Drop what cannot be a candidate.** Unavailable providers (not installed or
   not signed in), the picker row, and any harness the user's allow-list
   excludes. `isHarnessAllowed()` refuses the picker row unconditionally, so no
   include list can talk the router onto it.
3. **List models for each survivor.** `bb.sdk.providers.models({ hostId, providerId })`,
   in parallel. A provider whose model list fails is logged and offered with no
   models, which drops it in the next step. Each model is narrowed to what
   routing needs — id, display name, description, whether it is the provider's
   default, and (for the effort call and the spawn) its supported reasoning
   efforts and default effort.
4. **Cache.** The result is cached for 60 seconds, keyed by host id *and* a
   signature of the preferences, so editing the settings page invalidates the
   list it produced rather than serving it for another minute.

The full catalog is cached; curation happens per message, because it depends
on the message.

### Curation: eight models per harness

`curateModels(models, 8, axis)`:

1. **Collapse families.** `modelFamilyKey()` in `lib/family.ts` strips the
   vendor prefix (`cursor/`, `openrouter:`), context tags (`[1m]`), date
   suffixes, effort suffixes (`-high`, `-max`), normalises dotted versions to
   dashes, and reorders `claude-4-5-sonnet` to `claude-sonnet-4-5`. Within a
   family the provider's default wins; otherwise the first occurrence. An ACP
   harness that reports 666 models is mostly the same few dozen wearing
   different routing clothes.
2. **Rank by the task axis.** `axisScore(id, axis)` from `lib/knowledge.ts`
   (below). Unscored models keep catalog order after scored ones; nothing is
   invented for them.
3. **Take the top eight.** A flat forty-label question is not a question Jev
   can reason over well, and eight per harness keeps the criteria bounded.

### The task axis

`classifyTask(text)` in `lib/task-axis.ts` is a local regex classifier over the
truncated message. Five signal sets — `coding`, `agents`, `general`,
`scientific`, `writing` — each count *distinct* matched words (so repetition
does not bias). The axis with the most distinct signals wins; no signals or a
tie means `mixed`. It runs before any network call and never leaves the
machine.

### Capability knowledge

Two vendored datasets feed the criteria; both are read at load, never fetched
during routing.

**`datasets/capability-cards.json`** — hand-authored cards for each harness and
each model *family* (never per model). Each carries `what` (the positive case),
`not_for` (the negative case the display name can never carry), `tools`,
`examples` (few-shot anchors phrased like a user's first message), and for
families a `cost_band` (`cheap` / `mid` / `frontier` / `unassigned`). A model
with no card gets a criterion saying its capabilities are unverified and its
tools must not be inferred from its name.

**`datasets/axis-scores.json`** — a dated snapshot of public benchmark results
with source URLs. `axisScore()` converts each family's result into a percentile
*within that benchmark's cohort* (ties get half credit), then averages the
percentiles for the axis. `mixed` averages the available axes. Missing results
stay `null`; a newer version never inherits an older one's numbers. These
small, heterogeneous cohorts are a routing heuristic, not a leaderboard —
`datasets/README.md` says so at length.

## Asking

`routeFirstMessage(client, request)` in `lib/router.ts`. The `client` is a
`SystemOneCaller`; production passes a `TypeSafeClient`, tests pass a fake. The
model is `jev-1.13.0`.

The calls are sequential by construction — each label set depends on the
previous answer — so there is no useful way to run them in parallel.

### What every call carries

- `user_message`: the first message's text, trimmed and truncated to
  `MAX_MESSAGE_CHARS` (4000) with a `[truncated]` marker.
- `project`: the project name only. Never the repository, the timeline, or
  any later message.
- `current_harness`: the provider BB resolved on its own, offered as the
  status quo.

### Call 1 — which harness

Labels are provider ids. Each criterion: the display name, the harness card's
`what` / `not_for` / `tools` / `examples`, the display names of its curated
models, and `is_current_default`.

Instruction: the harness is fixed for the whole thread, so pick the one whose
tooling and workflow fit the work, not just the one with the strongest model;
prefer the current default unless the request clearly calls for something
else.

Fallback: an answer not in the catalog uses the current harness if it is
offered, else the first, and sets `usedFallback`.

### Call 2 — which model in that harness

Labels are the chosen harness's curated model ids. Each criterion: the display
name, the family card's prose, `relative_tier` (the card's cost band),
`task_axis`, `snapshot_rank` (the axis percentile, or null), the provider's own
description, and `is_harness_default`. The state gains `chosen_harness`.

Instruction: pick the cheapest model that can do the work well; reserve the
most capable for ambiguous, high-stakes, or long-horizon work.

Fallback: an unknown answer uses the harness's default model, else its first,
and sets `usedFallback`. A harness with no usable model throws, which settles
the pass as `failed`.

### Call 3 — how much effort

Made only when **both** hold: the user did not explicitly choose an effort on
the New Thread page (`executionSources.reasoningLevel !== "explicit"`), and the
chosen model's ladder has at least two rungs. An explicit choice wins outright
— it is rounded to the model's ladder (see [Execution settings](execution-settings.md))
but never re-decided. A one-rung ladder is that rung; an unknown ladder is no
effort at all, and the spawn lets core default it.

Labels are the model's supported efforts, lowest to highest. Each criterion:
`ladder_position` ("2 of 4"), `relative_cost` (five buckets from position, so
a two-rung and an eight-rung ladder describe cost the same way),
`is_model_default`, and `task_axis`. The state gains `chosen_model`.

Instruction: pick the lowest level that will do the work well — more effort
costs more time and money; reserve the top of the ladder for ambiguous,
high-stakes, or long-horizon work; use the bottom for quick lookups and small
mechanical edits.

Fallback: an unknown answer uses the model's default effort (or nothing) and
sets `usedFallback`; `effortConfidence` stays null.

### The result

```ts
interface RouteResult {
  harness: CatalogHarness;
  model: CatalogModel;
  reasoningLevel: ReasoningLevel | null;
  harnessConfidence: number;
  modelConfidence: number;
  effortConfidence: number | null;   // null when no effort call was made
  usedFallback: boolean;
  inputTokens: number;               // summed across the calls made
  elapsedMs: number;
}
```

`server.ts` logs one line per routed thread —
`routed <thread> to <harness>/<model>@<effort> in <ms> (<tokens> input tokens)`
— which is the cheapest place to see what the pass decided and what it cost.

## Evaluating changes to the pass

`datasets/eval-cases.jsonl` holds 44 routing cases with gold harness, cost
band, and family, argued in a required `notes` field; `scripts/replay-routing-eval.mjs`
replays them against a captured catalog snapshot and writes a report.
`npm run replay:dry` validates the datasets and criteria without a key or the
network and runs in CI; with `TYPESAFE_API_KEY` set the full replay calls Jev.
The baseline to read scores against is that a router answering `claude-code`
every time would score 57% on harness accuracy on this set — see
`datasets/README.md` for the categories, the traps, and the known gaps in the
data before trusting a number.
