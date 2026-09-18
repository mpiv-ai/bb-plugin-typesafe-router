# Production capability knowledge

Production routing now imports the capability cards and `axis-scores.json`.
The catalog snapshot below is historical; its old shortlist is retained for
the thin/rich replay, not used to shortlist production models. Family identities
are normalized when loaded. The replay compares criteria against that fixed
historical offer set and does not measure the new task-axis ranking.

The axis snapshot records source URLs, capture date, raw public results, and
limitations. `lib/knowledge.ts` computes within-benchmark percentiles, then
averages them by axis. GDPval-AA v2 is a writing/office-work proxy rather than
a creative-writing benchmark. Missing results stay null. Relative cost tiers
are authored card metadata and do not rank shortlists or assert current prices.

## Historical dataset notes (prior to production integration)

# Routing capability cards and eval set

Jev has no model catalog. It has never heard of `gpt-6-astra`, and it cannot
know that `cursor/composer-2.5` is an editor-tuned model or that
`gemini-3.8-flash` costs a fraction of `claude-opus-5`. Everything it knows
about the choice it is being asked to make has to arrive inside the Choice
criteria.

Today `harnessCriteria` and `modelCriteria` in [`lib/router.ts`](../lib/router.ts)
send the BB display name and the provider's own `description`. That is thinner
than it sounds:

| harness | models | families | empty descriptions | offered after the 8-cap |
| --- | ---: | ---: | ---: | ---: |
| `codex` | 5 | 5 | 0 | 5 |
| `claude-code` | 6 | 6 | 0 | 6 |
| `pi` | 402 | 290 | 0 | 8 |
| `acp-cursor` | 0 | 0 | 0 | 0 |
| `acp-omp` | 666 | 442 | **666** | 8 |
| `acp-grok` | 1 | 1 | 1 | 1 |
| `acp-hermes-agent` | 41 | 41 | 0 | 8 |

Every one of omp's 666 models has an empty description. For that harness the
model question is literally "pick one of these eight strings".

This directory is the dataset for finding out whether writing the missing
descriptions helps, and by how much.

## What is here

| file | what it is |
| --- | --- |
| `capability-cards.json` | 7 harness cards and 26 model-family cards, hand-authored. |
| `eval-cases.jsonl` | 44 routing cases with gold harness, band, and family. |
| `catalog-snapshot.json` | The live hub catalog as captured on 2026-09-17, curated to the 8-model cap, plus a family→harness index. |
| `bands.ts` | The cost-band vocabulary and the derivation from family name to band. |
| `load.ts` | Typed readers shared by the tests. |
| `replay-report.json` | Written by the replay script. Not committed. |

Everything here is synthetic or public knowledge. No CRM data, no real user
threads, no PII, no credentials.

## How a card becomes a Choice criterion

A `ChoiceCriteria` is `{ [label: string]: Description }`, and a `Description`
may be a JSON object. So a card does not need prose-ifying — the structured
fields go straight in as the label's description, and Jev reads the object.

The label stays exactly what it is today: a provider id for the harness
question, a model id for the model question. Only the description changes.

**Harness question.** Label is the provider id.

```jsonc
{
  "acp-hermes-agent": {
    "harness": "Hermes Agent",
    "what": "Hermes Agent over ACP: a persistent agent that carries state across sessions …",
    "not_for": ["A quick one-off change; the persistence is overhead with no payoff.", …],
    "tools": ["persistent memory across sessions", "scheduled and resumed runs", …],
    "context": "41 curated models with vendor-prefixed ids …",
    "examples": ["Own the dependency upgrades for this repo and keep at it week over week.", …],
    "is_current_default": false
  }
}
```

**Model question.** Label is the model id; the description comes from the card
for that model's *family*, so `cursor/claude-opus-5-high` and
`cursor/claude-opus-5-max` share one card.

```jsonc
{
  "claude-haiku-4-5-20251001": {
    "name": "Claude Haiku 4.5",
    "family": "claude-haiku-4-5",
    "cost_band": "cheap",
    "band_means": "Fast, low-cost model for lookups, rewrites, and single-step asks.",
    "what": "Anthropic's fast, cheap family. Genuinely capable on bounded single-step work …",
    "not_for": ["Multi-step agentic work.", …],
    "tools": ["fast single-step turns", "extraction and classification", "short edits"],
    "context": "Claude Code's cheap option and the only sub-mid Anthropic family …",
    "examples": ["Pull the version numbers out of this changelog into a table.", …],
    "is_harness_default": false
  }
}
```

The three field groups do different jobs, and it is worth keeping them apart
when reading a bad result:

- **`what`** is the positive case. It moves probability *toward* a label.
- **`not_for`** is the negative case, and it is the half the display name can
  never carry. "Frontier model" does not tell Jev to stop picking it for a
  typo fix; "Lookups, renames, and single-file edits — the capability is wasted
  and the bill is not" does.
- **`examples`** are few-shot anchors. Two to four short, synthetic task
  strings per card, phrased the way a user's first message is phrased, so they
  sit in the same distribution as the thing being classified.

`cost_band` is the one field that is *not* written by hand — see below.

### Thin vs rich, side by side

The replay script builds both from the same catalog and asks the same question.

| | thin (today) | rich (cards) |
| --- | --- | --- |
| harness description | display name + model display names | `what`, `not_for`, `tools`, `context`, `examples` |
| model description | display name + provider `description` (empty on omp) | `what`, `not_for`, `tools`, `cost_band`, `context`, `examples` |
| what distinguishes Codex from Claude Code | two strings: `"Codex"`, `"Claude Code"` | sandboxed shell and test iteration vs MCP, skills, subagents, hooks |
| what distinguishes two omp models | nothing — both descriptions are `""` | family, band, strengths, and what not to use it for |
| approximate criteria size, harness question | ~40 tokens | ~900 tokens |

The cost is real and worth stating plainly: the rich harness criteria are
roughly twenty times the size of the thin ones, on every routed message. If the
accuracy gain does not justify that, the answer is that cards are not worth
shipping — which is a result, not a failure.

## Cards are per harness and per family, never per model

omp reports 666 models. Writing 666 cards would be both absurd and wrong: most
of those rows are the same model wearing different routing clothes.
`modelFamilyKey` in [`lib/catalog.ts`](../lib/catalog.ts) already collapses the
vendor prefix, the context tag, the date suffix, and the effort suffix, so
`cursor/claude-4.6-opus-high` and `cursor/claude-4.6-opus-max` are one family.

Cards are written per family, and only for families that a routing pass can
actually reach: the 23 that survive the default 8-slot shortlist on at least
one harness, plus 3 Cursor families that do not survive but that a user may
name explicitly. 26 cards, against 464 distinct families across the hub.

`reachable_from` and `shortlisted_on` on each card are derived from
`catalog-snapshot.json`, not hand-typed, and the tests check them against it.
That matters: 14 of the 26 reachability claims were wrong when written by hand.

## Cost bands

The vocabulary is the three bands from the Eve router prototype — `cheap`,
`mid`, `frontier` — reused verbatim so the two experiments score against the
same words.

The band for a family is **derived**, never hand-typed. `bandForFamily` in
[`bands.ts`](./bands.ts) re-reads the plugin's own `PREFERENCE_RULES` name
heuristics as a price signal:

| band | names |
| --- | --- |
| `frontier` | `opus`, `fable`, `gpt-6` |
| `mid` | `sonnet`, `composer`, `grok-4` |
| `cheap` | `haiku`, `mini`, `flash`, `spark` |
| `unassigned` | everything else |

A family whose name matches nothing is `unassigned`. We do not guess. An
invented band would be indistinguishable from a measured one in the replay
report, which is the only number this dataset exists to produce.

Five families land there, all of them OpenAI's: `gpt-5.5`, `gpt-5.6-sol`,
`gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.6-sol-900k`. That is itself a finding —
**the band vocabulary does not cover the Codex roster at all.** Codex offers
one frontier family and four unpriced ones, so "route the trivial task to a
cheap model" has no answer on Codex. Any future pricing work should start
there.

## The eval set

44 cases, one JSON object per line:

```jsonc
{
  "id": "trap-009",
  "category": "harness-trap",
  "message": "Set up a hook so that every time I finish a turn it runs the formatter.",
  "gold_harness": "claude-code",
  "gold_band": "mid",
  "gold_family": "claude-sonnet-5",
  "notes": "HARNESS TRAP: hooks are a Claude Code harness feature. No other harness can satisfy this, regardless of model strength."
}
```

`notes` is required and carries the reason for the gold label. Without it a
disagreement in the replay report cannot be triaged into "the model was wrong"
versus "the gold was wrong".

| category | n | what it tests |
| --- | ---: | --- |
| `trivial` | 6 | Does routing go cheap when the work is genuinely small? |
| `implementation` | 10 | The ordinary middle. Does it stay off frontier? |
| `architecture` | 7 | Ambiguous, high-stakes. Does it go frontier when it should? |
| `research` | 7 | Recency, breadth, and very long context. |
| `harness-trap` | 10 | The harness is decided by tooling, not by model brand. |
| `edge` | 4 | No signal, explicitly named old model, explicit cost pressure. |

The traps are the point of the exercise. Each one is a message where the right
harness follows from a capability the display name does not mention — skills
and hooks and subagents only exist in Claude Code, sandboxed no-network
iteration is Codex's default posture, cross-session persistence is Hermes only,
cross-vendor comparison needs Pi or omp, and the editor index is Cursor's. They
resolve to six different harnesses.

Two cases deliberately name no `gold_family`, and each carries a
`no_gold_family` field saying why. Both reasons are checked against the
snapshot by the tests.

### Read the scores against this baseline

`claude-code` is the gold harness for 25 of 44 cases, because it genuinely is
the right answer most of the time. **A router that always answered
`claude-code` would score 57% on harness accuracy.** Any headline number below
that is worse than a constant, and the thin-vs-rich comparison is more
informative than either absolute score. Prefer the per-category tallies in the
report over the `all` row.

One case, `trap-005`, names `acp-cursor` as its gold harness, and Cursor
reported zero models on the captured machine — so it is dropped from the offer
set and neither pass can score it. That is intentional: it is there to catch a
router that invents a model for a harness that cannot run one.

## Running the replay

```sh
# Schema and catalog checks only. No API key, no network.
node scripts/replay-routing-eval.mjs --dry-run

# Both passes against Jev, writing datasets/replay-report.json.
TYPESAFE_API_KEY=… node scripts/replay-routing-eval.mjs

# A cheap smoke test first.
TYPESAFE_API_KEY=… node scripts/replay-routing-eval.mjs --limit=5
```

Without a key the script says so and falls back to validating the datasets;
it never fails silently and never writes a partial report. The key is read from
the environment at the point of use and is never written to the report, to
stdout, or to disk.

The script imports nothing from `lib/`. Production routing is untouched by this
experiment — wiring cards into `routeFirstMessage` is a separate decision, to be
made after there are numbers.

It fails closed if the catalog is empty. A zero-harness catalog would make every
subsequent "correct" score an artefact, so it refuses to score rather than
reporting a clean-looking zero.

## Known gaps in the data

Worth reading before trusting a number out of this set.

1. **The 8-slot shortlist is dominated by Gemini Flash.** `preferenceScore`
   adds its rules, and `gemini-3.x-flash` matches both `/gemini-3/` (+36) and
   `/flash/` (+25) for a total of 61 — which beats `opus` at 60. On omp, seven
   of the eight offered models are Flash or Flash Lite. **`composer-2.5`,
   `cursor-grok-4.6`, and `claude-4.6-opus` never reach the shortlist at all**,
   so `trap-003` — a user asking for `cursor/composer-2.5` by name — cannot be
   satisfied by routing today. Cards do not fix this; the shortlist does.
2. **Dotted and dashed versions are different families.** `modelFamilyKey` does
   not normalize `.` to `-`, so Pi's `claude-haiku-4.5` and Claude Code's
   `claude-haiku-4-5` collapse to different keys, as do `claude-opus-4.7` and
   `claude-opus-4-7`. This inflates the family count on OpenRouter-backed
   harnesses and splits cards that should be shared.
3. **Cursor reports no models.** The harness card exists and the three Cursor
   families are reachable through omp's `cursor/` namespace, but the Cursor
   harness itself is empty on the captured machine, presumably unauthenticated.
4. **The gold labels are one author's judgement.** They are argued in `notes`,
   not measured. A case where both passes disagree with the gold is at least as
   likely to be a bad gold as a bad route.
5. **One machine, one day.** The snapshot is a single capture. Model rosters
   move; re-capture before drawing a conclusion from a stale run.
