---
name: typesafe-router
description: How the TypeSafe Router plugin picks a thread's harness and model, and what it does and does not intercept. Read this when a message is held with "TypeSafe is selecting…", when starting a thread on the TypeSafe Router picker row, when routing needs configuring, or when a thread ends up on an unexpected harness.
---

# TypeSafe Router

This plugin answers one question, once per thread: which agent harness and
model should run this work? It answers it on the thread's **first message
only**, because BB fixes a thread's harness as soon as that thread runs.

## Starting a thread that gets routed

On the New Thread page, pick **TypeSafe Router** and its one model, **Choose
harness and model**. Write the message and press **Send** once. From there it is
the flow below: a wait card, then a confirmation card, then **Yep**.

**TypeSafe Router is not a harness.** It is a picker row that exists so Send can
be enabled before a harness has been chosen — BB will not enable Send without a
provider and a model, and routing cannot run until Send. It never runs a turn:
its bridge refuses `turn/start`, it is excluded from the catalog TypeSafe picks
from (so it can never be proposed), and a dispatch that would start a turn on it
is rejected with a message telling you to pick Codex or Claude and send again.

A thread that already sits on a real harness is unaffected by any of this; the
usual flow below is a proposal you can decline.

## What happens on a first message

1. The `message.dispatch` hook holds the message with a queued row reading
   "TypeSafe is selecting the right harness and model." Nothing is written to
   the timeline — a held dispatch is visible only on that queued card above the
   composer and on the thread's sidebar row.
2. Off the hook, the plugin reads this machine's live catalogs
   (`bb provider list --machine <id>` is the same data) and curates each
   harness to at most eight models.
3. TypeSafe (Jev) answers two sequential Choice questions: first the harness,
   then a model from that harness's curated list only.
4. The composer is replaced by a confirmation card. **Yep** locks it in;
   anything else lets the thread start on the harness it already had.
5. On confirm: if the harness is unchanged, the model is set on this thread and
   the held message proceeds. If the harness is different, the message moves to
   a new thread on that harness and this one is rejected and archived — BB
   cannot swap a running thread's harness. A thread started on the TypeSafe
   Router picker row always takes this second path.

After that, the harness is locked for the thread. The model can still be
changed the normal way.

## What it deliberately does not touch

- Follow-up messages, steers, and retries (only a `pending` thread is routed).
- Turns being joined (`join-turn`).
- Hidden background worker threads.
- Threads an agent or the system started (`startedOnBehalfOf`).
- Threads another plugin spawned.
- A queued row the user hits **Send now** on — core bypasses the hook by
  design, and the message goes out on the harness the thread already had. On a
  thread sitting on the TypeSafe Router picker row there is no such harness, so
  that bypass is rejected instead of started.

If the plugin is disabled or has no API key, every dispatch proceeds untouched —
with the one exception above: a thread on the TypeSafe Router picker row is
rejected, because releasing it would start a turn on a provider that cannot run
one.

## Configuration

```
bb plugin config typesafe-router set typesafeApiKey 'YOUR_KEY'   # secret
bb plugin config typesafe-router set enabled false          # stop routing
bb plugin reload typesafe-router
```

Without a key the plugin reports `needs-configuration` and blocks nothing on
threads that already have a real harness.

## Privacy

Only the first message's text is sent to TypeSafe, truncated to 4000
characters, along with the project name and the names and descriptions of the
harnesses and models being chosen between (BB catalog strings, not your
content). The repository, the timeline, and later messages are not sent.
