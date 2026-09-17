# TypeSafe Router

A BB plugin that picks the harness and model for a thread's **first message**,
using TypeSafe (Jev), and asks you to confirm before it locks them in.

BB fixes a thread's harness once the thread runs. The first message is the only
moment that choice is still open, so that is the only moment this plugin acts.
Follow-ups, steers, retries, and background threads dispatch untouched.

## Requirements

- **BB** `>= 0.43` with Plugin SDK `>= 0.4.87`. These are the `engines` in
  [`package.json`](package.json); BB refuses to install the plugin on an older
  runtime.
- **A TypeSafe account and API key** from <https://console.typesafe.ai>. This
  plugin does not ship a key and cannot route without one.
- **At least one real agent harness already working on that machine** — Codex,
  Claude Code, or another BB provider you have already used successfully. The
  TypeSafe Router picker row is not a harness and cannot run a turn; it exists
  only so BB will enable **Send** before a harness has been chosen.

Catalogs are **per machine**. TypeSafe only chooses among the harnesses and
models that the thread's machine actually has, so a machine with one harness
installed will keep being routed to that harness.

## Install

```
bb plugin install git:https://github.com/mpiv-ai/bb-plugin-typesafe-router@v0.1.0 --yes
bb plugin config typesafe-router set typesafeApiKey 'YOUR_KEY'
bb plugin reload typesafe-router
```

Quote the key — API keys can contain characters your shell would otherwise
interpret.

Without a key the plugin reports `needs-configuration` and blocks nothing on a
thread that already has a real harness.

## First use

1. **New Thread** → pick **TypeSafe Router** as the provider.
2. Pick its one model, **Choose harness and model**.
3. Type your message and press **Send** *once*.
4. The composer is replaced by a wait card reading "TypeSafe is selecting the
   right harness and model." Nothing is written to the timeline yet.
5. A confirmation card appears with the harness and model TypeSafe chose. Press
   **Yep** and the thread continues there. **Keep what I had** declines.

Because BB cannot swap a running thread's harness, confirming moves your
message to a new thread on the chosen harness. A thread started on the picker
row always takes that path, since the picker row is never a candidate. Once the
thread starts, the harness is locked; the model can still be changed normally.

## Configuration

```
bb plugin config typesafe-router set typesafeApiKey 'YOUR_KEY'   # secret
bb plugin config typesafe-router set enabled false               # stop routing
bb plugin reload typesafe-router
```

Removing the plugin removes the picker row with it. Threads that were already
routed keep running, because they run on a real harness.

## Privacy

Only the first message's text is sent to TypeSafe, truncated to 4000
characters, along with the project name and the **names and descriptions** of
the harnesses and models being chosen between — BB catalog strings, not your
content. The repository, the timeline, and later messages are not sent.

## Troubleshooting

**"TypeSafe Router chooses a harness; it cannot run a turn itself."** The thread
is sitting on the TypeSafe Router picker row and routing did not produce a
runnable harness — the message says why in parentheses: usually no API key,
routing disabled, or you declined the proposal. It also happens if you hit
**Send now** on the queued row; Send now is a core bypass that skips the hook by
design, and on a picker-row thread there is no harness to fall back to, so the
message is rejected instead of started. Set the key and reload, or pick Codex
or Claude in the composer and send again.

**The plugin reports `needs-configuration`.** No API key is set. Run the
`bb plugin config ... set typesafeApiKey` command above, then
`bb plugin reload typesafe-router`.

**TypeSafe keeps choosing the same harness.** Catalogs are per machine, and the
picker row is excluded from them. If that machine only has one real harness
installed, that is the only candidate.

**Send is disabled on the New Thread page.** BB needs both a provider and a
model. Pick **TypeSafe Router** *and* its **Choose harness and model** row.

**Nothing is held at all.** Only a `pending` thread's first message is routed.
Follow-ups, steers, retries, joined turns, hidden worker threads, threads
started by an agent or the system, and threads another plugin spawned are never
intercepted.

## How it works

`message.dispatch` is a checkpoint with a 10-second fail-closed budget, so the
hook itself only reads cheap state and answers. It holds the first message with
`{ action: "wait" }` and runs the expensive part off the hook:

1. Read this machine's live catalogs (`bb.sdk.providers.list` / `.models` for
   the thread's host — catalogs differ per machine, and one harness can offer
   800+ models). Curate each harness to at most 8 models.
2. Two sequential TypeSafe Choice calls: **which harness**, then **which model
   inside that harness**. Hierarchical, because those are two different
   judgements and a flat 40-label question is neither.
3. Replace the composer with a confirmation card. **Yep** applies it.
4. Same harness → set the model on this thread and release the held message.
   Different harness → spawn a new thread on it carrying the same input, then
   reject and archive this one.

Then `experimental_hooks.recheck("message.dispatch")` asks core to re-decide the
held row.

The picker row never runs a turn: its bridge refuses `turn/start`, it is
excluded from the catalog TypeSafe chooses from, and any dispatch that would
start a turn on it is rejected with a message telling you to pick a real
harness instead.

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local development loop, and
[CONTRIBUTORS.md](CONTRIBUTORS.md) for authorship.

## License

MIT — see [LICENSE](LICENSE).
