# TypeSafe Router — how it works

These pages explain the plugin from the inside: what each piece is for, what
happens between **Send** and the first turn, and where the invariants live.
The [README](../README.md) covers install, first use, and troubleshooting;
start there if you have not used the plugin yet.

| Page | Read it when you want to know |
| --- | --- |
| [Architecture](architecture.md) | What the pieces are, how a first message travels through them, and the three rules everything else rests on. |
| [Dispatch and state](dispatch-and-state.md) | How the `message.dispatch` hook decides, the routing record's state machine, and what happens on restart, timeout, or failure. |
| [The routing pass](routing-pass.md) | How the catalog is built and curated, what the three TypeSafe Choice calls ask, what they are shown, and how a bad answer falls back. |
| [Execution settings](execution-settings.md) | How effort, fast mode, and permission chosen before Send reach the thread that runs, and why some values are dropped. |
| [Configuration and UI](configuration-and-ui.md) | Settings, the preference store and its one-time migration, the RPC contract, the realtime channel, and the three UI surfaces. |
| [Development](development.md) | Layout, the test suite, the eval replay, building, running a checkout in BB, and the traps we have already hit. |

Reading order for a first pass: Architecture → Dispatch and state → The
routing pass. The rest are reference.

## One-paragraph version

BB fixes a thread's harness the moment the thread runs, so the only time a
harness can be chosen for it is its first message. This plugin registers a
picker row called **TypeSafe Router** so a New Thread can be sent without a
harness, holds that first message with the `message.dispatch` hook, asks
TypeSafe (Jev) three questions — which harness, which model in it, how much
effort — shows the answer on a confirmation card, and on **Yep** spawns a new
thread on the chosen harness carrying the same message and the user's
execution settings. The picker row never runs a turn; every path that could
release a message onto it is closed.
