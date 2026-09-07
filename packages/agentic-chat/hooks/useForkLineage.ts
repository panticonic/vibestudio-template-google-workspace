/** Durable fork-lineage state and actions for the agentic chat surface. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RpcCaller } from "@vibestudio/rpc";
import { forkConversation, type ForkLocus } from "@workspace/channel-fork";
import type { ChatMessage } from "@workspace/agentic-core";
import type { ForkProjection, MessageBlockInput } from "@workspace/agentic-protocol";
import { readChannelSubscriptionRecords, type PubSubClient } from "@workspace/pubsub";
import { isReviewPending } from "@vibestudio/shared/authority/reviewPending";
import type {
  ChannelProvenance,
  ChatParticipantMetadata,
  ForkEntry,
  ForkNavHandlers,
  ForkTreeNode,
  ForkUiState,
} from "../types";

const CHANNEL_SERVICE_PROTOCOL = "vibestudio.channel.v1";
const FORK_HEAD_CHANGED_SIGNAL = "fork.head_changed";

interface ForkRpc {
  call<R = unknown>(targetId: string, method: string, args: unknown[]): Promise<R>;
  stream?(
    targetId: string,
    method: string,
    args: unknown[],
    options?: { signal?: AbortSignal; bodyIdleTimeoutMs?: number | null }
  ): Promise<Response>;
  selfId: string;
}

interface ResolvedChannelService {
  source: string;
  className: string;
  objectKey: string;
  targetId?: string;
}

interface ForkListResult {
  forks: ForkProjection[];
  headSeq: number;
}

export interface UseForkLineageOptions {
  rpc: ForkRpc;
  channelId: string | null;
  contextId?: string;
  selfId: string | null;
  selfMetadata?: { name?: string; type?: string; handle?: string };
  messages: ChatMessage[];
  replaySettled: boolean;
  /** Changes when a workspace review may have unblocked cursor persistence. */
  retrySignal?: number;
  /** Connection readiness only; lineage has its own response-owned stream. */
  client?: PubSubClient<ChatParticipantMetadata> | null;
  nav?: ForkNavHandlers;
}

async function resolveChannelTarget(rpc: ForkRpc, channelId: string): Promise<string> {
  const svc = await rpc.call<ResolvedChannelService>("main", "workers.resolveService", [
    CHANNEL_SERVICE_PROTOCOL,
    channelId,
  ]);
  return svc.targetId ?? `do:${svc.source}:${svc.className}:${svc.objectKey}`;
}

async function readProvenance(rpc: ForkRpc, channelId: string): Promise<ChannelProvenance> {
  return rpc.call(await resolveChannelTarget(rpc, channelId), "getProvenance", []);
}

async function readForks(rpc: ForkRpc, channelId: string): Promise<ForkListResult> {
  return rpc.call(await resolveChannelTarget(rpc, channelId), "listForks", []);
}

function forkProjectionToEntry(fork: ForkProjection): ForkEntry {
  return {
    forkId: fork.forkId,
    parentChannelId: fork.parentChannelId,
    channelId: fork.forkedChannelId,
    contextId: fork.forkedContextId,
    label: fork.label || fork.reason || "Fork",
    reason: fork.reason,
    actorName: fork.actor.displayName ?? fork.actor.id,
    actorId: fork.actor.participantId ?? fork.actor.id,
    forkPointId: fork.forkPointId,
    createdAtSeq: fork.createdAtSeq,
    headSeq: fork.headSeq,
    archived: fork.archived,
  };
}

function conciseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function messageExcerpt(message: ChatMessage): string {
  const text = message.content.trim().replace(/\s+/g, " ");
  return text.length > 42 ? `${text.slice(0, 41)}…` : text || "message";
}

export function useForkLineage(options: UseForkLineageOptions): ForkUiState {
  const { rpc, channelId, contextId, selfId, replaySettled, retrySignal, client, nav } = options;
  const enabled = Boolean(nav);
  const connected = Boolean(client);
  const navRef = useRef(nav);
  navRef.current = nav;

  const [provenance, setProvenance] = useState<ChannelProvenance>();
  const [currentLabel, setCurrentLabel] = useState("Main");
  const [baseChildren, setBaseChildren] = useState<ForkEntry[]>([]);
  const [baseSiblings, setBaseSiblings] = useState<ForkEntry[]>([]);
  const [currentHead, setCurrentHead] = useState(0);
  const [liveHeads, setLiveHeads] = useState<Record<string, number>>({});
  const [readCursors, setReadCursors] = useState<Record<string, number>>({});
  const readCursorsRef = useRef<Record<string, number>>({});
  readCursorsRef.current = readCursors;
  const [forking, setForking] = useState(false);
  const [error, setError] = useState<string>();

  const reportError = useCallback((summary: string, cause: unknown) => {
    setError(`${summary}: ${conciseError(cause)}`);
  }, []);

  const markRead = useCallback(async (readChannelId: string, headSeq: number) => {
    if (headSeq <= 0) return;
    const prior =
      navRef.current?.readForkCursors?.()[readChannelId] ??
      readCursorsRef.current[readChannelId] ??
      0;
    if (prior >= headSeq) return;
    try {
      await navRef.current?.markForkRead?.(readChannelId, headSeq);
    } catch (cause) {
      // A workspace creation/install review temporarily holds gated panel
      // state writes. It is not a persistence failure: leave the cursor stale
      // so the approval-change retry can write the same monotone head later.
      if (isReviewPending(cause)) return;
      throw cause;
    }
    setReadCursors((current) => {
      const next = {
        ...current,
        [readChannelId]: Math.max(current[readChannelId] ?? 0, headSeq),
      };
      readCursorsRef.current = next;
      return next;
    });
  }, []);

  const refreshData = useCallback(async (): Promise<void> => {
    if (!enabled || !channelId) return;
    try {
      const [prov, own] = await Promise.all([
        readProvenance(rpc, channelId),
        readForks(rpc, channelId),
      ]);
      let siblings: ForkEntry[] = [];
      let label = prov.kind === "task" ? "Subagent task" : prov.kind === "fork" ? "Fork" : "Main";
      if (prov.kind === "fork") {
        const parent = await readForks(rpc, prov.forkedFrom);
        const self = parent.forks.find((fork) => fork.forkedChannelId === channelId);
        if (self) label = self.label || self.reason || "Fork";
        siblings = parent.forks
          .filter((fork) => fork.forkedChannelId !== channelId && !fork.archived)
          .map(forkProjectionToEntry);
      }
      setProvenance(prov);
      setCurrentLabel(label);
      setCurrentHead(own.headSeq);
      setBaseChildren(own.forks.filter((fork) => !fork.archived).map(forkProjectionToEntry));
      setBaseSiblings(siblings);
      setReadCursors(navRef.current?.readForkCursors?.() ?? {});
    } catch (cause) {
      setError(`Could not load conversation forks: ${conciseError(cause)}`);
    }
  }, [enabled, channelId, rpc]);

  useEffect(() => {
    if (!enabled) return;
    if (!channelId) {
      setProvenance(undefined);
      setBaseChildren([]);
      setBaseSiblings([]);
      return;
    }
    if (!connected) return;
    void refreshData();
  }, [enabled, channelId, connected, refreshData]);

  useEffect(() => {
    if (!enabled || !replaySettled || !channelId || currentHead <= 0) return;
    void markRead(channelId, currentHead).catch((cause) =>
      reportError("Could not save the conversation read position", cause)
    );
  }, [enabled, replaySettled, channelId, currentHead, retrySignal, markRead, reportError]);

  const lineageRootId =
    !channelId || !provenance
      ? null
      : provenance.kind === "fork"
        ? provenance.rootChannelId
        : channelId;

  // A response-owned stream provides live invalidations. Durable heads from
  // listForks remain the source of truth after reconnect or missed signals.
  useEffect(() => {
    if (!enabled || !lineageRootId || !selfId || !rpc.stream) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const target = await resolveChannelTarget(rpc, lineageRootId);
        const response = await rpc.stream!(target, "subscribeLineage", [selfId], {
          signal: abort.signal,
          bodyIdleTimeoutMs: null,
        });
        for await (const record of readChannelSubscriptionRecords(response)) {
          if (record.kind !== "message") continue;
          const signal = record.payload as {
            kind?: unknown;
            payload?: { contentType?: unknown; content?: unknown };
          };
          if (
            signal.kind !== "signal" ||
            signal.payload?.contentType !== FORK_HEAD_CHANGED_SIGNAL
          ) {
            continue;
          }
          const parsed = JSON.parse(String(signal.payload.content)) as {
            channelId?: unknown;
            headSeq?: unknown;
            rosterChanged?: unknown;
          };
          if (typeof parsed.channelId !== "string" || typeof parsed.headSeq !== "number") continue;
          setLiveHeads((current) => ({
            ...current,
            [parsed.channelId as string]: Math.max(
              current[parsed.channelId as string] ?? 0,
              parsed.headSeq as number
            ),
          }));
          if (parsed.channelId === channelId) {
            void markRead(parsed.channelId, parsed.headSeq).catch((cause) =>
              reportError("Could not save the conversation read position", cause)
            );
            if (parsed.rosterChanged === true) void refreshData();
          }
        }
      } catch (cause) {
        if (!abort.signal.aborted) {
          setError(`Live fork updates disconnected: ${conciseError(cause)}`);
        }
      }
    })();
    return () => abort.abort();
  }, [enabled, rpc, lineageRootId, selfId, channelId, markRead, refreshData, reportError]);

  const decorate = useCallback(
    (entries: ForkEntry[]): ForkEntry[] =>
      entries.map((entry) => {
        const headSeq = Math.max(entry.headSeq, liveHeads[entry.channelId] ?? 0);
        return {
          ...entry,
          headSeq,
          unread: headSeq > (readCursors[entry.channelId] ?? 0),
        };
      }),
    [liveHeads, readCursors]
  );
  const children = useMemo(() => decorate(baseChildren), [decorate, baseChildren]);
  const siblings = useMemo(() => decorate(baseSiblings), [decorate, baseSiblings]);

  // Notify the shell for newly materialized external forks. Focus policy belongs
  // to the shell notification service, which has the actual panel/window state.
  const seenForkIdsRef = useRef<Set<string> | null>(null);
  const seenForkChannelRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (seenForkChannelRef.current !== channelId) {
      seenForkChannelRef.current = channelId;
      seenForkIdsRef.current = null;
    }
    if (seenForkIdsRef.current === null) {
      seenForkIdsRef.current = new Set(baseChildren.map((entry) => entry.forkId));
      return;
    }
    for (const entry of baseChildren) {
      if (seenForkIdsRef.current.has(entry.forkId)) continue;
      seenForkIdsRef.current.add(entry.forkId);
      if (selfId === null || entry.actorId !== selfId) {
        void (async () => {
          try {
            await navRef.current?.onExternalFork?.({
              forkedChannelId: entry.channelId,
              forkedContextId: entry.contextId,
              actorName: entry.actorName,
              forkPointId: entry.forkPointId,
            });
          } catch (cause) {
            reportError("Could not notify about a new conversation fork", cause);
          }
        })();
      }
    }
  }, [enabled, baseChildren, selfId, reportError]);

  const parent = useMemo(() => {
    if (provenance?.kind === "fork") {
      return { channelId: provenance.forkedFrom, contextId: provenance.parentContextId };
    }
    if (provenance?.kind === "task") {
      return { channelId: provenance.parentChannelId, contextId: provenance.parentContextId };
    }
    return undefined;
  }, [provenance]);

  const loadTreeData = useCallback(async (): Promise<ForkTreeNode[]> => {
    if (!enabled || !channelId) return [];
    const contextByChannel = new Map<string, string | undefined>([[channelId, contextId]]);
    let rootChannelId = channelId;
    let cursor = channelId;
    const ancestrySeen = new Set<string>();
    while (!ancestrySeen.has(cursor)) {
      ancestrySeen.add(cursor);
      const cursorProvenance = await readProvenance(rpc, cursor);
      if (cursorProvenance.kind === "fork") {
        rootChannelId = cursorProvenance.rootChannelId;
        contextByChannel.set(cursorProvenance.forkedFrom, cursorProvenance.parentContextId);
        cursor = cursorProvenance.forkedFrom;
        continue;
      }
      if (cursorProvenance.kind === "task") {
        contextByChannel.set(cursorProvenance.parentChannelId, cursorProvenance.parentContextId);
        cursor = cursorProvenance.parentChannelId;
        rootChannelId = cursor;
        continue;
      }
      rootChannelId = cursor;
      break;
    }
    const seen = new Set<string>();
    const build = async (
      nodeChannelId: string,
      nodeContextId: string | undefined,
      label: string,
      provenanceKind: "root" | "fork" | "task"
    ): Promise<ForkTreeNode> => {
      if (seen.has(nodeChannelId)) {
        return {
          channelId: nodeChannelId,
          contextId: nodeContextId,
          label,
          provenanceKind,
          isCurrent: nodeChannelId === channelId,
          headSeq: 0,
          children: [],
        };
      }
      seen.add(nodeChannelId);
      const listed = await readForks(rpc, nodeChannelId);
      const childNodes = await Promise.all(
        listed.forks
          .filter((fork) => !fork.archived)
          .map((fork) => {
            contextByChannel.set(fork.forkedChannelId, fork.forkedContextId);
            return build(fork.forkedChannelId, fork.forkedContextId, fork.label, "fork");
          })
      );
      return {
        channelId: nodeChannelId,
        contextId: nodeContextId,
        label,
        provenanceKind,
        isCurrent: nodeChannelId === channelId,
        headSeq: Math.max(liveHeads[nodeChannelId] ?? 0, listed.headSeq),
        unread:
          nodeChannelId !== channelId &&
          Math.max(liveHeads[nodeChannelId] ?? 0, listed.headSeq) >
            (readCursors[nodeChannelId] ?? 0),
        children: childNodes,
      };
    };
    return [await build(rootChannelId, contextByChannel.get(rootChannelId), "Main", "root")];
  }, [enabled, rpc, channelId, contextId, liveHeads, readCursors]);

  const loadTree = useCallback(async (): Promise<ForkTreeNode[]> => {
    try {
      setError(undefined);
      return await loadTreeData();
    } catch (cause) {
      setError(`Could not load conversation tree: ${conciseError(cause)}`);
      return [];
    }
  }, [loadTreeData]);

  const runFork = useCallback(
    async (opts: {
      locus: ForkLocus;
      reason: string;
      label: string;
      seedText?: string;
      replacesMessageId?: string;
    }) => {
      if (!enabled || !channelId || !navRef.current) return;
      setForking(true);
      setError(undefined);
      try {
        const seed = opts.seedText
          ? {
              blocks: [
                {
                  blockId: `fork-seed:${crypto.randomUUID()}` as never,
                  type: "text" as const,
                  content: opts.seedText,
                },
              ] as MessageBlockInput[],
              ...(opts.replacesMessageId
                ? { replaces: { messageId: opts.replacesMessageId } }
                : {}),
            }
          : undefined;
        const result = await forkConversation(rpc as RpcCaller, {
          channelId,
          locus: opts.locus,
          reason: opts.reason,
          label: opts.label,
          ...(seed ? { seed } : {}),
        });
        await navRef.current.switchTo(result.forkedChannelId, result.forkedContextId);
      } catch (cause) {
        setError(`Could not create fork: ${conciseError(cause)}`);
        throw cause;
      } finally {
        setForking(false);
      }
    },
    [enabled, channelId, rpc]
  );

  const forkFromMessage = useCallback(
    async (message: ChatMessage) =>
      runFork({
        locus: { kind: "after-message", messageId: message.id },
        reason: "fork",
        label: `After “${messageExcerpt(message)}”`,
      }),
    [runFork]
  );
  const editAndForkMessage = useCallback(
    async (message: ChatMessage, newText: string) =>
      runFork({
        locus: { kind: "before-message", messageId: message.id },
        reason: "edit",
        label: `Edited “${messageExcerpt(message)}”`,
        seedText: newText,
        replacesMessageId: message.id,
      }),
    [runFork]
  );
  const newFork = useCallback(
    async () => runFork({ locus: { kind: "head" }, reason: "fork", label: "New direction" }),
    [runFork]
  );

  const mutateFork = useCallback(
    async (entry: ForkEntry, method: "renameFork" | "archiveFork", args: unknown[]) => {
      try {
        setError(undefined);
        const target = await resolveChannelTarget(rpc, entry.parentChannelId);
        await rpc.call(target, method, [entry.forkId, ...args]);
        await refreshData();
      } catch (cause) {
        setError(`Could not update fork: ${conciseError(cause)}`);
        throw cause;
      }
    },
    [rpc, refreshData]
  );
  const renameFork = useCallback(
    (entry: ForkEntry, label: string) => mutateFork(entry, "renameFork", [label]),
    [mutateFork]
  );
  const archiveFork = useCallback(
    (entry: ForkEntry) => mutateFork(entry, "archiveFork", []),
    [mutateFork]
  );
  const clearError = useCallback(() => setError(undefined), []);
  const refresh = useCallback(() => void refreshData(), [refreshData]);
  const switchTo = useCallback(async (targetChannelId: string, targetContextId: string) => {
    try {
      await navRef.current?.switchTo(targetChannelId, targetContextId);
    } catch (cause) {
      setError(`Could not switch conversations: ${conciseError(cause)}`);
      throw cause;
    }
  }, []);
  const openInNewPanel = useCallback(async (targetChannelId: string, targetContextId: string) => {
    try {
      await navRef.current?.openInNewPanel(targetChannelId, targetContextId);
    } catch (cause) {
      setError(`Could not open conversation: ${conciseError(cause)}`);
      throw cause;
    }
  }, []);
  const readPersistedCursors = useCallback(() => navRef.current?.readForkCursors?.() ?? {}, []);
  const notifyExternalFork = useCallback(
    (fork: Parameters<NonNullable<ForkNavHandlers["onExternalFork"]>>[0]) =>
      navRef.current?.onExternalFork?.(fork),
    []
  );

  return useMemo(
    () => ({
      provenance,
      currentLabel,
      children,
      siblings,
      parent,
      forking,
      error,
      refresh,
      loadTree,
      actions: {
        forkFromMessage,
        editAndForkMessage,
        newFork,
        renameFork,
        archiveFork,
        clearError,
        reportError,
        switchTo,
        openInNewPanel,
        readForkCursors: readPersistedCursors,
        markForkRead: markRead,
        onExternalFork: notifyExternalFork,
      },
    }),
    [
      provenance,
      currentLabel,
      children,
      siblings,
      parent,
      forking,
      error,
      refresh,
      loadTree,
      forkFromMessage,
      editAndForkMessage,
      newFork,
      renameFork,
      archiveFork,
      clearError,
      reportError,
      switchTo,
      openInNewPanel,
      markRead,
      readPersistedCursors,
      notifyExternalFork,
    ]
  );
}
