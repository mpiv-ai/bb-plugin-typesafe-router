TypeSafe Router decides which agent harness, which model, and how much
reasoning effort should run a thread, at the one moment that decision is still
open: the thread's first message. It acts only when you ask — by picking
**TypeSafe Router** on the New Thread page. Threads you start directly on a
harness are never touched.

It holds that first message, reads the harnesses and models your machine
actually has, and asks TypeSafe (Jev) three questions — which harness, which
model inside it, and how much effort. You get a card with the answer and a
**Yep** button; the effort is editable there. Confirm and your message starts
on that harness; cancel and nothing runs.

**Using it.** On the New Thread page, pick **TypeSafe Router** and its one
model, **Choose harness and model**, then send once. A wait card appears while
TypeSafe decides, then the confirmation card. TypeSafe Router is a picker row,
not a harness — it exists so BB will enable Send before a harness is chosen, and
it never runs a turn.

Because BB fixes a thread's harness once the thread runs, confirming moves your
message to a new thread on the chosen harness, along with the permission and
fast-mode choices you made. The model and effort stay changeable there.

Threads started on a real harness, follow-ups, steers, retries, hidden worker
threads, agent-started threads, and other plugins' spawns are never intercepted.

**Tuning it.** The plugin's page under Settings has a **Routing preferences**
section that lists the harnesses this machine actually has as switches — turn
one off and it stops being offered, without typing a provider id anywhere. The
section has only a routing switch and live harness switches. The automatic
form contains only the secret API key. Models are ranked by a local task-axis
classifier and a vendored public-eval snapshot, capped at eight. Capability
cards describe the candidates in the harness and model calls. A **How routing
works** section under the switches is the short guide.

**Requirements.** BB `>= 0.43` with Plugin SDK `>= 0.4.87`, a TypeSafe API key
from <https://console.typesafe.ai> (this plugin ships no key), and at least one
real harness already working on that machine. Catalogs are per machine, so
TypeSafe only chooses among the harnesses that machine actually has.

**Install.**

```
bb plugin install git:https://github.com/mpiv-ai/bb-plugin-typesafe-router@v0.1.0 --yes
bb plugin config typesafe-router set typesafeApiKey 'YOUR_KEY'
bb plugin reload typesafe-router
```

**Privacy.** Only the first message's text is sent to TypeSafe, truncated to
4000 characters, along with the project name and the names and descriptions of
the harnesses and models being chosen between — BB catalog strings, not your
content. The repository, the timeline, and later messages are not sent.
