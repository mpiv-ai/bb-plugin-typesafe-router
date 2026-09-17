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
// answer. Every control writes the same settings the CLI writes.

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
import {
  CURATION_MODES,
  CURATION_MODE_HINTS,
  CURATION_MODE_LABELS,
  MAX_MODELS_CEILING,
  MIN_MODELS_PER_HARNESS,
  type CurationMode,
} from "./lib/preferences";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

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

/** One labelled control row, in the idiom BB's own settings rows use. */
function Field({
  label,
  hint,
  control,
}: {
  label: string;
  hint?: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{label}</div>
        {hint === undefined ? null : (
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        )}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

/**
 * The plugin's settings section. Reads and writes only through RPC, so the
 * stored settings stay the single source of truth and `bb plugin config` sees
 * every change this page makes.
 */
function SettingsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<SettingsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLists, setShowLists] = useState(false);
  // Text drafts, so typing does not round-trip a write per keystroke.
  const [maxDraft, setMaxDraft] = useState("");
  const [includeDraft, setIncludeDraft] = useState("");
  const [excludeDraft, setExcludeDraft] = useState("");

  const absorb = useCallback((next: SettingsState) => {
    setState(next);
    setError(null);
    setMaxDraft(String(next.maxModelsPerHarness));
    setIncludeDraft(next.includeHarnesses);
    setExcludeDraft(next.excludeHarnesses);
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

  const update = (patch: Parameters<typeof rpc.call<"settings_update">>[1]) => {
    apply(() => rpc.call("settings_update", patch));
  };
  const commitMax = () => {
    const parsed = Number.parseInt(maxDraft, 10);
    if (Number.isNaN(parsed) || parsed === state.maxModelsPerHarness) {
      setMaxDraft(String(state.maxModelsPerHarness));
      return;
    }
    update({ maxModelsPerHarness: parsed });
  };
  const usable = state.harnesses.filter((harness) => harness.available);
  const allowedCount = usable.filter((harness) => harness.allowed).length;

  return (
    <div className="flex flex-col gap-5">
      {state.hasApiKey ? null : (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          No TypeSafe API key yet, so nothing is being routed. Set it in the
          settings above, or with{" "}
          <code>bb plugin config typesafe-router set typesafeApiKey &lt;key&gt;</code>.
        </p>
      )}

      <div className="divide-y divide-border">
        <Field
          label="Route first messages"
          hint="Off leaves every thread on the harness it was created with."
          control={
            <Switch
              checked={state.enabled}
              disabled={busy}
              aria-label="Route first messages"
              onCheckedChange={(checked) => update({ enabled: checked })}
            />
          }
        />
        <Field
          label="Models offered per harness"
          hint={`How many models from each harness Jev chooses between (${MIN_MODELS_PER_HARNESS}–${MAX_MODELS_CEILING}).`}
          control={
            <Input
              type="number"
              className="w-20 text-right"
              min={MIN_MODELS_PER_HARNESS}
              max={MAX_MODELS_CEILING}
              value={maxDraft}
              disabled={busy}
              aria-label="Models offered per harness"
              onChange={(event) => setMaxDraft(event.target.value)}
              onBlur={commitMax}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          }
        />
      </div>

      <div>
        <div className="text-sm text-foreground">How to trim an oversized harness</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {CURATION_MODE_HINTS[state.curationMode as CurationMode] ??
            CURATION_MODE_HINTS.weighted}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {CURATION_MODES.map((mode) => (
            <Button
              key={mode}
              size="sm"
              variant={state.curationMode === mode ? "default" : "outline"}
              disabled={busy}
              aria-pressed={state.curationMode === mode}
              onClick={() => update({ curationMode: mode })}
            >
              {CURATION_MODE_LABELS[mode]}
            </Button>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-sm text-foreground">Harnesses Jev may choose from</div>
          <span className="text-xs text-muted-foreground">
            {allowedCount} of {usable.length} on
          </span>
        </div>
        {state.harnessError !== null ? (
          <p className="mt-2 text-xs text-destructive">
            Could not read this machine's harnesses ({state.harnessError}). The
            lists below still work.
          </p>
        ) : usable.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            No harness on this machine can run a turn yet. Install and sign in to
            one, and it will appear here.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card px-3">
            {usable.map((harness) => (
              <li
                key={harness.id}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-foreground">
                    {harness.displayName}
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">
                    {harness.id}
                  </div>
                </div>
                <Switch
                  checked={harness.allowed}
                  disabled={busy}
                  aria-label={`Let TypeSafe choose ${harness.displayName}`}
                  onCheckedChange={(checked) => {
                    apply(() =>
                      rpc.call("settings_set_harness", {
                        providerId: harness.id,
                        allowed: checked,
                      }),
                    );
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        {allowedCount === 0 && usable.length > 0 ? (
          <p className="mt-2 text-xs text-destructive">
            Nothing is left to route to. A first message will be refused with an
            explanation until you switch a harness back on.
          </p>
        ) : null}
      </div>

      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 text-muted-foreground"
          onClick={() => setShowLists((open) => !open)}
        >
          <Icon
            name={showLists ? "ChevronDown" : "ChevronRight"}
            className="size-3.5"
          />
          Edit the lists directly
        </Button>
        {showLists ? (
          <div className="mt-2 flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              One provider id per line; <code>#</code> starts a comment. The
              include list empty means every available harness. Toggling a
              harness above rewrites the exclude list.
            </p>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Only these harnesses
              <Textarea
                rows={3}
                className="font-mono text-xs"
                value={includeDraft}
                disabled={busy}
                onChange={(event) => setIncludeDraft(event.target.value)}
                onBlur={() => {
                  if (includeDraft !== state.includeHarnesses) {
                    update({ includeHarnesses: includeDraft });
                  }
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Never these harnesses
              <Textarea
                rows={3}
                className="font-mono text-xs"
                value={excludeDraft}
                disabled={busy}
                onChange={(event) => setExcludeDraft(event.target.value)}
                onBlur={() => {
                  if (excludeDraft !== state.excludeHarnesses) {
                    update({ excludeHarnesses: excludeDraft });
                  }
                }}
              />
            </label>
          </div>
        ) : null}
      </div>

      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
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
      "Which of this machine's harnesses TypeSafe may choose from, and how much of each catalog it sees.",
    component: SettingsPanel,
  });
});
