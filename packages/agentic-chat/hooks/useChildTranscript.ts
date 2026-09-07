import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectionManager,
  type ChatParticipantMetadata,
  type ClientParticipantMetadata,
  type ConnectionConfig,
} from "@workspace/agentic-core";
import type { Participant, PubSubClient } from "@workspace/pubsub";
import { useChannelMessages } from "./useChannelMessages.js";

/**
 * Lazily observe a subagent's own task channel so the parent can render the
 * child's REAL transcript — the same messages, tool pills, and argument/result
 * inspection the child's own panel would show — instead of a bounded summary.
 *
 * Deliberately bounded: a card observes while the user has its transcript open,
 * or while a live run is waiting for its canonical terminal fact. The caller
 * disables observation as soon as that terminal is folded, so retained history
 * owns no long-lived transport and no copied progress feed is needed.
 */

export interface ChildTranscriptConnection {
  /** RPC/protocol config reused from the parent panel's own connection. */
  config: ConnectionConfig;
  metadata: ClientParticipantMetadata;
}

export interface ChildTranscriptResult {
  messages: ReturnType<typeof useChannelMessages>["messages"];
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  selfId: string | null;
  /** True until the child's history has replayed. */
  loading: boolean;
  error: string | null;
  hasMoreHistory: boolean;
  loadingMore: boolean;
  loadEarlierMessages: () => Promise<void>;
  /** Start a fresh observer generation after a terminal connection failure. */
  retry: () => void;
}

let nextObserverGeneration = 0;

function observerClientId(base: string, channelId: string): string {
  nextObserverGeneration += 1;
  return `${base}:observe:${channelId}:${nextObserverGeneration}`;
}

export function useChildTranscript(options: {
  connection: ChildTranscriptConnection | null;
  channelId: string | null;
  contextId: string | null;
  enabled: boolean;
}): ChildTranscriptResult {
  const { connection, channelId, contextId, enabled } = options;
  const [client, setClient] = useState<PubSubClient<ChatParticipantMetadata> | null>(null);
  const [participants, setParticipants] = useState<
    Record<string, Participant<ChatParticipantMetadata>>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const managerRef = useRef<ConnectionManager | null>(null);
  const retry = useCallback(() => setRetryGeneration((value) => value + 1), []);

  const active = enabled && Boolean(connection && channelId);

  useEffect(() => {
    if (!active || !connection || !channelId) {
      setClient(null);
      setParticipants({});
      setError(null);
      return;
    }
    let cancelled = false;
    setConnecting(true);
    setError(null);

    // Every ATTEMPT gets a distinct client id. A channel-only suffix is not
    // enough: StrictMode setup/cleanup, a retry, or two views of the same card
    // can otherwise let an older asynchronous disconnect tear down the newer
    // observer with the same registry identity.
    const manager = new ConnectionManager({
      config: {
        ...connection.config,
        clientId: observerClientId(connection.config.clientId, channelId),
      },
      metadata: { ...connection.metadata, type: "panel" },
      callbacks: {
        onRoster: (update) => {
          if (!cancelled) setParticipants({ ...update.participants });
        },
        onError: (err) => {
          if (!cancelled) setError(err.message);
        },
        onReconnect: () => {
          if (!cancelled) setError(null);
        },
      },
    });
    managerRef.current = manager;

    void manager
      .connect({ channelId, methods: {}, ...(contextId ? { contextId } : {}) })
      .then((connected) => {
        if (cancelled) return;
        setClient(connected);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setConnecting(false);
      });

    return () => {
      cancelled = true;
      setClient(null);
      void manager.disconnect().catch(() => {
        /* tearing down an observer connection is best-effort */
      });
      if (managerRef.current === manager) managerRef.current = null;
    };
  }, [active, connection, channelId, contextId, retryGeneration]);

  const transcript = useChannelMessages(active ? client : null);

  return useMemo(
    () => ({
      messages: transcript.messages,
      participants,
      selfId: client?.clientId ?? null,
      loading: active && (connecting || !transcript.replaySettled),
      error,
      hasMoreHistory: transcript.hasMoreHistory,
      loadingMore: transcript.loadingMore,
      loadEarlierMessages: transcript.loadEarlierMessages,
      retry,
    }),
    [
      transcript.messages,
      transcript.replaySettled,
      participants,
      client,
      active,
      connecting,
      error,
      transcript.hasMoreHistory,
      transcript.loadingMore,
      transcript.loadEarlierMessages,
      retry,
    ]
  );
}
