// TypeSafe router — decides the harness and model for a thread's FIRST message.
//
// Shape of the thing: `message.dispatch` is a checkpoint with a 10-second
// fail-closed budget, so the hook itself only ever reads cheap state and
// answers. The expensive part — two TypeSafe Choice calls plus a user
// confirmation — runs off the hook as a background pass, and asks core to
// re-decide with `experimental_hooks.recheck` when it finishes.
//
// A BB thread's harness is fixed once it runs. So a proposal that keeps the
// harness only updates the model in place, while a proposal that changes it
// has to start a new thread carrying the same input and retire this one.
//
// The plugin also registers a picker stub (`lib/provider.ts`) so a new thread
// can be sent without choosing a harness first. The stub is excluded from the
// catalog TypeSafe chooses from, so in practice every proposal changes the
// harness and every routed thread is a spawn.

import {
  defineRpcContract,
  type BbPluginApi,
  type MessageDispatchHookContext,
} from "@get-bb/plugin-sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { z } from "zod";
import {
  buildCatalog,
  isHarnessAllowed,
  type CatalogHarness,
  type CatalogModel,
  type CatalogProvider,
} from "./lib/catalog.js";
import { carryExecution, isServiceTier, type ReasoningLevel } from "./lib/execution.js";
import {
  emptyCatalogDetail,
  preferenceSignature,
  readPreferences,
  withHarnessAllowed,
  type RouterPreferences,
} from "./lib/preferences.js";
import {
  decideDispatch,
  parseRoutingRecord,
  type RoutingPhase,
  type RoutingRecord,
} from "./lib/policy.js";
import {
  isRoutableProviderId,
  STUB_MODEL,
  STUB_PROVIDER_DISPLAY_NAME,
  STUB_PROVIDER_ID,
  STUB_REASONING_LEVELS,
} from "./lib/provider.js";
import { createPreferenceStore } from "./lib/preference-store.js";
import { routeFirstMessage } from "./lib/router.js";

/** Realtime channel the composer banner listens on. */
const ROUTING_CHANGED = "routing-changed";
/** Must match the `pendingInteraction` registration id in app.tsx. */
const CONFIRM_RENDERER_ID = "typesafe-confirm";
/** How long the confirmation card stays up before the thread proceeds as-is. */
const CONFIRM_TIMEOUT_MS = 10 * 60_000;
/** Provider catalogs change on install/auth, not per message. */
const CATALOG_TTL_MS = 60_000;

const routingViewSchema = z.object({
  phase: z.enum([
    "selecting",
    "proposed",
    "confirmed",
    "redirected",
    "skipped",
    "failed",
  ]),
  providerId: z.string().nullable(),
  providerName: z.string().nullable(),
  model: z.string().nullable(),
  modelName: z.string().nullable(),
  replacementThreadId: z.string().nullable(),
  detail: z.string().nullable(),
});

/** One harness as the settings page lists it: live from `providers.list`. */
const harnessRowSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  /** Installed and signed in on this machine. */
  available: z.boolean(),
  /** Whether the current include/exclude settings let routing offer it. */
  allowed: z.boolean(),
});

/** Everything the settings section renders. Never carries the API key itself. */
const settingsStateSchema = z.object({
  enabled: z.boolean(),
  hasApiKey: z.boolean(),
  harnesses: z.array(harnessRowSchema),
  /** Null unless the live harness list could not be read. */
  harnessError: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  routing_get: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ routing: routingViewSchema.nullable() }),
  },
  settings_state: {
    input: z.null(),
    output: settingsStateSchema,
  },
  settings_update: {
    input: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict(),
    output: settingsStateSchema,
  },
  settings_set_harness: {
    input: z.object({ providerId: z.string().min(1), allowed: z.boolean() }).strict(),
    output: settingsStateSchema,
  },
});

export type RoutingView = z.infer<typeof routingViewSchema>;
export type SettingsState = z.infer<typeof settingsStateSchema>;
export type HarnessRow = z.infer<typeof harnessRowSchema>;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    typesafeApiKey: {
      type: "string",
      label: "TypeSafe API key",
      description: "Used for the two Choice calls that pick a harness and model.",
      secret: true,
    },
  });
  const preferenceStore = await createPreferenceStore(bb);

  // The picker row. Registered unconditionally — without it the New Thread page
  // has no selectable harness for a user who wants TypeSafe to decide, and Send
  // stays disabled. It runs nothing; see lib/provider-bridge.ts.
  bb.providers.register({
    id: STUB_PROVIDER_ID,
    displayName: STUB_PROVIDER_DISPLAY_NAME,
    icon: "Workflow",
    experimental_visibility: "always",
    // Nothing host-local to probe, install, or meter.
    maintenance: { health: false, usage: false, installation: false },
    strings: {
      signInHint:
        "Nothing to sign in to. TypeSafe Router only picks the harness; that harness handles its own sign-in.",
      expiredHint:
        "Nothing to renew. TypeSafe Router only picks the harness; that harness handles its own sign-in.",
      installUrl: "https://github.com/mpiv-ai/bb-plugin-typesafe-router",
    },
    // Effort, tier, and permission are offered here so a choice made on the
    // New Thread page can follow the message to the harness that runs it;
    // the router itself uses none of them.
    capabilities: {
      supportsServiceTier: true,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: [...STUB_REASONING_LEVELS],
    },
    serviceTiers: [
      { id: "default", label: "Default" },
      { id: "fast", label: "Fast" },
    ],
    composerActions: [],
    // One model, always the default, so picking the provider is the whole choice.
    models: { fallback: [STUB_MODEL], scope: "host" },
  });

  const initial = await settings.get();
  if (!initial.typesafeApiKey) {
    // Not an error: without a key the hook proceeds on every dispatch, so the
    // only consequence of an unconfigured plugin is that nothing is routed.
    bb.status.needsConfiguration(
      "Set the TypeSafe API key with `bb plugin config typesafe-router set typesafeApiKey <key>`, then reload.",
    );
  }

  // Display names for the UI, keyed by thread. Metadata carries the durable
  // ids; this carries what a person should read.
  const displayNames = new Map<string, { provider: string; model: string }>();
  // Threads with a pass already in flight, so a re-attempt during the pass
  // does not start a second one.
  const inFlight = new Set<string>();

  async function readRouting(threadId: string): Promise<RoutingRecord | null> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId });
    return parseRoutingRecord((metadata as Record<string, unknown>).routing);
  }

  async function writeRouting(
    threadId: string,
    patch: Omit<RoutingRecord, "updatedAt">,
  ): Promise<void> {
    await bb.sdk.threads.updatePluginMetadata({
      threadId,
      set: { routing: { ...patch, updatedAt: Date.now() } },
    });
    bb.realtime.publish(ROUTING_CHANGED, { threadId, phase: patch.phase });
  }

  function view(threadId: string, record: RoutingRecord | null): RoutingView | null {
    if (record === null) return null;
    const names = displayNames.get(threadId);
    return {
      phase: record.phase,
      providerId: record.providerId,
      providerName: names?.provider ?? record.providerId,
      model: record.model,
      modelName: names?.model ?? record.model,
      replacementThreadId: record.replacementThreadId,
      detail: record.detail,
    };
  }

  // ---- settings page -----------------------------------------------------

  /**
   * The harnesses this machine actually has, each marked with whether the
   * current settings let routing offer it. Live every time: a harness installed
   * or signed in since the page opened should appear on the next read.
   */
  async function readSettingsState(): Promise<SettingsState> {
    const current = await settings.get();
    const stored = await preferenceStore.get();
    const preferences = readPreferences(stored);
    let harnesses: HarnessRow[] = [];
    let harnessError: string | null = null;
    try {
      const providers = await bb.sdk.providers.list({});
      harnesses = providers
        // The stub is never a routing choice, so it is never a row to toggle.
        .filter((provider) => isRoutableProviderId(provider.id))
        .map((provider) => ({
          id: provider.id,
          displayName: provider.displayName,
          available: provider.available,
          allowed: isHarnessAllowed(provider.id, preferences.filter),
        }));
    } catch (cause) {
      // A settings page that cannot list harnesses still has to render the
      // routing switch and a readable connection error.
      harnessError = cause instanceof Error ? cause.message : String(cause);
      bb.log.warn(`could not list harnesses for the settings page: ${harnessError}`);
    }
    return {
      enabled: stored.enabled,
      // The key itself never leaves the server; the page only needs to know
      // whether routing can run at all.
      hasApiKey: typeof current.typesafeApiKey === "string" && current.typesafeApiKey !== "",
      harnesses,
      harnessError,
    };
  }

  bb.rpc.register(rpcContract, {
    routing_get: async ({ threadId }) => ({
      routing: view(threadId, await readRouting(threadId)),
    }),
    settings_state: () => readSettingsState(),
    settings_update: async (patch) => {
      await preferenceStore.update(current => ({ ...current, ...patch }));
      return readSettingsState();
    },
    settings_set_harness: async ({ providerId, allowed }) => {
      if (!isRoutableProviderId(providerId)) throw new Error("The router stub cannot run turns");
      await preferenceStore.update(current => ({
        ...current,
        ...withHarnessAllowed(readPreferences(current).filter, providerId, allowed),
      }));
      return readSettingsState();
    },
  });

  // ---- catalog -----------------------------------------------------------

  interface LoadedCatalog {
    catalog: CatalogHarness[];
    /** Available, non-stub harnesses before the user's filter narrowed them. */
    routableBeforeFilter: number;
  }

  type LiveProvider = Awaited<ReturnType<typeof bb.sdk.providers.list>>[number];
  type LiveModel = Awaited<ReturnType<typeof bb.sdk.providers.models>>["models"][number];

  /** A live provider narrowed to what routing and the spawn need to know. */
  function describeProvider(provider: LiveProvider): CatalogProvider {
    return {
      id: provider.id,
      displayName: provider.displayName,
      available: provider.available,
      permissionModes: provider.capabilities.permissionModes,
      // The coarse flag is what the picker keys on; the descriptor list, when
      // a provider ships one, is the precise set.
      serviceTiers: provider.capabilities.supportsServiceTier
        ? (provider.serviceTiers ?? [{ id: "default" }, { id: "fast" }])
            .map((tier) => tier.id)
            .filter(isServiceTier)
        : [],
    };
  }

  function describeModel(model: LiveModel): CatalogModel {
    return {
      id: model.id,
      model: model.model,
      displayName: model.displayName,
      description: model.description,
      isDefault: model.isDefault,
      reasoningLevels: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
      defaultReasoningLevel: model.defaultReasoningEffort,
    };
  }

  const catalogCache = new Map<string, { at: number; loaded: LoadedCatalog }>();

  /**
   * The live provider/model catalogs, curated for this machine and trimmed to
   * what the settings allow. Cached briefly and keyed by preferences as well as
   * host, so editing the settings page invalidates the list it produced rather
   * than serving it for another minute.
   */
  async function loadCatalog(
    hostId: string | null,
    preferences: RouterPreferences,
  ): Promise<LoadedCatalog> {
    const key = `${hostId ?? "__primary__"}|${preferenceSignature(preferences)}`;
    const cached = catalogCache.get(key);
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) {
      return cached.loaded;
    }
    const routing = hostId === null ? {} : { hostId };
    const providers = await bb.sdk.providers.list({ ...routing });
    // Excluded before the probe, not just before the choice: there is no point
    // asking our own stub — or a harness the user switched off — for its models.
    const routable = providers.filter(
      (provider) => provider.available && isRoutableProviderId(provider.id),
    );
    const allowed = routable
      .filter((provider) => isHarnessAllowed(provider.id, preferences.filter))
      .map(describeProvider);
    const perProvider = await Promise.all(
      allowed.map(async (provider) => {
        try {
          const result = await bb.sdk.providers.models({
            ...routing,
            providerId: provider.id,
          });
          return [provider.id, result.models.map(describeModel)] as const;
        } catch (cause) {
          bb.log.warn(
            `models for ${provider.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
          return [provider.id, [] as CatalogModel[]] as const;
        }
      }),
    );
    const loaded: LoadedCatalog = {
      catalog: buildCatalog(allowed, new Map(perProvider), {
        deferShortlist: true,
        filter: preferences.filter,
      }),
      routableBeforeFilter: routable.length,
    };
    // Keys multiply with preference edits, so expired entries are swept rather
    // than left to accumulate for the life of the plugin load.
    const now = Date.now();
    for (const [staleKey, entry] of catalogCache) {
      if (now - entry.at >= CATALOG_TTL_MS) catalogCache.delete(staleKey);
    }
    catalogCache.set(key, { at: now, loaded });
    return loaded;
  }

  // ---- the hook ----------------------------------------------------------

  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    let record: RoutingRecord | null = null;
    try {
      record = await readRouting(ctx.thread.id);
    } catch (cause) {
      // Fail OPEN: a router that cannot read its own state must not hold a
      // user's message hostage.
      bb.log.warn(
        `routing state unreadable for ${ctx.thread.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return isRoutableProviderId(ctx.requestedExecution.providerId ?? "")
        ? { action: "proceed" }
        : { action: "reject", message: "Routing state is unreadable; retry after fixing the router." };
    }

    const current = await settings.get();
    const decision = decideDispatch({
      enabled: (await preferenceStore.get()).enabled,
      hasApiKey: typeof current.typesafeApiKey === "string" && current.typesafeApiKey !== "",
      pluginId: bb.pluginId,
      requestedProviderId: ctx.requestedExecution.providerId,
      attempt: ctx.attempt,
      threadStatus: ctx.thread.status,
      threadVisibility: ctx.thread.visibility,
      origin: ctx.origin,
      originPluginId: ctx.originPluginId,
      startedOnBehalfOf: ctx.startedOnBehalfOf,
      routing: record,
    });

    switch (decision.action) {
      case "proceed":
        return { action: "proceed" };
      case "reject":
        return { action: "reject", message: decision.message };
      case "wait":
        // A pass is recorded as running, but a plugin reload or a server
        // restart drops both the in-memory pass and any pending confirmation
        // card while the metadata survives. Without this, that row waits
        // forever. Restarting is safe: a pass is idempotent for one thread.
        startPass(ctx);
        return { action: "wait", reason: decision.reason };
      case "route":
        startPass(ctx);
        return { action: "wait", reason: decision.reason };
    }
  });

  /**
   * Begin a routing pass unless one is already running for this thread.
   * Detached deliberately: the hook must answer now, and a pass ends by
   * calling `recheck`, not by resolving back into the handler that started it.
   */
  function startPass(ctx: MessageDispatchHookContext): void {
    if (inFlight.has(ctx.thread.id)) return;
    inFlight.add(ctx.thread.id);
    void runPass(ctx).finally(() => inFlight.delete(ctx.thread.id));
  }

  async function settle(
    threadId: string,
    phase: Extract<RoutingPhase, "failed" | "skipped">,
    detail: string,
  ): Promise<void> {
    await writeRouting(threadId, {
      phase,
      providerId: null,
      model: null,
      replacementThreadId: null,
      detail,
    });
    await bb.experimental_hooks.recheck("message.dispatch");
  }

  async function runPass(ctx: MessageDispatchHookContext): Promise<void> {
    const threadId = ctx.thread.id;
    try {
      await writeRouting(threadId, {
        phase: "selecting",
        providerId: null,
        model: null,
        replacementThreadId: null,
        detail: null,
      });

      // Read here, not at load: a preference changed a moment ago applies to
      // this pass.
      const current = await settings.get();
      const { typesafeApiKey } = current;
      if (typeof typesafeApiKey !== "string" || typesafeApiKey === "") {
        await settle(threadId, "skipped", "no TypeSafe API key");
        return;
      }

      const { catalog, routableBeforeFilter } = await loadCatalog(
        ctx.host?.id ?? null,
        readPreferences(await preferenceStore.get()),
      );
      // Fail closed before spending a Choice call. On the picker stub this
      // becomes a rejection the user can read and act on. Exclude-all also
      // rejects a held first message on a real harness.
      if (catalog.length === 0) {
        await settle(threadId, "skipped", emptyCatalogDetail(routableBeforeFilter));
        return;
      }

      const client = new TypeSafeClient({ apiKey: typesafeApiKey });
      const result = await routeFirstMessage(client, {
        messageText: ctx.input.text,
        projectName: ctx.project.name ?? null,
        catalog,
        currentProviderId: ctx.requestedExecution.providerId,
        requestedReasoningLevel: ctx.requestedExecution.reasoningLevel,
        reasoningLevelIsExplicit: ctx.executionSources.reasoningLevel === "explicit",
      });

      bb.log.info(
        `routed ${threadId} to ${result.harness.id}/${result.model.id}` +
          (result.reasoningLevel === null
            ? ""
            : `@${result.reasoningLevel} (effort ${result.effortConfidence === null ? "kept" : "proposed"}; requested as ${ctx.executionSources.reasoningLevel ?? "default"})`) +
          ` in ${result.elapsedMs}ms (${result.inputTokens} input tokens)`,
      );
      displayNames.set(threadId, {
        provider: result.harness.displayName,
        model: result.model.displayName,
      });
      await writeRouting(threadId, {
        phase: "proposed",
        providerId: result.harness.id,
        model: result.model.id,
        replacementThreadId: null,
        detail: null,
      });

      const answer = await bb.ui.requestInput({
        threadId,
        rendererId: CONFIRM_RENDERER_ID,
        title: "Confirm harness and model",
        timeoutMs: CONFIRM_TIMEOUT_MS,
        payload: {
          providerId: result.harness.id,
          providerName: result.harness.displayName,
          model: result.model.id,
          modelName: result.model.displayName,
          modelDescription: result.model.description,
          keepsHarness: result.harness.id === ctx.requestedExecution.providerId,
          currentProviderId: ctx.requestedExecution.providerId,
          harnessConfidence: result.harnessConfidence,
          modelConfidence: result.modelConfidence,
          reasoningLevel: result.reasoningLevel,
          reasoningLevels: [...(result.model.reasoningLevels ?? [])],
          effortConfidence: result.effortConfidence,
        },
      });

      if (answer.outcome !== "submitted") {
        await settle(threadId, "skipped", `confirmation ${answer.outcome}`);
        return;
      }
      const value =
        typeof answer.value === "object" && answer.value !== null && !Array.isArray(answer.value)
          ? (answer.value as Record<string, unknown>)
          : {};
      if (value.accept !== true) {
        await settle(threadId, "skipped", "declined by the user");
        return;
      }

      // Trust the card's choice only when it names a level the model actually
      // offers; anything else — including a stale or tampered payload — falls
      // back to what the router itself proposed.
      const offeredLevels = result.model.reasoningLevels ?? [];
      const reasoningLevel =
        typeof value.reasoningLevel === "string" &&
        (offeredLevels as readonly string[]).includes(value.reasoningLevel)
          ? (value.reasoningLevel as ReasoningLevel)
          : result.reasoningLevel;

      await apply(ctx, result.harness, result.model, reasoningLevel);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      bb.log.error(`routing pass failed for ${threadId}: ${message}`);
      await settle(threadId, "failed", message).catch(() => undefined);
    }
  }

  /**
   * Same harness: update the model on the thread and let the held message
   * through. Different harness: BB cannot swap a thread's harness, so the
   * message moves to a new thread that starts on the confirmed one, and this
   * thread is rejected and archived.
   */
  async function apply(
    ctx: MessageDispatchHookContext,
    harness: CatalogHarness,
    model: CatalogModel,
    reasoningLevel: ReasoningLevel | null,
  ): Promise<void> {
    const threadId = ctx.thread.id;
    // Unreachable while the catalog excludes the stub, and cheap insurance if
    // that ever stops being true: a failed pass ends in a rejection the user can
    // read, not a thread confirmed onto a harness that cannot run.
    if (!isRoutableProviderId(harness.id)) {
      throw new Error(`refusing to confirm ${threadId} onto ${harness.id}`);
    }
    // The user's own tier and permission choices, plus the effort Jev proposed
    // (or the user's own explicit one), follow the message to the harness that
    // runs it — all through the one helper, so clamping and provenance stay in
    // one place. A routed effort counts as explicit: it is what the card showed
    // and what the user confirmed.
    const execution = carryExecution(
      reasoningLevel === null ? ctx.requestedExecution : { ...ctx.requestedExecution, reasoningLevel },
      reasoningLevel === null ? ctx.executionSources : { ...ctx.executionSources, reasoningLevel: "explicit" },
      model,
      harness,
    );
    if (harness.id === ctx.requestedExecution.providerId) {
      await bb.sdk.threads.update({
        threadId,
        model: model.id,
        ...(execution.reasoningLevel === undefined
          ? {}
          : { reasoningLevel: execution.reasoningLevel }),
      });
      await writeRouting(threadId, {
        phase: "confirmed",
        providerId: harness.id,
        model: model.id,
        replacementThreadId: null,
        detail: null,
      });
      await bb.experimental_hooks.recheck("message.dispatch");
      return;
    }

    const replacement = await bb.sdk.threads.spawn({
      projectId: ctx.thread.projectId,
      environment:
        ctx.environment === null
          ? { type: "project-default" }
          : { type: "reuse", environmentId: ctx.environment.id },
      providerId: harness.id,
      model: model.id,
      ...execution,
      input: [...ctx.input.blocks],
      ...(ctx.thread.title === null ? {} : { title: ctx.thread.title }),
      // Seeded as already-confirmed so the new thread's own first dispatch
      // passes straight through this same hook.
      pluginMetadata: {
        routing: {
          phase: "confirmed",
          providerId: harness.id,
          model: model.id,
          replacementThreadId: null,
          detail: `routed from ${threadId}`,
          updatedAt: Date.now(),
        },
      },
    });
    displayNames.set(replacement.id, {
      provider: harness.displayName,
      model: model.displayName,
    });

    await writeRouting(threadId, {
      phase: "redirected",
      providerId: harness.id,
      model: model.id,
      replacementThreadId: replacement.id,
      detail: null,
    });
    // Publish before rejecting so an open client can navigate away from the
    // thread that is about to show a rejection.
    bb.realtime.publish(ROUTING_CHANGED, {
      threadId,
      phase: "redirected",
      replacementThreadId: replacement.id,
    });
    await bb.experimental_hooks.recheck("message.dispatch");
    await bb.sdk.threads.archive({ threadId }).catch((cause: unknown) => {
      bb.log.warn(
        `could not archive placeholder ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    });
  }

  bb.onDispose(() => {
    displayNames.clear();
    inFlight.clear();
    catalogCache.clear();
  });
}
