TypeSafe Router decides which agent harness and which model should run a
thread, at the one moment that decision is still open: the thread's first
message.

It holds that first message, reads the harnesses and models your machine
actually has, and asks TypeSafe (Jev) two questions — which harness, then which
model inside it. You get a card with the answer and a **Yep** button. Confirm
and the thread starts there; decline and it starts exactly where it would have.

Because BB fixes a thread's harness once the thread runs, confirming a
*different* harness moves your message to a new thread on that harness. The
model stays changeable either way.

Follow-ups, steers, retries, hidden worker threads, agent-started threads, and
other plugins' spawns are never intercepted. Without an API key the plugin
blocks nothing.
