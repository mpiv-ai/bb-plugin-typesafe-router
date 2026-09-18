# Execution settings

A proposal replaces the harness and the model. Everything else the user set on
the New Thread page — reasoning effort, service tier (fast mode), permission
mode — is theirs, and should follow the message to the thread that runs it.
This page is how that happens and why some values are dropped on the way.

## What the picker row offers

The picker row's one model, `route`, is not a model, so the options it
advertises are not for the row itself — they exist so the New Thread page can
*express* a choice that will be carried. `lib/provider.ts` and the
`bb.providers.register` call in `server.ts` declare:

| Option | Offered | Note |
| --- | --- | --- |
| Reasoning effort | `low`, `medium`, `high`, `xhigh`, `max`; default `medium` | The union of what real harnesses commonly offer. Rounded to the chosen model's ladder on confirm. |
| Permission mode | `accept-edits`, `auto`, `full` | Core resolves the product default (`auto`) when the user does not pick. |
| Service tier | `default`, `fast` | Carried only onto a harness that supports tiers. |

Before this, the row offered exactly `medium` and `full`, which meant every
routed thread started at core's defaults regardless of what the user wanted —
and, had `full` been carried, every routed thread would have run with
approvals bypassed.

## What core tells the hook

`ctx.requestedExecution` carries the values core has resolved for the dispatch
(`providerId`, `model`, `reasoningLevel`, `serviceTier`, `permissionMode`), and
`ctx.executionSources` says where each came from:

| Source | Meaning |
| --- | --- |
| `"explicit"` | The user chose it on the New Thread page. |
| `"client-preference"` | A remembered client default. |
| `null` | Core resolved it from project or provider defaults. |

The distinction is what lets the plugin honour a deliberate choice and stay
out of the way of a default.

## The carry

`carryExecution(requested, sources, model, harness)` in `lib/execution.ts` is
pure. `server.ts` calls it once in `apply()` with the live facts and spreads
the result into `bb.sdk.threads.spawn` (or, on the same-harness path, passes
its effort to `bb.sdk.threads.update`).

```ts
interface CarriedExecution {
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  permissionMode?: PermissionMode;
  executionInputSources: Partial<Record<"reasoningLevel" | "serviceTier" | "permissionMode", ExecutionSource>>;
}
```

A field that is absent from the result is simply not sent, and core resolves
its own default exactly as it did before this plugin existed. The rules per
field:

**Reasoning effort.** Carried when the model's ladder is known and the request
names a level. If the level is on the ladder it is carried as-is; otherwise
`nearestReasoningLevel()` picks the closest rung by position on BB's ladder
(`none < low < medium < high < xhigh < max < ultra < ultracode`), rounding
ties *up* — a request past the top of a ladder means "as much as it has", so
`max` onto a Codex model becomes `xhigh`. The source is passed through
unchanged: a clamped explicit choice is still explicit. An unknown ladder
carries nothing rather than risk a value the spawn would reject.

**Service tier.** Carried only when the harness lists that tier. `serviceTiers`
on a catalog harness is empty when the provider does not support tiers, or the
provider's own descriptor list when it does.

**Permission mode.** The one field never carried from a default. It is carried
only when the source is `explicit` or `client-preference` *and* the harness
runs in that mode. A `null` source is dropped even if the harness supports the
mode: otherwise the picker row's own default would decide how much a real
harness may do, and the machine's permission ceiling is core's to apply.

## The effort the router proposed

When the routing pass proposes an effort (or the user changes it on the
confirmation card), `apply()` feeds `carryExecution` a request with that level
and a source of `"explicit"`. It counts as explicit because it is what the card
showed and what the user confirmed. It still goes through the same rounding,
so a card cannot pick a rung the model lacks (the server also validates the
card's answer against the ladder before it gets this far).

The effort shown on the New Thread page is not used to skip the router's
effort call: BB reports it as `explicit` whether the user touched it or not
(see [The routing pass](routing-pass.md)). It still matters to `carryExecution`
when no effort was routed — a model with an unknown ladder — where the
picker's value is carried as a value and its source passed through.

## Provenance

`executionInputSources` is forwarded to `threads.spawn` so core records a
carried user choice as a choice rather than a default. Values that were
defaulted on the placeholder thread are carried as values but not as choices
(no source entry).

The harness and model are **always** marked `explicit` in it. Core drops a
requested `providerId` or `model` that carries no source and re-derives it
from the project's stored defaults — and for a thread that started on the
picker row, the stored default *is* the picker row. Sending
`executionInputSources` without those two entries made every routed spawn
land back on the picker row, where the hook rejected it. The rule lives in
`carryExecution`, so no caller can assemble a spawn without it.

## Limits

- **Per-message effort on an existing thread is not possible from a hook.**
  `message.dispatch` can only proceed, wait, or reject; it cannot amend the
  message it is inspecting. `threads.update({ reasoningLevel })` sets a sticky
  level for the *next* turn, and a queued row stores its own level, so a
  hold-update-recheck sequence would most likely release the message at the
  old level. This would need an amendment arm in BB core.
- **Service tier cannot be changed after creation** through the plugin SDK:
  `threads.update` has no `serviceTier` field. It is set at spawn or not at all.
- **The ladder the picker row offers is a guess at the union.** A harness that
  offers `none`, `ultra`, or `ultracode` can still be routed to; the user just
  cannot pre-select those from the picker row. The router's own effort call
  can choose any rung the model has.
