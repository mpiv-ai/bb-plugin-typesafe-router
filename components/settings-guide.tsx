// The user guide on the plugin's settings page. Rendered with BB's own
// Markdown component so it reads like the rest of the app and needs no
// vendored typography. Kept beside the switches it explains; the full
// reference lives in the repository's docs/.

import { Markdown } from "@get-bb/plugin-sdk/app";

const REPO = "https://github.com/mpiv-ai/bb-plugin-typesafe-router";

export const SETTINGS_GUIDE = `
TypeSafe Router picks the **harness**, **model**, and **reasoning effort** for a thread's first message, then asks you to confirm before anything runs. After that first message the harness is fixed for the thread; the model and effort can still be changed in the composer as usual.

### Start a routed thread

1. **New Thread** → choose **TypeSafe Router** as the provider and its one model, **Choose harness and model**.
2. Write your message and press **Send** once. A line above the composer reads "TypeSafe is selecting the right harness and model…". Nothing is written to the timeline yet.
3. A card replaces the composer with the proposed harness, model, and effort. Change the effort there if you want. **Yep** starts the work; **Keep what I had** declines.

BB cannot change a running thread's harness, so confirming moves your message to a new thread on the chosen harness and takes you there. The placeholder thread is archived.

### What follows your message

The permission mode and fast mode you set on the New Thread page follow the message to the new thread wherever the chosen harness supports them. The effort shown on the New Thread page is not used: TypeSafe proposes one for the chosen model, and the card is where you override it.

### What is never routed

Only a thread's first message is routed. Follow-ups, steers, retries, hidden background threads, and threads an agent or another plugin started are never touched. A first message on a thread you started directly on Codex or Claude still gets a proposal; declining keeps what you had.

### The settings on this page

- **TypeSafe API key** — required. Without it nothing is routed, and a thread started on the TypeSafe Router row cannot run at all.
- **Route first messages** — the master switch. Off, every message proceeds untouched.
- **Harness switches** — which of the harnesses installed and signed in on this machine TypeSafe may choose from. Switching them all off blocks routed threads rather than guessing.

Changes apply to the next first message; no reload is needed.

### If something looks wrong

- **"TypeSafe Router chooses a harness; it cannot run a turn itself."** The thread is on the picker row and routing did not produce a harness. The reason is in parentheses: no API key, routing switched off, you declined, or **Send now** on the queued row, which skips routing. Start a new thread, or pick Codex or Claude in the composer and send again.
- **The same harness every time.** Only harnesses on this machine are candidates, and only those switched on above.
- **Send is disabled on New Thread.** Pick both the provider and its model row.

### Privacy

Only the first message (up to 4,000 characters), the project name, and descriptions of the candidate harnesses and models go to TypeSafe. The repository, the timeline, and later messages stay here.

Full documentation: [README](${REPO}#readme) · [How it works](${REPO}/tree/main/docs)
`.trim();

export function SettingsGuide() {
  return <Markdown content={SETTINGS_GUIDE} className="text-sm" />;
}
