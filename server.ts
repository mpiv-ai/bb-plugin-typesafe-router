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
  CURATION_MODES,
  isHarnessAllowed,
  MAX_MODELS_PER_HARNESS,
  type CatalogHarness,
  type CatalogModel,
} from "./lib/catalog.js";
import {
  clampMaxModels,
  emptyCatalogDetail,
  MAX_MODELS_CEILING,
  MIN_MODELS_PER_HARNESS,
  parseCurationMode,
  parseHarnessIds,
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
} from "./lib/provider.js";
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
  maxModelsPerHarness: z.number(),
  curationMode: z.string(),
  includeHarnesses: z.string(),
  excludeHarnesses: z.string(),
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
        maxModelsPerHarness: z.number().optional(),
        curationMode: z.string().optional(),
        includeHarnesses: z.string().optional(),
        excludeHarnesses: z.string().optional(),
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
  // Declared, not just read: every field here renders on the plugin's own page
  // under Settings, and is editable with `bb plugin config typesafe-router`.
  // The settings section in app.tsx is a friendlier front end over these same
  // values — both write through `settings.experimental_set`, so the page and
  // the CLI are one source of truth.
  const settings = bb.settings.define({
    typesafeApiKey: {
      type: "string",
      label: "TypeSafe API key",
      description: "Used for the two Choice calls that pick a harness and model.",
      secret: true,
    },
    enabled: {
      type: "boolean",
      label: "Route first messages",
      description:
        "Off leaves every thread on the harness it was created with. Takes effect on the next message.",
      default: true,
    },
    maxModelsPerHarness: {
      type: "number",
      label: "Models offered per harness",
      description: `How many models from each harness TypeSafe may choose between (${MIN_MODELS_PER_HARNESS}–${MAX_MODELS_CEILING}). Lower is cheaper and blunter.`,
      default: MAX_MODELS_PER_HARNESS,
      experimental_schema: z
        .number()
        .int()
        .min(MIN_MODELS_PER_HARNESS)
        .max(MAX_MODELS_CEILING),
    },
    curationMode: {
      type: "select",
      label: "How to trim an oversized harness",
      description:
        "Both modes cap the list, collapse model families, and keep the provider's default.",
      options: [...CURATION_MODES],
      default: "weighted",
      // Typed as a plain string validator so the descriptor's
      // StandardSchemaV1<string, string> contract is satisfied exactly.
      experimental_schema: z
        .string()
        .refine(
          (value) => (CURATION_MODES as readonly string[]).includes(value),
          `Expected one of: ${CURATION_MODES.join(", ")}`,
        ),
    },
    includeHarnesses: {
      type: "string",
      label: "Only these harnesses",
      description:
        "One provider id per line (codex, acp-omp). Empty means every available harness. `#` starts a comment.",
      experimental_multiline: true,
      default: "",
    },
    excludeHarnesses: {
      type: "string",
      label: "Never these harnesses",
      description:
        "One provider id per line, applied after the include list. `#` starts a comment.",
      experimental_multiline: true,
      default: "",
    },
  });

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
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["medium"],
    },
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
    const preferences = readPreferences(current);
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
      // behaviour controls and the typed escape hatch.
      harnessError = cause instanceof Error ? cause.message : String(cause);
      bb.log.warn(`could not list harnesses for the settings page: ${harnessError}`);
    }
    return {
      enabled: current.enabled,
      maxModelsPerHarness: clampMaxModels(current.maxModelsPerHarness),
      curationMode: preferences.curationMode,
      includeHarnesses: current.includeHarnesses,
      excludeHarnesses: current.excludeHarnesses,
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
      const next: Parameters<typeof settings.experimental_set>[0] = {};
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      if (patch.maxModelsPerHarness !== undefined) {
        next.maxModelsPerHarness = clampMaxModels(patch.maxModelsPerHarness);
      }
      if (patch.curationMode !== undefined) {
        next.curationMode = parseCurationMode(patch.curationMode);
      }
      if (patch.includeHarnesses !== undefined) {
        next.includeHarnesses = patch.includeHarnesses;
      }
      if (patch.excludeHarnesses !== undefined) {
        next.excludeHarnesses = patch.excludeHarnesses;
      }
      await settings.experimental_set(next);
      return readSettingsState();
    },
    settings_set_harness: async ({ providerId, allowed }) => {
      const current = await settings.get();
      const lists = withHarnessAllowed(
        {
          include: parseHarnessIds(current.includeHarnesses),
          exclude: parseHarnessIds(current.excludeHarnesses),
        },
        providerId,
        allowed,
      );
      await settings.experimental_set(lists);
      return readSettingsState();
    },
  });

  // ---- catalog -----------------------------------------------------------

  interface LoadedCatalog {
    catalog: CatalogHarness[];
    /** Available, non-stub harnesses before the user's filter narrowed them. */
    routableBeforeFilter: number;
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
    const allowed = routable.filter((provider) =>
      isHarnessAllowed(provider.id, preferences.filter),
    );
    const perProvider = await Promise.all(
      allowed.map(async (provider) => {
        try {
          const result = await bb.sdk.providers.models({
            ...routing,
            providerId: provider.id,
          });
          return [provider.id, result.models as CatalogModel[]] as const;
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
        max: preferences.maxModelsPerHarness,
        mode: preferences.curationMode,
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
      return { action: "proceed" };
    }

    const current = await settings.get();
    const decision = decideDispatch({
      enabled: current.enabled,
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
        readPreferences(current),
      );
      // Fail closed before spending a Choice call. On the picker stub this
      // becomes a rejection the user can read and act on; on a real harness the
      // thread simply proceeds where it already was.
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
      });

      bb.log.info(
        `routed ${threadId} to ${result.harness.id}/${result.model.id} in ${result.elapsedMs}ms (${result.inputTokens} input tokens)`,
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
        },
      });

      if (answer.outcome !== "submitted") {
        await settle(threadId, "skipped", `confirmation ${answer.outcome}`);
        return;
      }
      const accepted =
        typeof answer.value === "object" &&
        answer.value !== null &&
        !Array.isArray(answer.value) &&
        (answer.value as Record<string, unknown>).accept === true;
      if (!accepted) {
        await settle(threadId, "skipped", "declined by the user");
        return;
      }

      await apply(ctx, result.harness, result.model);
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
  ): Promise<void> {
    const threadId = ctx.thread.id;
    // Unreachable while the catalog excludes the stub, and cheap insurance if
    // that ever stops being true: a failed pass ends in a rejection the user can
    // read, not a thread confirmed onto a harness that cannot run.
    if (!isRoutableProviderId(harness.id)) {
      throw new Error(`refusing to confirm ${threadId} onto ${harness.id}`);
    }
    if (harness.id === ctx.requestedExecution.providerId) {
      await bb.sdk.threads.update({ threadId, model: model.id });
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
