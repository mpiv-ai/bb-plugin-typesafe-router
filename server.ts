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

import {
  defineRpcContract,
  type BbPluginApi,
  type MessageDispatchHookContext,
} from "@get-bb/plugin-sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { z } from "zod";
import {
  buildCatalog,
  MAX_MODELS_PER_HARNESS,
  type CatalogHarness,
  type CatalogModel,
} from "./lib/catalog.js";
import {
  decideDispatch,
  parseRoutingRecord,
  type RoutingPhase,
  type RoutingRecord,
} from "./lib/policy.js";
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

export const rpcContract = defineRpcContract({
  routing_get: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ routing: routingViewSchema.nullable() }),
  },
});

export type RoutingView = z.infer<typeof routingViewSchema>;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    typesafeApiKey: {
      type: "string",
      label: "TypeSafe API key",
      secret: true,
    },
    enabled: {
      type: "boolean",
      label: "Route first messages",
      default: true,
    },
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

  bb.rpc.register(rpcContract, {
    routing_get: async ({ threadId }) => ({
      routing: view(threadId, await readRouting(threadId)),
    }),
  });

  // ---- catalog -----------------------------------------------------------

  const catalogCache = new Map<string, { at: number; catalog: CatalogHarness[] }>();

  async function loadCatalog(hostId: string | null): Promise<CatalogHarness[]> {
    const key = hostId ?? "__primary__";
    const cached = catalogCache.get(key);
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) {
      return cached.catalog;
    }
    const routing = hostId === null ? {} : { hostId };
    const providers = await bb.sdk.providers.list({ ...routing });
    const available = providers.filter((provider) => provider.available);
    const perProvider = await Promise.all(
      available.map(async (provider) => {
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
    const catalog = buildCatalog(
      available,
      new Map(perProvider),
      MAX_MODELS_PER_HARNESS,
    );
    catalogCache.set(key, { at: Date.now(), catalog });
    return catalog;
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

      const { typesafeApiKey } = await settings.get();
      if (typeof typesafeApiKey !== "string" || typesafeApiKey === "") {
        await settle(threadId, "skipped", "no TypeSafe API key");
        return;
      }

      const catalog = await loadCatalog(ctx.host?.id ?? null);
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
