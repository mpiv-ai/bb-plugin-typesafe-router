// TypeSafe router — the surfaces routing needs while it holds a message, plus
// the settings section on the plugin's own page.
//
// A held dispatch is invisible in the timeline by design (a `wait` writes no
// thread event), so the only places a person can learn what is happening are
// the composer banner and, when a proposal is ready, the pending-interaction
// card that replaces the composer.
//
// The settings section is the third surface. BB already renders a form for the
// declared settings; this one exists because the useful question is "which of
// the harnesses ON THIS MACHINE may Jev pick from", and that list is live
// server state, not something a person should have to type provider ids to
// answer. The controls write plugin storage through RPC.

import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useComposerView,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract, RoutingView, SettingsState } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { SettingsControls } from "./components/settings-controls";

/** Must match CONFIRM_RENDERER_ID in server.ts. */
const CONFIRM_RENDERER_ID = "typesafe-confirm";
const ROUTING_CHANGED = "routing-changed";

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

/** The routing record for the thread this composer belongs to, kept current. */
function useRouting(threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [routing, setRouting] = useState<RoutingView | null>(null);
  const refetch = useCallback(() => {
    if (threadId === null) {
      setRouting(null);
      return;
    }
    rpc.call("routing_get", { threadId }).then(
      (result) => setRouting(result.routing),
      () => setRouting(null),
    );
  }, [rpc, threadId]);
  useEffect(refetch, [refetch]);
  // The channel carries every thread's routing changes; only ours matters here.
  useRealtime(
    ROUTING_CHANGED,
    useCallback(
      (payload: unknown) => {
        const signalled =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>).threadId
            : null;
        if (signalled === threadId) refetch();
      },
      [refetch, threadId],
    ),
  );
  return routing;
}

/**
 * The banner above the composer. It carries the one fact the confirm card
 * cannot: that the harness is now locked for this thread, and that the model
 * is not.
 */
function RoutingBanner() {
  const view = useComposerView();
  const navigate = useBbNavigate();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const routing = useRouting(threadId);

  // Once a proposal turns into a different harness the thread is finished;
  // move the reader to the thread that actually carries their message.
  useEffect(() => {
    if (routing?.phase === "redirected" && routing.replacementThreadId !== null) {
      navigate.toThread(routing.replacementThreadId);
    }
  }, [navigate, routing?.phase, routing?.replacementThreadId]);

  if (routing === null) return null;

  if (routing.phase === "selecting") {
    return (
      <Line icon="Spinner" spin>
        TypeSafe is selecting the right harness and model…
      </Line>
    );
  }
  if (routing.phase === "proposed") {
    return (
      <Line icon="Workflow">
        TypeSafe proposed{" "}
        <strong className="font-medium text-foreground">
          {asString(routing.providerName, "a harness")}
        </strong>{" "}
        · {asString(routing.modelName, "a model")}. Confirm below to start.
      </Line>
    );
  }
  if (routing.phase === "confirmed") {
    return (
      <Line icon="Lock">
        Harness locked to{" "}
        <strong className="font-medium text-foreground">
          {asString(routing.providerName, "the selected harness")}
        </strong>{" "}
        for this thread. The model ({asString(routing.modelName, "selected")}) can
        still be changed.
      </Line>
    );
  }
  if (routing.phase === "redirected") {
    return <Line icon="ArrowRight">Moving this message to its new thread…</Line>;
  }
  return null;
}

function Line({
  icon,
  spin = false,
  children,
}: {
  icon: string;
  spin?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Icon name={icon} className={spin ? "size-3.5 animate-spin" : "size-3.5"} />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/**
 * Replaces the composer while a proposal is pending. Submitting `accept: true`
 * locks the harness; anything else lets the thread start on the harness BB
 * had already chosen.
 */
function ConfirmCard({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const [pending, setPending] = useState(false);
  const payload =
    typeof interaction.payload === "object" &&
    interaction.payload !== null &&
    !Array.isArray(interaction.payload)
      ? (interaction.payload as Record<string, unknown>)
      : {};
  const providerName = asString(payload.providerName, "Unknown harness");
  const modelName = asString(payload.modelName, "default model");
  const keepsHarness = payload.keepsHarness === true;

  const answer = (accept: boolean) => {
    if (pending) return;
    setPending(true);
    const done = accept ? submit({ accept: true }) : cancel();
    done.catch(() => undefined).finally(() => setPending(false));
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Icon name="Workflow" className="size-4" />
        TypeSafe picked a harness and model
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Harness</dt>
        <dd className="text-foreground">{providerName}</dd>
        <dt className="text-muted-foreground">Model</dt>
        <dd className="text-foreground">{modelName}</dd>
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        {keepsHarness
          ? "The harness is locked for this thread once it starts. The model can still be changed later."
          : "This is a different harness than the thread was created with, so your message moves to a new thread. The harness is locked there; the model can still be changed."}
      </p>
      <div className="mt-4 flex items-center gap-2">
        <Button onClick={() => answer(true)} disabled={pending}>
          Yep
        </Button>
        <Button variant="ghost" onClick={() => answer(false)} disabled={pending}>
          Keep what I had
        </Button>
      </div>
    </div>
  );
}

/**
 * The plugin's settings section. Reads and writes only through RPC, so the
 * preferences stay in plugin storage.
 */
function SettingsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<SettingsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const absorb = useCallback((next: SettingsState) => {
    setState(next);
    setError(null);
  }, []);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  useEffect(() => {
    rpc.call("settings_state").then(absorb, report);
  }, [rpc, absorb, report]);

  const apply = useCallback(
    (run: () => Promise<SettingsState>) => {
      setBusy(true);
      run()
        .then(absorb, report)
        .finally(() => setBusy(false));
    },
    [absorb, report],
  );

  if (state === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {error ?? "Loading routing preferences…"}
      </p>
    );
  }

  return <SettingsControls state={state} busy={busy} error={error}
    onEnabled={enabled => apply(() => rpc.call("settings_update", { enabled }))}
    onHarness={(providerId, allowed) => apply(() => rpc.call("settings_set_harness", { providerId, allowed }))}
  />;
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "typesafe-routing-banner",
    scopes: ["thread"],
    banners: [{ id: "routing-status", chrome: "bare", component: RoutingBanner }],
  });
  app.slots.pendingInteraction({
    id: CONFIRM_RENDERER_ID,
    component: ConfirmCard,
  });
  // Renders on this plugin's page under Settings, beside the declared settings.
  app.slots.settingsSection({
    id: "routing-preferences",
    title: "Routing preferences",
    description:
      "Choose which available harnesses TypeSafe may use.",
    component: SettingsPanel,
  });
});
