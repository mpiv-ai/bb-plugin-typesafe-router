import type { SettingsState } from "../server";
import { Switch } from "./ui/switch";

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

export function SettingsControls({ state, busy, error, onEnabled, onHarness }: {
  state: SettingsState;
  busy: boolean;
  error: string | null;
  onEnabled: (enabled: boolean) => void;
  onHarness: (providerId: string, allowed: boolean) => void;
}) {
  const usable = state.harnesses.filter((harness) => harness.available);
  const allowedCount = usable.filter((harness) => harness.allowed).length;

  return (
    <div className="flex flex-col gap-5">
      {state.hasApiKey ? null : (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          No TypeSafe API key yet, so nothing is being routed. Set it in the
          API key field above.
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
              onCheckedChange={(checked) => onEnabled(checked)}
            />
          }
        />
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
            Could not read this machine's harnesses ({state.harnessError}). Try reopening settings after the connection recovers.
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
                  onCheckedChange={(checked) => onHarness(harness.id, checked)}
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

      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
