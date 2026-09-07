/**
 * useAgenticChat — Thin composer hook.
 *
 * Composes useChatCore + feature hooks (pending agents, feedback, tools,
 * debug, inline UI) into the full ChatContextValue.
 *
 * Roster tracking, pending agents, debug events, dirty repo warnings, and
 * transcript projection are owned by useChatCore. Feature hooks here handle
 * the remaining domain UX: feedback, tools, inline UI, action bars, and debug
 * presentation.
 *
 * For minimal chat (no tools, no feedback, no debug), use useChatCore directly.
 */
import { useCallback, useMemo, useReducer, useRef, useEffect, useState } from "react";
import { z } from "zod";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { fsMethods } from "@vibestudio/service-schemas/fs";
import type { ChannelConfig, MethodExecutionContext, PubSubClient } from "@workspace/pubsub";
import { ScopeManager } from "@workspace/eval/scope";
import type {
  SandboxImportLoader,
  SandboxOptions,
  SandboxResult,
  ScopeBlobBackend
} from "@workspace/eval";
import type { ActiveFeedbackSchema, FeedbackResult } from "@workspace/tool-ui";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  type ActorKind,
  type AgenticEvent
} from "@workspace/agentic-protocol";
import { useChatCore } from "./core/useChatCore";
import { useForkLineage } from "./useForkLineage";
import { useDeferredAgent } from "./useDeferredAgent";
import { useChatFeedback } from "./features/useChatFeedback";
import { useChatTools } from "./features/useChatTools";
import { buildClientEvalMethod } from "./features/clientEval";
import { useChatDebug } from "./features/useChatDebug";
import { useInlineUi } from "./features/useInlineUi";
import { useActionBar } from "./features/useActionBar";
import { useMessageTypeRegistry } from "./features/useMessageTypeRegistry";
import type {
  ConnectionConfig,
  AgenticChatActions,
  ToolProvider,
  ChatSandboxValue,
  ChatParticipantMetadata,
  ClientParticipantMetadata,
  ChatContextValue,
  ChatInputContextValue,
  ActionBarData,
  BrowserHandoffCallerKind,
  ForkNavHandlers
} from "../types";
import { channelParticipantId, runtimeCallerId } from "../types";
import type { MessageTypeComponentEntry } from "../types";
import { customInspectorPayload } from "../components/CustomMessage";
import { unwrapChatMethodResult } from "@workspace/agentic-core";
import type { ChatMethodResult, AgentSubscriptionConfig } from "@workspace/agentic-core";
import {
  LocalStorageScopePersistence,
  panelLocalScopeChannelId
} from "../utils/localStorageScopePersistence";
import { scheduleBackgroundWork } from "../utils/scheduleBackgroundWork";
import { sendSandboxText, type SandboxSendOptions } from "./sandboxSend";
import { connectionRetryDelayMs, isTransientConnectionFailure } from "./connectionRetry";
import {
  composeAgenticChatMethods,
  resolveAgenticChatFeatures,
  type AgenticChatFeature,
  type ResolvedAgenticChatFeatures
} from "../features";

const NO_INLINE_UI_MESSAGES: ChatContextValue["messages"] = [];
/** Installed agent info passed from the host panel. */
interface InstalledAgentInfo {
  agentId: string;
  handle: string;
}
function actionBarLoadKey(
  path: string,
  props: Record<string, unknown> | undefined,
  maxHeight: number | undefined
): string {
  let propsKey = "";
  try {
    propsKey = JSON.stringify(props ?? null);
  } catch {
    propsKey = "[unserializable-props]";
  }
  return `${path}\n${propsKey}\n${maxHeight ?? ""}`;
}

function actorKindFromMetadata(type: string | undefined, participantId?: string): ActorKind {
  // A `user:<userId>` participant id is the channel-stamped human identity
  // (WP6 §4) — it always resolves to the semantic `user` role, regardless of
  // the client-supplied metadata type.
  if (participantId?.startsWith("user:")) return "user";
  if (type === "agent" || type === "system" || type === "panel" || type === "external") return type;
  return "user";
}

function browserHandoffCallerKindFromMetadata(type: string | undefined): BrowserHandoffCallerKind {
  if (type === "app" || type === "shell") return type;
  return "panel";
}

function actorForClient(
  client: Pick<PubSubClient<ChatParticipantMetadata>, "clientId" | "roster">,
  metadata: ClientParticipantMetadata
) {
  const id = client.clientId ?? metadata.handle ?? "panel";
  // Live identity projection (WP6 §3/§5): the channel stamps human
  // participants with `id: user:<userId>` and the ACCOUNT-derived
  // handle/displayName on the roster row — prefer that over the local panel
  // label, so events carry the real account participant and profile.
  const self = client.roster?.[id]?.metadata;
  const merged = { ...metadata, ...(self ?? {}) };
  return {
    kind: actorKindFromMetadata(merged.type ?? metadata.type, id),
    id,
    displayName: merged.name ?? merged.handle ?? id,
    metadata: { ...merged }
  };
}

async function waitForMethodHandle<T>(
  handle: { result: Promise<T>; cancel?: () => Promise<void> },
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortCleanup: (() => void) | undefined;
  const cancel = () => {
    void handle.cancel?.().catch((err) => {
      console.warn("[useAgenticChat] Failed to cancel method handle:", err);
    });
  };
  try {
    const blockers: Array<Promise<never>> = [];
    if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
      const timeoutMs = options.timeoutMs;
      blockers.push(
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            cancel();
            reject(new Error(`Method call timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      );
    }
    if (options?.signal) {
      if (options.signal.aborted) {
        cancel();
        throw new Error("Method call aborted");
      }
      blockers.push(
        new Promise<never>((_, reject) => {
          const onAbort = () => {
            cancel();
            reject(new Error("Method call aborted"));
          };
          options.signal!.addEventListener("abort", onAbort, { once: true });
          abortCleanup = () => options.signal!.removeEventListener("abort", onAbort);
        })
      );
    }
    return await Promise.race([handle.result, ...blockers]);
  } finally {
    if (timeout) clearTimeout(timeout);
    abortCleanup?.();
  }
}

export interface UseAgenticChatOptions {
  config: ConnectionConfig;
  channelName: string;
  channelConfig?: ChannelConfig;
  contextId?: string;
  /** Panel LABEL only (WP6 §5) — never the authoritative human identity; the
   *  channel derives that from the host-verified subject on the connection. */
  metadata?: ClientParticipantMetadata;
  tools?: ToolProvider;
  actions?: AgenticChatActions;
  theme?: "light" | "dark";
  installedAgentInfos?: InstalledAgentInfo[];
  /** If set, automatically sent as the first user message once connected */
  initialPrompt?: string;
  /** Send initialPrompt even if the channel already has history (idempotent). */
  forceInitialPrompt?: boolean;
  /** Override the durable deduplication key for an explicitly triggered prompt. */
  initialPromptIdempotencyKey?: string;
  /** Panel-supplied fork navigation + review overlay handlers (enables the fork
   *  switcher, inline fork rows, and subagent review). Absent ⇒ no fork UI. */
  forkNav?: ForkNavHandlers;
  /** Optional build-backed loader for imports used by authored UI and client evaluation. */
  importLoader?: SandboxImportLoader;
  /** Context-relative TSX file to load into the panel-local action bar on mount */
  initialActionBarFile?: string;
  /** Props for initialActionBarFile */
  initialActionBarProps?: Record<string, unknown>;
  /** Preferred max height for initialActionBarFile */
  initialActionBarMaxHeight?: number;
  /** Called when load_action_bar changes the panel-local action bar file */
  onActionBarFileChange?: (value: {
    path: string | null;
    props?: Record<string, unknown>;
    maxHeight?: number;
  }) => void | Promise<void>;
  /** Changes when the host resolves a workspace review that blocked connection. */
  connectionRetrySignal?: number;
  /**
   * Browser-owned capabilities exposed by this participant. Explicit and fixed
   * for the lifetime of the mounted participant.
   */
  features: readonly AgenticChatFeature[];
}

export interface UseAgenticChatResult {
  contextValue: ChatContextValue;
  inputContextValue: ChatInputContextValue;
  features: ResolvedAgenticChatFeatures;
}

export function useAgenticChat({
  config,
  channelName,
  channelConfig,
  contextId,
  // Panel label only — no client-declared human identity: the channel
  // stamps the account-derived identity from the host-verified subject.
  metadata: metadataOption,
  tools,
  actions,
  // No "dark" default — appearance flows from the explicit prop OR the system
  // / centralized appearance (resolved in useChatCore via resolveSystemTheme).
  theme,
  installedAgentInfos,
  initialPrompt,
  forceInitialPrompt,
  initialPromptIdempotencyKey,
  forkNav,
  importLoader,
  initialActionBarFile,
  initialActionBarProps,
  initialActionBarMaxHeight,
  onActionBarFileChange,
  connectionRetrySignal,
  features: requestedFeatures
}: UseAgenticChatOptions): UseAgenticChatResult {
  const [features] = useState(() => resolveAgenticChatFeatures(requestedFeatures));
  const metadata = useMemo<ClientParticipantMetadata>(
    () => metadataOption ?? { name: channelName, type: "panel" },
    [channelName, metadataOption]
  );
  // --- Core (durable channel trajectory events -> transcript view model) ---
  // Agent-managing hosts route initialPrompt through the deferred pre-send queue
  // below so it waits for the first agent. Hosts without onAddAgent keep the
  // historical core auto-send path; there is no agent for the deferred queue to
  // spawn, so holding the prompt would strand it.
  const core = useChatCore({
    config,
    channelName,
    channelConfig,
    contextId,
    metadata,
    theme,
    initialPrompt: actions?.onAddAgent ? undefined : initialPrompt,
    forceInitialPrompt: actions?.onAddAgent ? undefined : forceInitialPrompt,
    initialPromptIdempotencyKey: actions?.onAddAgent
      ? undefined
      : initialPromptIdempotencyKey
  });
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const retryConnection = useCallback(() => {
    core.dismissConnectionError();
    core.hasConnectedRef.current = false;
    setConnectionAttempt((attempt) => attempt + 1);
  }, [core.dismissConnectionError, core.hasConnectedRef]);
  // Fork lineage state + actions (switcher, tree, inline rows, subagent review).
  // Only enabled when the panel supplies navigation handlers.
  const forkState = useForkLineage({
    rpc: config.rpc,
    channelId: channelName,
    contextId,
    selfId: core.selfId,
    selfMetadata: {
      type: metadata.type,
      name: metadata.name,
      handle: metadata.handle
    },
    messages: core.messages,
    replaySettled: core.replaySettled,
    retrySignal: connectionRetrySignal,
    client: core.client,
    nav: forkNav
  });
  const scopeBlobBackend = useMemo<ScopeBlobBackend>(
    () => ({
      putText: (valueJson: string) =>
        config.rpc.call("main", "blobstore.putText", [valueJson]) as Promise<{
          digest: string;
          size: number;
        }>,
      getText: (digest: string) =>
        config.rpc.call("main", "blobstore.getText", [digest]) as Promise<string | null>
    }),
    [config.rpc]
  );
  const scopeManager = useMemo(
    () =>
      new ScopeManager({
        channelId: panelLocalScopeChannelId(channelName, config.clientId),
        panelId: "panel-ui",
        persistence: new LocalStorageScopePersistence(scopeBlobBackend)
      }),
    [channelName, config.clientId, scopeBlobBackend]
  );
  const [scopeVersion, bumpScopeVersion] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = scopeManager.onChange(bumpScopeVersion);
    void scopeManager
      .hydrate()
      .then((result) => {
        if (cancelled) return;
        bumpScopeVersion();
        if (result.lost.length > 0) {
          console.warn(
            `[panel-ui-scope] Cold recovery lost live-only keys: [${result.lost.join(", ")}]`
          );
        }
      })
      .catch((err) => {
        if (!cancelled) console.warn("[panel-ui-scope] Failed to hydrate:", err);
      });
    const persistIfDirty = () => {
      if (!scopeManager.isDirty) return;
      void scopeManager.persist().catch((err) => {
        console.warn("[panel-ui-scope] Failed to persist:", err);
      });
    };
    const persistIfHidden = () => {
      if (document.hidden) persistIfDirty();
    };
    window.addEventListener("beforeunload", persistIfDirty);
    document.addEventListener("visibilitychange", persistIfHidden);
    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener("beforeunload", persistIfDirty);
      document.removeEventListener("visibilitychange", persistIfHidden);
      scopeManager.dispose();
    };
  }, [scopeManager]);
  const scope = useMemo(() => scopeManager.current, [scopeManager]);
  const scopes = useMemo(() => scopeManager.api, [scopeManager]);
  const publishTypedAgenticEvent = useCallback(
    async (
      event: AgenticEvent,
      options?: { idempotencyKey?: string }
    ): Promise<number | undefined> => {
      const client = core.clientRef.current;
      if (!client) return undefined;
      return client.publish(AGENTIC_EVENT_PAYLOAD_KIND, event, {
        idempotencyKey: options?.idempotencyKey ?? crypto.randomUUID()
      });
    },
    [core.clientRef]
  );
  // --- Mirror host-owned installed agents into transient pending badges until they join ---
  useEffect(() => {
    if (installedAgentInfos === undefined) return;
    core.setPendingAgentInfos(installedAgentInfos);
  }, [installedAgentInfos, core.setPendingAgentInfos]);
  // --- Build chat sandbox value (stale-ref safe — dereferences clientRef at call time) ---
  const chat: ChatSandboxValue = useMemo(
    () => ({
      send: (content: string, opts?: SandboxSendOptions) => {
        if (!core.clientRef.current) {
          return Promise.reject(new Error("Agentic chat is not connected"));
        }
        return sendSandboxText(core.publishText, content, opts, crypto.randomUUID());
      },
      publish: (
        eventType: string,
        payload: unknown,
        opts?: {
          idempotencyKey?: string;
        }
      ) => {
        return core.clientRef.current!.publish(eventType, payload, {
          ...opts,
          idempotencyKey: opts?.idempotencyKey ?? crypto.randomUUID()
        }) as Promise<unknown>;
      },
      publishCustomMessage: (input, opts) => {
        return core.clientRef.current!.publishCustomMessage(input, {
          idempotencyKey: opts?.idempotencyKey ?? crypto.randomUUID()
        });
      },
      updateCustomMessage: (messageId, update, opts) => {
        return core.clientRef.current!.updateCustomMessage(messageId, update, {
          idempotencyKey: opts?.idempotencyKey ?? crypto.randomUUID()
        });
      },
      registerMessageType: (input, opts) => {
        return core.clientRef.current!.registerMessageType(
          input,
          opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined
        );
      },
      clearMessageType: (typeId, opts) => {
        return core.clientRef.current!.clearMessageType(
          typeId,
          opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined
        );
      },
      getMessageType: (typeId) => {
        return core.clientRef.current!.getMessageType(typeId);
      },
      getMessageTypes: () => {
        return core.clientRef.current!.getMessageTypes();
      },
      getParticipants: async () => {
        return Object.values(core.clientRef.current?.roster ?? {}).map(({ id, ref, metadata }) => ({
          id,
          ref,
          type: metadata.type,
          name: metadata.name,
          isPerson: metadata.type === "user",
          isAgent: metadata.type === "agent",
          ...(metadata.handle ? { handle: metadata.handle } : {}),
          ...(metadata.methods ? { methods: metadata.methods } : {})
        }));
      },
      replayEnvelope: (envelopeId: string) => {
        return core.clientRef.current!.getEnvelope(envelopeId);
      },
      callMethod: async (
        pid: string,
        method: string,
        callArgs: unknown,
        options?: { timeoutMs?: number; signal?: AbortSignal }
      ) => {
        const handle = core.clientRef.current!.callMethod(pid, method, callArgs, options);
        const result = await waitForMethodHandle(
          handle as {
            result: Promise<ChatMethodResult>;
            cancel?: () => Promise<void>;
          },
          options
        );
        return unwrapChatMethodResult(result);
      },
      callMethodResult: async (
        pid: string,
        method: string,
        callArgs: unknown,
        options?: { timeoutMs?: number; signal?: AbortSignal }
      ) => {
        const handle = core.clientRef.current!.callMethod(pid, method, callArgs, options);
        return waitForMethodHandle(
          handle as {
            result: Promise<ChatMethodResult>;
            cancel?: () => Promise<void>;
          },
          options
        );
      },
      participantByHandle: async (rawHandle: string) => {
        const handle = rawHandle.startsWith("@") ? rawHandle.slice(1) : rawHandle;
        const roster = core.clientRef.current?.roster ?? {};
        return (
          Object.values(roster).find((participant) => {
            const metadataHandle = participant.metadata?.handle;
            return typeof metadataHandle === "string" && metadataHandle === handle;
          }) ?? null
        );
      },
      callMethodByHandle: async (
        rawHandle: string,
        method: string,
        callArgs: unknown,
        options?: { timeoutMs?: number; signal?: AbortSignal }
      ) => {
        const handle = rawHandle.startsWith("@") ? rawHandle.slice(1) : rawHandle;
        const roster = core.clientRef.current?.roster ?? {};
        const participant = Object.values(roster).find((item) => item.metadata?.handle === handle);
        if (!participant) throw new Error(`No participant with handle @${handle}`);
        const methodHandle = core.clientRef.current!.callMethod(
          participant.id,
          method,
          callArgs,
          options
        );
        const result = await waitForMethodHandle(
          methodHandle as {
            result: Promise<ChatMethodResult>;
            cancel?: () => Promise<void>;
          },
          options
        );
        return unwrapChatMethodResult(result);
      },
      callMethodResultByHandle: async (
        rawHandle: string,
        method: string,
        callArgs: unknown,
        options?: { timeoutMs?: number; signal?: AbortSignal }
      ) => {
        const handle = rawHandle.startsWith("@") ? rawHandle.slice(1) : rawHandle;
        const roster = core.clientRef.current?.roster ?? {};
        const participant = Object.values(roster).find((item) => item.metadata?.handle === handle);
        if (!participant) throw new Error(`No participant with handle @${handle}`);
        const methodHandle = core.clientRef.current!.callMethod(
          participant.id,
          method,
          callArgs,
          options
        );
        return waitForMethodHandle(
          methodHandle as {
            result: Promise<ChatMethodResult>;
            cancel?: () => Promise<void>;
          },
          options
        );
      },
      focusMessage: async (messageId: string): Promise<boolean> => {
        // Message cards render with id={`message-${msg.id}`} in the same DOM
        // as sandboxed renderers — no RPC needed. Retry briefly: the card the
        // caller just created may still be folding into the transcript.
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const element = document.getElementById(`message-${messageId}`);
          if (element) {
            element.scrollIntoView({ behavior: "smooth", block: "center" });
            element.animate(
              [
                {
                  boxShadow: "0 0 0 3px var(--accent-a7)",
                  borderRadius: "8px"
                },
                { boxShadow: "0 0 0 3px transparent", borderRadius: "8px" }
              ],
              { duration: 1600, easing: "ease-out" }
            );
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return false;
      },
      contextId: contextId ?? "",
      channelId: channelName,
      rpc: config.rpc
    }),
    [contextId, channelName, config.rpc, core.clientRef, metadata, publishTypedAgenticEvent]
  );
  // --- Bound executeSandbox with optional host import loading wired ---
  const boundExecuteSandbox = useCallback(
    async (code: string, opts: SandboxOptions = {}): Promise<SandboxResult> => {
      const { executeSandbox } = await import("@workspace/eval/sandbox");
      return executeSandbox(code, {
        ...opts,
        ...(opts.loadImport || !importLoader ? {} : { loadImport: importLoader })
      });
    },
    [importLoader]
  );
  const loadSourceFile = useCallback(
    async (path: string) => {
      const fsClient = createTypedServiceClient("fs", fsMethods, (service, method, args) =>
        config.rpc.call("main", `${service}.${method}`, args)
      );
      return (await fsClient.readFile(path, "utf8")) as string;
    },
    [config.rpc]
  );
  const feedback = useChatFeedback({
    chat,
    loadImport: importLoader,
    clientRef: core.clientRef,
    connected: core.connected
  });
  const chatTools = useChatTools({
    clientRef: core.clientRef,
    tools,
    contextId: contextId ?? "",
    executeSandbox: boundExecuteSandbox,
    chat,
    scopeManager
  });
  const debug = useChatDebug();
  const inlineUi = useInlineUi({
    messages: features.inlineUi ? core.messages : NO_INLINE_UI_MESSAGES,
    loadSourceFile,
    loadImport: importLoader
  });
  const messageTypes = useMessageTypeRegistry({
    client: core.client,
    messages: core.messages,
    definitions: core.messageTypes,
    loadSourceFile,
    loadImport: importLoader
  });
  const [actionBarData, setActionBarData] = useState<ActionBarData | null>(null);
  const actionBar = useActionBar({
    data: features.actionBar ? actionBarData : null,
    loadSourceFile,
    loadImport: importLoader
  });
  const lastLoadedActionBarKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!features.actionBar) return;
    const canonical = core.canonicalActionBar;
    if (!canonical?.source) return;
    const next: ActionBarData = {
      id: canonical.id ?? "canonical-action-bar",
      source: canonical.source
    };
    if (canonical.imports !== undefined) next.imports = canonical.imports;
    if (canonical.props !== undefined) next.props = canonical.props;
    if (canonical.maxHeight !== undefined) next.maxHeight = canonical.maxHeight;
    setActionBarData(next);
    if (canonical.source.type === "file") {
      lastLoadedActionBarKeyRef.current = actionBarLoadKey(
        canonical.source.path,
        canonical.props,
        canonical.maxHeight
      );
    }
  }, [core.canonicalActionBar, features.actionBar]);
  const publishActionBarContext = useCallback(
    async (
      action: "loaded" | "cleared",
      payload: {
        id?: string;
        path?: string;
        imports?: Record<string, string>;
        props?: Record<string, unknown>;
        maxHeight?: number;
        ok: boolean;
        error?: string;
        idempotencyKey?: string;
      }
    ) => {
      const client = core.clientRef.current;
      if (!client) return;
      const eventPayload: AgenticEvent<"ui.action_bar.updated">["payload"] = {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "action_bar",
        cleared: action === "cleared",
        result: payload.ok ? { ok: true } : { ok: false, error: payload.error }
      };
      if (payload.id !== undefined) eventPayload.id = payload.id;
      if (payload.path !== undefined) eventPayload.source = { type: "file", path: payload.path };
      if (payload.imports !== undefined) eventPayload.imports = payload.imports;
      if (payload.props !== undefined) eventPayload.props = payload.props;
      if (payload.maxHeight !== undefined) eventPayload.maxHeight = payload.maxHeight;
      await publishTypedAgenticEvent(
        {
          kind: "ui.action_bar.updated",
          actor: actorForClient(client, metadata),
          payload: eventPayload,
          createdAt: new Date().toISOString()
        },
        {
          idempotencyKey: payload.idempotencyKey ?? `ui:action-bar:${crypto.randomUUID()}`
        }
      );
    },
    [core.clientRef, metadata, publishTypedAgenticEvent]
  );
  const loadActionBarFromFile = useCallback(
    async ({
      path,
      props,
      maxHeight,
      imports,
      persistStateArgs = true,
      idempotencyKey
    }: {
      path: string;
      props?: Record<string, unknown>;
      maxHeight?: number;
      imports?: Record<string, string>;
      persistStateArgs?: boolean;
      idempotencyKey?: string;
    }): Promise<
      | {
          ok: true;
          id: string;
        }
      | {
          ok: false;
          error: string;
        }
    > => {
      const trimmedPath = path.trim();
      if (!trimmedPath) return { ok: false, error: "Missing path" };
      try {
        await loadSourceFile(trimmedPath);
        const id = crypto.randomUUID();
        setActionBarData({
          id,
          source: { type: "file", path: trimmedPath },
          imports,
          props,
          maxHeight
        });
        lastLoadedActionBarKeyRef.current = actionBarLoadKey(trimmedPath, props, maxHeight);
        if (persistStateArgs) {
          await onActionBarFileChange?.({
            path: trimmedPath,
            props,
            maxHeight
          });
        }
        await publishActionBarContext("loaded", {
          id,
          path: trimmedPath,
          imports,
          props,
          maxHeight,
          ok: true,
          idempotencyKey
        });
        return { ok: true, id };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await publishActionBarContext("loaded", {
          path: trimmedPath,
          imports,
          props,
          maxHeight,
          ok: false,
          error,
          idempotencyKey
        });
        return { ok: false, error };
      }
    },
    [loadSourceFile, onActionBarFileChange, publishActionBarContext]
  );
  const clearActionBar = useCallback(
    async ({
      persistStateArgs = true,
      idempotencyKey
    }: {
      persistStateArgs?: boolean;
      idempotencyKey?: string;
    } = {}) => {
      setActionBarData(null);
      lastLoadedActionBarKeyRef.current = null;
      if (persistStateArgs) {
        await onActionBarFileChange?.({ path: null });
      }
      await publishActionBarContext("cleared", { ok: true, idempotencyKey });
    },
    [onActionBarFileChange, publishActionBarContext]
  );
  const updateActionBarMaxHeight = useCallback(
    (
      maxHeight: number,
      options?: {
        saveState?: boolean;
      }
    ) => {
      setActionBarData((current) => {
        if (!current) return current;
        const next = { ...current, maxHeight };
        if (options?.saveState !== false && current.source.type === "file") {
          void onActionBarFileChange?.({
            path: current.source.path,
            props: current.props,
            maxHeight
          });
        }
        return next;
      });
    },
    [onActionBarFileChange]
  );
  useEffect(() => {
    if (!features.actionBar || !core.connected || !initialActionBarFile) return;
    const loadKey = actionBarLoadKey(
      initialActionBarFile,
      initialActionBarProps,
      initialActionBarMaxHeight
    );
    if (lastLoadedActionBarKeyRef.current === loadKey) return;
    // State-arg action bars decorate the chat; their file validation and
    // publication must not enter the panel RPC path ahead of agent startup.
    return scheduleBackgroundWork(() => {
      void loadActionBarFromFile({
        path: initialActionBarFile,
        props: initialActionBarProps,
        maxHeight: initialActionBarMaxHeight,
        persistStateArgs: false,
        idempotencyKey: `ui:initial-action-bar:${channelName}:${loadKey}`
      });
    });
  }, [
    channelName,
    core.connected,
    initialActionBarFile,
    initialActionBarProps,
    initialActionBarMaxHeight,
    loadActionBarFromFile,
    features.actionBar
  ]);
  // --- Stable refs for connection effect (avoids unstable object deps) ---
  const feedbackRef = useRef(feedback);
  const chatToolsRef = useRef(chatTools);
  const actionsRef = useRef(actions);
  feedbackRef.current = feedback;
  chatToolsRef.current = chatTools;
  actionsRef.current = actions;
  const connectionMethodsRef = useRef({
    clearActionBar,
    loadActionBarFromFile,
    metadata,
    publishTypedAgenticEvent,
    importLoader,
    boundExecuteSandbox,
    loadSourceFile,
    chat,
    scopeManager
  });
  connectionMethodsRef.current = {
    clearActionBar,
    loadActionBarFromFile,
    metadata,
    publishTypedAgenticEvent,
    importLoader,
    boundExecuteSandbox,
    loadSourceFile,
    chat,
    scopeManager
  };
  // Live snapshot for the inspect_card method: agents debug a card by reading
  // the same data the UI's "Copy details" produces.
  const cardInspectionRef = useRef<{
    messages: typeof core.messages;
    registry: Map<string, MessageTypeComponentEntry>;
  }>({ messages: [], registry: new Map() });
  cardInspectionRef.current = {
    messages: core.messages,
    registry: messageTypes.messageTypeComponents
  };
  // --- Connect to channel on mount ---
  useEffect(() => {
    if (!channelName || !config.rpc) return;
    if (core.hasConnectedRef.current) return;
    core.hasConnectedRef.current = true;
    let cancelled = false;
    let connected = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    async function doConnect() {
      let transientAttempt = 0;
      for (;;) {
        try {
          const methodRuntime = connectionMethodsRef.current;
          const toolMethods = chatToolsRef.current.buildToolMethods();
          const methods = composeAgenticChatMethods(
            toolMethods,
            features.feedback
              ? {
                  ...feedbackRef.current.buildFeedbackMethods(),
                  confirm: {
                    description: "Ask the user to approve or deny a requested agent action.",
                    parameters: z
                      .object({
                        question: z.string(),
                        details: z.unknown().optional()
                      })
                      .passthrough(),
                    execute: async (args: unknown, ctx: MethodExecutionContext) => {
                      const input = args as {
                        question?: unknown;
                        details?: unknown;
                      };
                      const question =
                        typeof input.question === "string" && input.question.trim()
                          ? input.question
                          : "Allow this action?";
                      if (typeof document === "undefined" || !document.hasFocus()) {
                        actionsRef.current?.onAttentionRequired?.(
                          "Chat needs your approval",
                          question
                        );
                      }
                      const fb = feedbackRef.current;
                      return new Promise<{
                        granted: boolean;
                        details?: unknown;
                      }>((resolve) => {
                        let settled = false;
                        const finish = (granted: boolean) => {
                          if (settled) return;
                          settled = true;
                          fb.removeFeedback(ctx.callId);
                          resolve({ granted, details: input.details });
                        };
                        fb.addFeedback({
                          type: "schema",
                          callId: ctx.callId,
                          title: question,
                          fields: [
                            ...(input.details
                              ? ([
                                  {
                                    key: "__details",
                                    type: "readonly",
                                    label: "Details",
                                    default:
                                      typeof input.details === "string"
                                        ? input.details
                                        : JSON.stringify(input.details, null, 2)
                                  }
                                ] as ActiveFeedbackSchema["fields"])
                              : []),
                            {
                              key: "approval",
                              type: "buttonGroup",
                              submitOnSelect: true,
                              buttons: [
                                { value: "deny", label: "Deny", color: "gray" },
                                {
                                  value: "allow",
                                  label: "Allow",
                                  color: "green"
                                }
                              ]
                            }
                          ],
                          values: {},
                          hideSubmit: true,
                          dismissible: false,
                          createdAt: Date.now(),
                          complete: (result: FeedbackResult) => {
                            if (result.type === "submit") {
                              const values = (result.value ?? {}) as Record<string, unknown>;
                              finish(values["approval"] === "allow");
                            } else {
                              finish(false);
                            }
                          }
                        });
                      });
                    }
                  }
                }
              : undefined,
            {
              inspect_card: {
                description:
                  "Inspect a custom message card in this conversation: wire payload, renderer registry status " +
                  "(ready / load stage / error), definition metadata, and full update history. Use this when a " +
                  "card you published is not rendering, looks wrong, or a user reports a stuck spinner — it " +
                  "returns exactly what the user's 'Copy details' button shows. Parameters: { messageId: string }.",
                parameters: z.object({
                  messageId: z.string().describe("The custom message id (custom.started messageId)")
                }),
                execute: async (args: unknown) => {
                  const { messageId } = args as { messageId?: string };
                  if (!messageId) return { ok: false, error: "Missing messageId" };
                  const snapshot = cardInspectionRef.current;
                  const message = snapshot.messages.find(
                    (item) => item.custom?.messageId === messageId
                  );
                  if (!message?.custom) {
                    const known = snapshot.messages
                      .filter((item) => item.custom)
                      .map((item) => `${item.custom!.typeId}:${item.custom!.messageId}`);
                    return {
                      ok: false,
                      error: `No custom message "${messageId}" in this channel view.`,
                      knownCards: known
                    };
                  }
                  return {
                    ok: true,
                    details: customInspectorPayload(
                      message.custom,
                      snapshot.registry.get(message.custom.typeId)
                    )
                  };
                }
              },
              persist_agent_model: {
                description: "Persist an agent model choice for panel reload/recovery",
                parameters: z.object({
                  participantId: z.string().describe("Agent participant id"),
                  model: z.string().describe("Model in provider:model format")
                }),
                execute: async (args: unknown) => {
                  const { participantId, model } = args as {
                    participantId?: unknown;
                    model?: unknown;
                  };
                  if (typeof participantId !== "string" || participantId.length === 0) {
                    return { ok: false, error: "Missing participantId" };
                  }
                  if (typeof model !== "string" || model.length === 0) {
                    return { ok: false, error: "Missing model" };
                  }
                  const persist = actionsRef.current?.onPersistAgentModel;
                  if (!persist)
                    return {
                      ok: false,
                      error: "Persist agent model is not available"
                    };
                  await persist(channelName, participantId, model);
                  return { ok: true };
                }
              }
            },
            features.inlineUi
              ? {
                  inline_ui: {
                    description: `Render a persistent interactive UI component inline in the chat.

**Contrast with other tools:**
- \`eval\`: Agent-triggered side-effects. Runs code immediately, returns result.
- \`inline_ui\`: User-triggered side-effects + rich data presentation. Renders controls/visualizations. Users interact when they choose. Non-blocking.
- \`feedback_form\`/\`feedback_custom\`: Blocks until user responds. Returns data to agent.

**The component receives { props, chat, scope, scopes, inlineUi }:**
- props: data you pass via the props parameter
- inlineUi: stable component identity \`{ id, renderedAt }\`; \`renderedAt\` changes
  whenever the same ID is rendered again and can trigger a data-refresh effect
- chat: full chat API for interacting with the conversation:
  - chat.send(content, options?) — send a visible message to the conversation.
    Example: chat.send("User clicked Deploy")
  - chat.publish(type, payload, options?) — publish a typed non-message event.
  - chat.rpc.call(target, method, ...args) — call runtime services directly.
    Example: chat.rpc.call("main", "fs.readFile", "/src/config.ts")
  - chat.contextId, chat.channelId — current identifiers
- scope: panel-local durable UI state shared by inline_ui, feedback_custom, and the action bar in this panel instance. Serializable values persist in localStorage across panel reloads; functions, class instances, DOM objects, and other nonserializable values are live-only and are dropped on restore.
- scopes: scope API for this panel-local UI scope:
  - scopes.save() — force-persist now
  - scopes.push() — archive current scope and start a new snapshot
  - scopes.list() / scopes.get(id) — inspect snapshots

**Side effects users can trigger from inline UI:**
- Send messages back to chat (triggers new agent turns)
- Read/write files, query databases, manage workers via chat.rpc
- Copy to clipboard, open links, any browser API

**Lifecycle:** Component starts expanded. Auto-collapses if taller than 400px.
Users can expand/collapse at any time. Persists in chat history.
Pass a stable \`id\` to update an existing inline UI. A later render by the same
participant with that ID replaces the card and moves it to the newest transcript
position. Omit \`id\` for a new independent card.

**Available imports:** react, @radix-ui/themes, @radix-ui/react-icons
You may provide either \`code\` or \`path\`. \`path\` reads a context-relative TSX file, supports static relative imports, and infers bare package imports from the nearest package.json when possible. Use \`imports\` for explicit package versions.
**Must use** \`export default\`

**Example:**
\`\`\`tsx
import { useState } from "react";
import { Button, Flex, Text, Table } from "@radix-ui/themes";
import { CopyIcon, CheckIcon } from "@radix-ui/react-icons";

export default function App({ props, chat, scope }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(props.data, null, 2));
    scope.lastCopiedAt = new Date();
    setCopied(true);
  };
  return (
    <Flex direction="column" gap="2">
      <Table.Root size="1">
        <Table.Header>
          <Table.Row>
            {props.columns.map(c => <Table.ColumnHeaderCell key={c}>{c}</Table.ColumnHeaderCell>)}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {props.data.map((row, i) => (
            <Table.Row key={i}>
              {props.columns.map(c => <Table.Cell key={c}>{row[c]}</Table.Cell>)}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      <Flex gap="2">
        <Button size="1" variant="soft" onClick={handleCopy}>
          {copied ? <><CheckIcon /> Copied</> : <><CopyIcon /> Copy as JSON</>}
        </Button>
        <Button size="1" variant="soft" onClick={() => chat.send("User requested data refresh")}>
          Refresh
        </Button>
      </Flex>
    </Flex>
  );
}
\`\`\``,
                    parameters: z.object({
                      id: z
                        .string()
                        .trim()
                        .min(1)
                        .optional()
                        .describe(
                          "Stable component ID. Reusing it updates and bumps the existing card; omit it to create a new card."
                        ),
                      code: z
                        .string()
                        .optional()
                        .describe(
                          "TSX source code for the component. Provide either code or path."
                        ),
                      path: z
                        .string()
                        .optional()
                        .describe(
                          "Context-relative TSX file to render instead of inline code. Supports static relative imports."
                        ),
                      imports: z
                        .record(z.string(), z.string())
                        .optional()
                        .describe("On-demand package builds. Same semantics as eval imports."),
                      props: z
                        .record(z.unknown())
                        .optional()
                        .describe("Props passed to the component as { props }")
                    }),
                    execute: async (args: unknown) => {
                      const {
                        id: requestedId,
                        code,
                        path,
                        imports,
                        props
                      } = args as {
                        id?: string;
                        code?: string;
                        path?: string;
                        imports?: Record<string, string>;
                        props?: Record<string, unknown>;
                      };
                      const trimmedPath = path?.trim();
                      if (trimmedPath) {
                        await methodRuntime.loadSourceFile(trimmedPath);
                      } else if (!code) {
                        return { ok: false, error: "Missing code or path" };
                      }
                      if (imports && Object.keys(imports).length > 0) {
                        const { executeSandbox } = await import("@workspace/eval/sandbox");
                        await executeSandbox("", {
                          imports,
                          ...(methodRuntime.importLoader
                            ? { loadImport: methodRuntime.importLoader }
                            : {})
                        });
                      }
                      const client = core.clientRef.current;
                      if (!client) return { ok: false, error: "Not connected" };
                      const id = requestedId?.trim() || crypto.randomUUID();
                      const source = trimmedPath
                        ? { type: "file" as const, path: trimmedPath }
                        : { type: "code" as const, code: code! };
                      const eventPayload: AgenticEvent<"ui.inline_rendered">["payload"] = {
                        protocol: AGENTIC_PROTOCOL_VERSION,
                        uiType: "inline",
                        id,
                        source
                      };
                      if (imports !== undefined) eventPayload.imports = imports;
                      if (props !== undefined) eventPayload.props = props;
                      await methodRuntime.publishTypedAgenticEvent(
                        {
                          kind: "ui.inline_rendered",
                          actor: actorForClient(client, methodRuntime.metadata),
                          payload: eventPayload,
                          createdAt: new Date().toISOString()
                        },
                        // The component ID is intentionally reusable. Event idempotency
                        // remains unique so a later render is reduced as an update.
                        {
                          idempotencyKey: `ui:inline:${id}:${crypto.randomUUID()}`
                        }
                      );
                      return { ok: true, id };
                    }
                  }
                }
              : undefined,
            features.actionBar
              ? {
                  load_action_bar: {
                    description: `Load, replace, or clear a compact persistent action bar at the top of this chat panel.

Use this for small always-available controls or status for the current workflow.
The TSX source is read from a file in this panel's current filesystem context.
The loaded component receives { props, chat, scope, scopes }, supports the same
imports as inline_ui, supports static relative imports from the loaded file,
infers bare package imports from the nearest package.json when possible, and
must export default.

Unlike inline_ui, load_action_bar does not add visible chat history. The latest
loaded file replaces any previous action bar for this panel only. Other panels
connected to this channel may be in different filesystem contexts.
Keep it compact; the panel clamps the rendered height to a small scrollable area.
Use package imports available to inline_ui plus relative imports for local helper files.`,
                    parameters: z.object({
                      path: z
                        .string()
                        .optional()
                        .describe(
                          "Context-relative TSX file to load. Required unless clear is true."
                        ),
                      imports: z
                        .record(z.string(), z.string())
                        .optional()
                        .describe("On-demand package builds. Same semantics as eval imports."),
                      props: z
                        .record(z.unknown())
                        .optional()
                        .describe("Props passed to the component as { props }"),
                      maxHeight: z
                        .number()
                        .optional()
                        .describe(
                          "Preferred maximum height in pixels. Defaults to 180 and is clamped between 64 and 360."
                        ),
                      clear: z
                        .boolean()
                        .optional()
                        .describe("When true, remove the current action bar.")
                    }),
                    execute: async (args: unknown) => {
                      const { path, imports, props, maxHeight, clear } = args as {
                        path?: string;
                        imports?: Record<string, string>;
                        props?: Record<string, unknown>;
                        maxHeight?: number;
                        clear?: boolean;
                      };
                      if (clear) {
                        await methodRuntime.clearActionBar();
                        return { ok: true, cleared: true };
                      }
                      if (!path) return { ok: false, error: "Missing path" };
                      return methodRuntime.loadActionBarFromFile({
                        path,
                        imports,
                        props,
                        maxHeight
                      });
                    }
                  }
                }
              : undefined,
            features.feedback
              ? {
                  // ui_prompt — serves VibestudioExtensionUIContext (select/confirm/input/editor)
                  // from workspace/packages/harness. The agent worker forwards extension UI calls
                  // via ui_prompt { kind, ...params }; we render them through the
                  // existing feedback_form (ActiveFeedbackSchema) machinery and return
                  // primitive results (string | boolean | undefined) directly.
                  ui_prompt: {
                    description:
                      "Prompt the panel user for a select/confirm/input/editor response (used by Vibestudio extension UI bridge).",
                    parameters: z
                      .object({
                        kind: z.enum(["select", "confirm", "input", "editor"]),
                        title: z.string(),
                        message: z.string().optional(),
                        options: z.array(z.string()).optional(),
                        placeholder: z.string().optional(),
                        prefill: z.string().optional()
                      })
                      .passthrough(),
                    execute: async (args: unknown, ctx: MethodExecutionContext) => {
                      const { kind, title, message, options, placeholder, prefill } = args as {
                        kind: "select" | "confirm" | "input" | "editor";
                        title: string;
                        message?: string;
                        options?: string[];
                        placeholder?: string;
                        prefill?: string;
                      };
                      if (typeof document === "undefined" || !document.hasFocus()) {
                        actionsRef.current?.onAttentionRequired?.("Chat is waiting for you", title);
                      }
                      // Build FieldDefinition[] and an initial values map based on kind.
                      let fields: ActiveFeedbackSchema["fields"];
                      let initialValues: ActiveFeedbackSchema["values"] = {};
                      let resolveKey: "choice" | "answer" | "value";
                      let hideSubmit = false;
                      if (kind === "select") {
                        const opts = options ?? [];
                        resolveKey = "choice";
                        fields = [
                          {
                            key: "choice",
                            type: "select",
                            label: title,
                            required: true,
                            options: opts.map((o) => ({ value: o, label: o })),
                            submitOnSelect: true
                          }
                        ];
                        hideSubmit = true;
                      } else if (kind === "confirm") {
                        resolveKey = "answer";
                        fields = [
                          ...(message
                            ? ([
                                {
                                  key: "__msg",
                                  type: "readonly",
                                  label: "",
                                  default: message
                                }
                              ] as ActiveFeedbackSchema["fields"])
                            : []),
                          {
                            key: "answer",
                            type: "buttonGroup",
                            submitOnSelect: true,
                            buttons: [
                              { value: "no", label: "No", color: "gray" },
                              { value: "yes", label: "Yes", color: "green" }
                            ]
                          }
                        ];
                        hideSubmit = true;
                      } else if (kind === "input") {
                        resolveKey = "value";
                        fields = [
                          {
                            key: "value",
                            type: "string",
                            label: title,
                            placeholder: placeholder ?? ""
                          }
                        ];
                      } else {
                        resolveKey = "value";
                        fields = [
                          {
                            key: "value",
                            type: "textarea",
                            label: title,
                            default: prefill ?? "",
                            maxHeight: 320
                          }
                        ];
                      }
                      void ctx;
                      const fb = feedbackRef.current;
                      return new Promise<string | boolean | undefined>((resolve) => {
                        let settled = false;
                        const finish = (
                          value: string | boolean | undefined,
                          historyResult: unknown
                        ) => {
                          if (settled) return;
                          settled = true;
                          fb.removeFeedback(ctx.callId);
                          void historyResult;
                          resolve(value);
                        };
                        const entry: ActiveFeedbackSchema = {
                          type: "schema",
                          callId: ctx.callId,
                          title,
                          fields,
                          values: initialValues,
                          hideSubmit,
                          createdAt: Date.now(),
                          complete: (result: FeedbackResult) => {
                            if (result.type === "submit") {
                              const values = (result.value ?? {}) as Record<string, unknown>;
                              const raw = values[resolveKey];
                              if (kind === "confirm") {
                                finish(raw === "yes" || raw === true, raw);
                              } else if (kind === "select") {
                                finish(typeof raw === "string" ? raw : undefined, raw);
                              } else {
                                // input or editor
                                finish(typeof raw === "string" ? raw : undefined, raw);
                              }
                            } else if (result.type === "cancel") {
                              finish(kind === "confirm" ? false : undefined, null);
                            } else {
                              finish(kind === "confirm" ? false : undefined, null);
                            }
                          }
                        };
                        fb.addFeedback(entry);
                      });
                    }
                  }
                }
              : undefined,
            features.clientEval
              ? {
                  client_eval: buildClientEvalMethod({
                    importLoader: methodRuntime.importLoader,
                    executeSandbox: methodRuntime.boundExecuteSandbox,
                    loadSourceFile: methodRuntime.loadSourceFile,
                    getChat: () => methodRuntime.chat,
                    scopeManager: methodRuntime.scopeManager
                  })
                }
              : undefined
          );
          await core.connectToChannel({
            channelId: channelName,
            methods,
            channelConfig,
            contextId
          });
          connected = true;
          return;
        } catch (err) {
          if (cancelled) return;
          if (!isTransientConnectionFailure(err)) {
            console.error("[Chat] Connection error:", err);
            return;
          }
          const delayMs = connectionRetryDelayMs(transientAttempt++);
          console.warn(`[Chat] Transient connection failure; retrying in ${delayMs}ms`, err);
          await new Promise<void>((resolve) => {
            retryTimer = setTimeout(resolve, delayMs);
          });
          retryTimer = undefined;
          if (cancelled) return;
        }
      }
    }
    void doConnect();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      if (!connected) core.hasConnectedRef.current = false;
    };
  }, [
    channelName,
    channelConfig,
    contextId,
    core.connectToChannel,
    config.rpc,
    core.hasConnectedRef,
    core.selfIdRef,
    core.clientRef,
    connectionAttempt,
    connectionRetrySignal,
    features
  ]);
  // --- Wrap platform actions ---
  const handleAddAgent = useCallback(
    async (agentId?: string, config?: AgentSubscriptionConfig) => {
      if (!actions?.onAddAgent) return;
      const launcherContextId = core.clientRef.current?.contextId;
      await actions.onAddAgent(channelName, launcherContextId, agentId, config);
    },
    [channelName, core.clientRef, actions]
  );
  const handlePrepareAgent = useCallback(
    async (agentId: string | undefined, config: AgentSubscriptionConfig | null) => {
      if (!actions?.onPrepareAgent) return;
      const launcherContextId = core.clientRef.current?.contextId;
      await actions.onPrepareAgent(channelName, launcherContextId, agentId, config);
    },
    [channelName, core.clientRef, actions]
  );
  const handleReplaceAgent = useCallback(
    async (participantId: string, agentId?: string, config?: AgentSubscriptionConfig) => {
      if (!actions?.onReplaceAgent) return;
      await actions.onReplaceAgent(channelName, participantId, agentId, config);
    },
    [channelName, actions]
  );
  const handleRemoveAgent = useCallback(
    async (handle: string) => {
      if (!actions?.onRemoveAgent) return;
      await actions.onRemoveAgent(channelName, handle);
    },
    [channelName, actions]
  );
  const sessionEnabled = true; // Always persistent: transcript state is projected from the durable PubSub log.
  const onAddAgent = actions?.onAddAgent ? handleAddAgent : undefined;
  const onPrepareAgent = actions?.onPrepareAgent ? handlePrepareAgent : undefined;
  const onReplaceAgent = actions?.onReplaceAgent ? handleReplaceAgent : undefined;
  const onInstallLocalModel = actions?.onInstallLocalModel;
  const availableAgents = actions?.availableAgents;
  const modelCatalog = actions?.modelCatalog;
  const defaultModelRef = actions?.defaultModelRef;
  const defaultAgentConfig = actions?.defaultAgentConfig;
  const firstAgentModelPreflight = actions?.firstAgentModelPreflight;
  const firstAgentChannelIsNew = actions?.firstAgentChannelIsNew;
  const onSaveDefaults = actions?.onSaveDefaults;
  const onRemoveAgent = actions?.onRemoveAgent ? handleRemoveAgent : undefined;
  const onFocusPanel = actions?.onFocusPanel;
  const onReloadPanel = actions?.onReloadPanel;
  const onOpenChannel = actions?.onOpenChannel;
  const onNewConversation = actions?.onNewConversation;
  const onListTaskRules = actions?.onListTaskRules;
  const onResetTaskRules = actions?.onResetTaskRules;
  const onOpenClaudeCode = actions?.onOpenClaudeCode;
  const onOpenLocalModelsLog = actions?.onOpenLocalModelsLog;
  const onOpenLocalModels = actions?.onOpenLocalModels;

  // --- Deferred first-agent flow (inline config + pre-send delivery queue) ---
  const clearComposer = useCallback(() => {
    core.handleInputChange("");
    core.setPendingImages([]);
  }, [core.handleInputChange, core.setPendingImages]);
  const { deferredAgent, sendMessage: deferredSendMessage } = useDeferredAgent({
    participants: core.participants,
    pendingAgents: core.pendingAgents,
    input: core.input,
    clearComposer,
    publishText: core.publishText,
    maybeSetDefaultTitle: core.maybeSetDefaultTitle,
    coreSendMessage: core.sendMessage,
    onAddAgent,
    onPrepareAgent,
    availableAgents: availableAgents ?? [],
    modelCatalog: modelCatalog ?? null,
    defaultModelRef,
    defaultAgentConfig,
    firstAgentModelPreflight,
    firstAgentChannelIsNew,
    initialPrompt,
    forceInitialPrompt,
    initialPromptIdempotencyKey,
    channelName,
    messages: core.messages,
    replaySettled: core.replaySettled
  });
  // Pre-send queue intercept: the composer's send becomes the deferred wrapper,
  // which holds the first message(s) until the agent it spawns joins the roster.
  const inputContextValue = useMemo<ChatInputContextValue>(
    () => ({ ...core.inputContextValue, onSendMessage: deferredSendMessage }),
    [core.inputContextValue, deferredSendMessage]
  );

  // Keep the observer transport identity independent from transcript and UI
  // updates. Recreating this wrapper as the parent conversation changes makes
  // every mounted child transcript disconnect and start a fresh replay.
  const childTranscript = useMemo(
    () => ({
      config,
      metadata: {
        name: metadata.name,
        type: metadata.type,
        ...(metadata.handle ? { handle: metadata.handle } : {}),
        ...(metadata.panelId ? { panelId: metadata.panelId } : {})
      }
    }),
    [
      config.clientId,
      config.rpc,
      config.protocol,
      config.recoveryCoordinator,
      config.replayMessageLimit,
      config.deliveryMode,
      metadata.name,
      metadata.type,
      metadata.handle,
      metadata.panelId
    ]
  );

  // --- Assemble context values ---
  const contextValue: ChatContextValue = useMemo(
    () => ({
      connected: core.connected,
      replaySettled: core.replaySettled,
      status: core.status,
      channelId: channelName,
      channelTitle: core.channelTitle,
      browserHandoffCaller: {
        id: runtimeCallerId(config.rpc.selfId),
        kind: browserHandoffCallerKindFromMetadata(metadata.type)
      },
      sessionEnabled,
      connectionError: core.connectionError,
      dismissConnectionError: core.dismissConnectionError,
      retryConnection,
      chat,
      clientRef: core.clientRef,
      panelScopeId: config.clientId,
      scope,
      scopes,
      scopeManager,
      messages: core.messages,
      inlineUiComponents: inlineUi.inlineUiComponents,
      messageTypeComponents: messageTypes.messageTypeComponents,
      actionBar: actionBar.actionBar,
      onActionBarMaxHeightChange: updateActionBarMaxHeight,
      hasMoreHistory: core.hasMoreHistory,
      loadingMore: core.loadingMore,
      selfId: core.selfId ? channelParticipantId(core.selfId) : null,
      participants: core.participants,
      allParticipants: core.allParticipants,
      debugEvents: core.debugEvents,
      debugConsoleAgent: debug.debugConsoleAgent,
      dirtyRepoWarnings: core.dirtyRepoWarnings,
      pendingAgents: core.pendingAgents,
      deferredAgent,
      activeFeedbacks: feedback.activeFeedbacks,
      // Resolved appearance (explicit prop OR system) — never a "dark" literal.
      theme: core.theme,
      agentBusy: core.agentBusy,
      hasOpenTurn: core.hasOpenTurn,
      editPendingMessage: core.editPendingMessage,
      cancelPendingMessage: core.cancelPendingMessage,
      flushOutboxAndInterrupt: core.flushOutboxAndInterrupt,
      primaryActionIntent: core.primaryActionIntent,
      flushNarration: core.flushNarration,
      undoableAction: core.undoableAction,
      undoLastAction: core.undoLastAction,
      pendingSendCount: core.pendingSendCount,
      afterTurnMessageIds: core.afterTurnMessageIds,
      onLoadEarlierMessages: core.loadEarlierMessages,
      onInterrupt: core.handleInterruptAgent,
      onCancelInvocation: core.handleCancelInvocation,
      onCallMethod: core.handleCallMethod,
      onCallMethodResult: core.handleCallMethodResult,
      onFeedbackDismiss: feedback.onFeedbackDismiss,
      onFeedbackError: feedback.onFeedbackError,
      onDebugConsoleChange: debug.setDebugConsoleAgent,
      onDismissDirtyWarning: core.onDismissDirtyWarning,
      onAddAgent,
      onReplaceAgent,
      onInstallLocalModel,
      availableAgents,
      modelCatalog,
      defaultModelRef,
      defaultAgentConfig,
      onSaveDefaults,
      onRemoveAgent,
      onFocusPanel,
      onReloadPanel,
      onOpenChannel,
      onNewConversation,
      onListTaskRules,
      onResetTaskRules,
      onOpenClaudeCode,
      onOpenLocalModelsLog,
      onOpenLocalModels,
      toolApproval: chatTools.toolApprovalValue,
      // Fork UI is enabled only when the panel wired navigation handlers.
      forkState: forkNav ? forkState : undefined,
      // Lets subagent cards open an observer connection on a child's task
      // channel; reuses this panel's own transport config.
      childTranscript
    }),
    [
      core.connected,
      core.replaySettled,
      core.status,
      core.channelTitle,
      core.selfId,
      config.rpc.selfId,
      metadata.type,
      core.connectionError,
      core.dismissConnectionError,
      retryConnection,
      config.clientId,
      channelName,
      sessionEnabled,
      chat,
      core.clientRef,
      scope,
      scopes,
      scopeManager,
      scopeVersion,
      core.messages,
      inlineUi.inlineUiComponents,
      messageTypes.messageTypeComponents,
      actionBar.actionBar,
      updateActionBarMaxHeight,
      core.hasMoreHistory,
      core.loadingMore,
      core.participants,
      core.allParticipants,
      core.debugEvents,
      debug.debugConsoleAgent,
      core.dirtyRepoWarnings,
      core.pendingAgents,
      deferredAgent,
      feedback.activeFeedbacks,
      core.theme,
      core.agentBusy,
      core.hasOpenTurn,
      core.editPendingMessage,
      core.cancelPendingMessage,
      core.flushOutboxAndInterrupt,
      core.primaryActionIntent,
      core.flushNarration,
      core.undoableAction,
      core.undoLastAction,
      core.pendingSendCount,
      core.afterTurnMessageIds,
      core.loadEarlierMessages,
      core.handleInterruptAgent,
      core.handleCallMethod,
      core.handleCallMethodResult,
      feedback.onFeedbackDismiss,
      feedback.onFeedbackError,
      debug.setDebugConsoleAgent,
      core.onDismissDirtyWarning,
      onAddAgent,
      onReplaceAgent,
      onInstallLocalModel,
      availableAgents,
      modelCatalog,
      defaultModelRef,
      defaultAgentConfig,
      onSaveDefaults,
      onRemoveAgent,
      onFocusPanel,
      onReloadPanel,
      onOpenChannel,
      onNewConversation,
      onListTaskRules,
      onResetTaskRules,
      onOpenClaudeCode,
      onOpenLocalModelsLog,
      onOpenLocalModels,
      chatTools.toolApprovalValue,
      forkNav,
      forkState,
      childTranscript
    ]
  );
  return { contextValue, inputContextValue, features };
}
