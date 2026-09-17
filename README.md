# bb-plugin-typesafe-router

Picks the harness and model for a BB thread's **first message**, using
TypeSafe (Jev), and asks you to confirm before it locks them in.

A BB thread's harness is fixed once the thread runs. The first message is
therefore the only moment the choice is still open — so that is the only
moment this plugin acts. Everything else dispatches untouched.

## Starting a routed thread

On the New Thread page, pick **TypeSafe Router** and its one model,
**Choose harness and model**. Type the message and press **Send** once. The
composer is replaced by a wait card while TypeSafe decides, then by a
confirmation card; press **Yep** and the thread continues on the harness and
model it chose.

TypeSafe Router is a picker row, not a harness. BB will not enable Send until
a provider and a model are chosen, and routing cannot run before Send — so the
plugin registers one provider whose only job is to be selectable. It never runs
a turn: its bridge refuses `turn/start`, it is excluded from the catalog
TypeSafe chooses from, and any dispatch that would start a turn on it is
rejected with a message telling you to pick a real harness instead.

## How it works

`message.dispatch` is a checkpoint with a 10-second fail-closed budget, so the
hook itself only reads cheap state and answers. It holds the first message with
`{ action: "wait" }` and runs the expensive part off the hook:

1. Read this machine's live catalogs (`bb.sdk.providers.list` /
   `.models` for the thread's host — catalogs differ per machine, and one
   harness can offer 800+ models). Curate each harness to at most 8 models.
2. Two sequential TypeSafe Choice calls: **which harness**, then **which model
   inside that harness**. Hierarchical, because those are two different
   judgements and a flat 40-label question is neither.
3. Replace the composer with a confirmation card. **Yep** applies it.
4. Same harness → set the model on this thread and release the held message.
   Different harness → spawn a new thread on it carrying the same input, then
   reject and archive this one. A thread started on the picker row always takes
   this second path, since the picker row is never a candidate.

Then `experimental_hooks.recheck("message.dispatch")` asks core to re-decide
the held row.

## Layout

- `lib/provider.ts` — the picker row's id, model, and the one predicate that
  keeps it out of everything else. Pure.
- `lib/provider-bridge.ts` — the minimum bridge: handshake, one model, and a
  refusal for `turn/start`.
- `host.ts` — the `bb.host` artifact, which exists only to carry that bridge.
- `lib/catalog.ts` — curation. Pure; no network.
- `lib/policy.ts` — what to intercept and what to answer on a re-attempt. Pure.
- `lib/router.ts` — the two Choice calls, against an injectable client.
- `server.ts` — wiring: settings, the hook, the routing pass, RPC.
- `app.tsx` — the composer banner and the confirmation card.
- `skills/typesafe-router/SKILL.md` — what agents are told about routing.

## Setup

```
bb plugin install . --yes
bb plugin config typesafe-router set typesafeApiKey <key>
bb plugin reload typesafe-router
```

Without a key the plugin reports `needs-configuration` and blocks nothing on a
thread that already has a real harness. A thread started on **TypeSafe Router**
has nowhere to go, so its message is rejected with an explanation rather than
started on a provider that cannot run it.

`bb plugin config typesafe-router set enabled false` turns routing off. Removing
the plugin, or reverting this change, removes the picker row with it; threads
that were routed keep running, because they run on a real harness.

## Tests

```
npm test          # catalog curation, dispatch policy, the routing pass, the bridge
npx tsc --noEmit
bb plugin build
```

No test reaches the network: the catalog is passed in, the routing pass takes a
`SystemOneCaller` a fake satisfies, and the bridge is driven in-process through
the SDK's own JSON-RPC harness.

## Privacy

Only the first message's text is sent to TypeSafe, truncated to 4000
characters, along with the project name and the names and descriptions of the
harnesses and models on offer (BB catalog strings, not your content). Not the
repository, the timeline, or any later message.
