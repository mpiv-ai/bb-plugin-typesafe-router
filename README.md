# bb-plugin-typesafe-router

Picks the harness and model for a BB thread's **first message**, using
TypeSafe (Jev), and asks you to confirm before it locks them in.

A BB thread's harness is fixed once the thread runs. The first message is
therefore the only moment the choice is still open — so that is the only
moment this plugin acts. Everything else dispatches untouched.

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
   reject and archive this one.

Then `experimental_hooks.recheck("message.dispatch")` asks core to re-decide
the held row.

## Layout

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

Without a key the plugin reports `needs-configuration` and blocks nothing.
`bb plugin config typesafe-router set enabled false` turns routing off.

## Tests

```
npm test          # catalog curation, dispatch policy, and the routing pass
npx tsc --noEmit
bb plugin build
```

No test reaches the network: the catalog is passed in, and the routing pass
takes a `SystemOneCaller` a fake satisfies.

## Privacy

Only the first message's text is sent to TypeSafe, truncated to 4000
characters, along with the project name and the names and descriptions of the
harnesses and models on offer (BB catalog strings, not your content). Not the
repository, the timeline, or any later message.
