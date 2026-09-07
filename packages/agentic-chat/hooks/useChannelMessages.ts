/**
 * useChannelMessages — React subscription to transcript channel messages.
 *
 * Consumes canonical agentic trajectory events from opaque channel envelopes
 * and reduces them into the flat ChatMessage[] array used by the transcript UI.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  iterateChannelReplayAfterPages,
  type Attachment,
  type PubSubClient,
  type ParticipantMetadata,
} from "@workspace/pubsub";
import {
  actionBarPayloadFromChannelView,
  type ActionBarPayload,
  type ChatMessage,
  chatMessagesFromChannelView,
  messageTypeDefinitionsFromChannelView,
  type MessageTypeDefinition,
} from "@workspace/agentic-core";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  CREDENTIAL_CONNECT_PAYLOAD_KIND,
  applyMessageEvent,
  createInitialChannelViewState,
  pubsubChannelEventToEnvelope,
  reduceChannelView,
  type AgenticEvent,
  type ChannelEnvelope,
  type ChannelViewState,
} from "@workspace/agentic-protocol";

/** Maximum messages in the visible window. New messages push oldest out. */
const MAX_VISIBLE = 2000;
/** How many messages to fetch per pagination request. */
const PAGE_SIZE = 500;

export interface UseChannelMessagesResult {
  messages: ChatMessage[];
  actionBar: ActionBarPayload | null;
  messageTypes: MessageTypeDefinition[];
  hasMoreHistory: boolean;
  loadingMore: boolean;
  /** True while any agent turn is in the `open` state (turn lifecycle signal). */
  hasOpenTurn: boolean;
  loadEarlierMessages: () => Promise<void>;
  backfillAfterLocalPublish: (pubsubId: number | undefined) => Promise<void>;
  /** True once the initial replay is complete, so `messages` reliably reflects
   *  prior history (a reliable "is this a brand-new chat?" signal). Fires even
   *  for an empty channel; sourced from the client's replay-complete signal
   *  (`onReady` / `connected = !closed && replayComplete`), NOT socket connect. */
  replaySettled: boolean;
}

/**
 * Subscribe to a PubSubClient's event stream and build `ChatMessage[]` from
 * all durable + replayed channel messages. Supports windowed pagination.
 */
export function useChannelMessages<T extends ParticipantMetadata = ParticipantMetadata>(
  client: PubSubClient<T> | null
): UseChannelMessagesResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [actionBar, setActionBar] = useState<ActionBarPayload | null>(null);
  const [messageTypes, setMessageTypes] = useState<MessageTypeDefinition[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasOpenTurn, setHasOpenTurn] = useState(false);
  const hasOpenTurnRef = useRef(false);
  const [replaySettled, setReplaySettled] = useState(false);

  // Refs for internal state shared between the event consumer and pagination.
  const byIdRef = useRef(new Map<string, ChatMessage>());
  const orderRef = useRef<string[]>([]);
  const cancelledRef = useRef(false);
  // Track the lowest pubsubId we've seen (for pagination anchor).
  const oldestRootIdRef = useRef<number | null>(null);
  const clientRef = useRef(client);
  const channelStateRef = useRef<ChannelViewState>(createInitialChannelViewState());
  const agenticMessageIdsRef = useRef(new Set<string>());
  const attachmentsByMessageIdRef = useRef(new Map<string, Attachment[]>());
  const messageTypesSignatureRef = useRef("[]");
  const newestSeqRef = useRef<number | null>(null);
  clientRef.current = client;

  /**
   * Sync React state from internal order/byId.
   * @param trimTail When true, trim from the END (used after prepending older
   *   history so the newly loaded messages survive). Default: trim from the
   *   FRONT (used for live messages appended at the end).
   */
  const flush = useCallback((trimTail = false) => {
    if (cancelledRef.current) return;
    const byId = byIdRef.current;
    const order = orderRef.current;
    if (order.length > MAX_VISIBLE) {
      if (trimTail) {
        // Prepend path: keep the first MAX_VISIBLE (older messages stay).
        const trimmed = order.splice(MAX_VISIBLE);
        for (const id of trimmed) byId.delete(id);
      } else {
        // Append path: keep the last MAX_VISIBLE (newest messages stay).
        const trimmed = order.splice(0, order.length - MAX_VISIBLE);
        for (const id of trimmed) byId.delete(id);
      }
      setHasMoreHistory(true);
    }
    setMessages(order.map((id) => byId.get(id)!));
    // "Busy" includes WAITING turns, not just open ones: a turn parked on a
    // credential approval / wait is still blocked work, so interrupt/flush UX
    // (Esc-flush, the "Steer" send intent) must stay enabled. Counting only
    // "open" left the user unable to steer a waiting agent.
    const openTurn = Object.values(channelStateRef.current.turns).some(
      (turn) => turn.status === "open" || turn.status === "waiting"
    );
    if (openTurn !== hasOpenTurnRef.current) {
      hasOpenTurnRef.current = openTurn;
      setHasOpenTurn(openTurn);
    }
    setActionBar(actionBarPayloadFromChannelView(channelStateRef.current));
    const nextMessageTypes = messageTypeDefinitionsFromChannelView(channelStateRef.current);
    const nextSignature = messageTypeDefinitionsSignature(nextMessageTypes);
    if (nextSignature !== messageTypesSignatureRef.current) {
      messageTypesSignatureRef.current = nextSignature;
      setMessageTypes(nextMessageTypes);
    }
  }, []);

  const rebuildFromChannelState = useCallback(
    (trimTail = false) => {
      const byId = byIdRef.current;
      const order = orderRef.current;
      const previousById = new Map(byId);
      const projected = chatMessagesFromChannelView(channelStateRef.current).map((message) => {
        const attachments = attachmentsByMessageIdRef.current.get(message.id);
        return attachments && attachments.length > 0 ? { ...message, attachments } : message;
      });
      const projectedIds = new Set(projected.map((message) => message.id));
      for (const id of [...agenticMessageIdsRef.current]) {
        if (projectedIds.has(id)) continue;
        byId.delete(id);
        const index = order.indexOf(id);
        if (index >= 0) order.splice(index, 1);
        agenticMessageIdsRef.current.delete(id);
      }

      let prependIndex = 0;
      for (const msg of projected) {
        if (!byId.has(msg.id)) {
          if (trimTail) {
            order.splice(prependIndex, 0, msg.id);
            prependIndex += 1;
          } else {
            order.push(msg.id);
          }
        }
        const existing = previousById.get(msg.id);
        byId.set(msg.id, existing && sameChatMessage(existing, msg) ? existing : msg);
        agenticMessageIdsRef.current.add(msg.id);
      }
      // The shared projection is the ordering authority. In particular, a
      // stable-ID inline UI update receives a fresh renderedAt and moves to the
      // transcript tail without creating a second message.
      order.splice(0, order.length, ...projected.map((message) => message.id));
      flush(trimTail);
    },
    [flush]
  );

  // Token deltas arrive far faster than the channel projection is cheap to
  // rebuild (the rebuild is O(channel size)). Coalesce delta-triggered
  // rebuilds onto a trailing timer so a streaming burst costs one projection
  // per frame-ish window instead of one per token.
  const deltaRebuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const replayRebuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleDeltaRebuild = useCallback(() => {
    if (deltaRebuildTimerRef.current !== null) return;
    deltaRebuildTimerRef.current = setTimeout(() => {
      deltaRebuildTimerRef.current = null;
      if (!cancelledRef.current) rebuildFromChannelState();
    }, 33);
  }, [rebuildFromChannelState]);

  useEffect(() => {
    if (!client) return;
    cancelledRef.current = false;
    const byId = new Map<string, ChatMessage>();
    const order: string[] = [];
    byIdRef.current = byId;
    orderRef.current = order;
    oldestRootIdRef.current = null;
    newestSeqRef.current = null;
    channelStateRef.current = createInitialChannelViewState();
    agenticMessageIdsRef.current = new Set();
    attachmentsByMessageIdRef.current = new Map();
    messageTypesSignatureRef.current = "[]";
    setMessageTypes([]);
    setHasMoreHistory(Boolean(client.hasMoreBefore));

    const consume = async () => {
      try {
        let replayDirty = false;
        const flushReplayDirty = () => {
          if (!replayDirty) return;
          replayDirty = false;
          rebuildFromChannelState();
        };
        const scheduleReplayRebuild = () => {
          if (replayRebuildTimerRef.current !== null) return;
          replayRebuildTimerRef.current = setTimeout(() => {
            replayRebuildTimerRef.current = null;
            if (!cancelledRef.current) flushReplayDirty();
          }, 0);
        };
        for await (const event of client.events({ includeReplay: true, includeSignals: true })) {
          if (cancelledRef.current) break;

          const wire = event as unknown as {
            type?: string;
            delivery?: "log" | "signal";
            phase?: "replay" | "live";
            senderId?: string;
            pubsubId?: number;
            senderMetadata?: { name?: string; type?: string; handle?: string };
            ts?: number;
            attachments?: WireAttachment[];
            payload?: AgenticEvent;
          };
          if (wire.phase === "live" && replayDirty) {
            if (replayRebuildTimerRef.current !== null) {
              clearTimeout(replayRebuildTimerRef.current);
              replayRebuildTimerRef.current = null;
            }
            flushReplayDirty();
          }

          // Ephemeral agentic events (message.delta streaming) arrive as
          // string-content signals. They have NO seq/envelope identity, so
          // they must NOT enter the envelope reducer (seq-0 ordering breaks,
          // random ids defeat dedup). Apply them directly to the message
          // projection; the durable terminal later replaces blocks
          // authoritatively.
          const signalWire = wire as unknown as { contentType?: string; content?: string };
          if (
            wire.delivery === "signal" &&
            signalWire.contentType === AGENTIC_EVENT_PAYLOAD_KIND &&
            typeof signalWire.content === "string"
          ) {
            try {
              const parsed = JSON.parse(signalWire.content) as AgenticEvent | AgenticEvent[];
              const ephemeralEvents = Array.isArray(parsed) ? parsed : [parsed];
              const deltaEvents = ephemeralEvents.filter(
                (ephemeralEvent): ephemeralEvent is AgenticEvent<"message.delta"> =>
                  ephemeralEvent.kind === "message.delta"
              );
              if (deltaEvents.length > 0) {
                let messages = channelStateRef.current.messages;
                for (const ephemeralEvent of deltaEvents) {
                  messages = applyMessageEvent(messages, ephemeralEvent as never);
                }
                channelStateRef.current = {
                  ...channelStateRef.current,
                  messages,
                };
                scheduleDeltaRebuild();
              }
            } catch {
              // malformed ephemeral payload — ignore (durable terminal wins)
            }
            continue;
          }
          if (wire.type === CREDENTIAL_CONNECT_PAYLOAD_KIND && wire.payload) {
            channelStateRef.current = reduceChannelView(
              channelStateRef.current,
              pubsubChannelEventToEnvelope(client.channelId, CREDENTIAL_CONNECT_PAYLOAD_KIND, {
                ...wire,
                payload: wire.payload,
              })
            );
            if (wire.phase === "replay") {
              replayDirty = true;
              scheduleReplayRebuild();
            } else {
              rebuildFromChannelState();
            }
            continue;
          }
          if (wire.type === AGENTIC_EVENT_PAYLOAD_KIND && wire.payload) {
            rememberAttachments(attachmentsByMessageIdRef.current, wire.payload, wire.attachments);
            const envelope = pubsubAgenticEventToEnvelope(client.channelId, {
              pubsubId: wire.pubsubId,
              senderId: wire.senderId,
              ts: wire.ts,
              senderMetadata: wire.senderMetadata,
              payload: wire.payload as AgenticEvent,
            });
            channelStateRef.current = reduceChannelView(channelStateRef.current, envelope);
            if (wire.pubsubId !== undefined) {
              if (oldestRootIdRef.current === null || wire.pubsubId < oldestRootIdRef.current) {
                oldestRootIdRef.current = wire.pubsubId;
              }
              if (newestSeqRef.current === null || wire.pubsubId > newestSeqRef.current) {
                newestSeqRef.current = wire.pubsubId;
              }
            }
            if (wire.phase === "replay") {
              replayDirty = true;
              scheduleReplayRebuild();
            } else {
              rebuildFromChannelState();
            }
          }
        }
        if (!cancelledRef.current && replayDirty) {
          if (replayRebuildTimerRef.current !== null) {
            clearTimeout(replayRebuildTimerRef.current);
            replayRebuildTimerRef.current = null;
          }
          flushReplayDirty();
        }
      } catch (err) {
        if (!cancelledRef.current) console.error("[useChannelMessages]", err);
      }
    };
    void consume();
    return () => {
      cancelledRef.current = true;
      if (deltaRebuildTimerRef.current !== null) {
        clearTimeout(deltaRebuildTimerRef.current);
        deltaRebuildTimerRef.current = null;
      }
      if (replayRebuildTimerRef.current !== null) {
        clearTimeout(replayRebuildTimerRef.current);
        replayRebuildTimerRef.current = null;
      }
    };
  }, [client, rebuildFromChannelState, scheduleDeltaRebuild]);

  // --- Replay-settled signal ---
  // Flips true once the channel's initial replay completes (so `messages`
  // reflects the full prior history). The client reports this via `onReady`,
  // which fires after the server's replay-complete marker — even for an empty
  // channel — and is exactly when `client.connected` flips true
  // (`!closed && replayComplete`). A warm/resubscribed client may already be
  // past replay, so seed from `connected` too.
  useEffect(() => {
    if (!client) {
      setReplaySettled(false);
      return;
    }
    if (client.connected) {
      setHasMoreHistory(Boolean(client.hasMoreBefore));
      setReplaySettled(true);
      return;
    }
    setReplaySettled(false);
    let cancelled = false;
    const off = client.onReady(() => {
      if (!cancelled) {
        // The ready marker finalizes replay pagination. Sampling this only when
        // the client object arrives races replay and can hide all earlier
        // history behind a false `hasMoreBefore` value.
        setHasMoreHistory(Boolean(client.hasMoreBefore));
        setReplaySettled(true);
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [client]);

  // --- Pagination: load earlier messages ---
  const loadEarlierMessages = useCallback(async () => {
    const c = clientRef.current;
    if (!c || loadingMore) return;
    const anchor = oldestRootIdRef.current;
    if (anchor === null || anchor <= 1) {
      setHasMoreHistory(false);
      return;
    }

    setLoadingMore(true);
    try {
      const result = await c.getReplayBefore(anchor, PAGE_SIZE);

      setHasMoreHistory(Boolean(result.ready.hasMoreBefore));

      for (const raw of result.logEvents) {
        // Advance the pagination cursor for EVERY event in the page, not just
        // agentic ones — a page of only credential/presence events must still
        // move the anchor or pagination stalls on it forever.
        if (raw.id < (oldestRootIdRef.current ?? Infinity)) oldestRootIdRef.current = raw.id;
        if (newestSeqRef.current === null || raw.id > newestSeqRef.current)
          newestSeqRef.current = raw.id;

        const payload = raw.payload as Record<string, unknown> | undefined;
        if (!payload) continue;

        if (raw.type === CREDENTIAL_CONNECT_PAYLOAD_KIND && payload) {
          channelStateRef.current = reduceChannelView(
            channelStateRef.current,
            pubsubChannelEventToEnvelope(c.channelId, CREDENTIAL_CONNECT_PAYLOAD_KIND, {
              pubsubId: raw.id,
              senderId: raw.senderId,
              ts: raw.ts,
              senderMetadata: raw.senderMetadata as
                | { name?: string; type?: string; handle?: string }
                | undefined,
              payload,
            })
          );
          continue;
        }
        if (raw.type === AGENTIC_EVENT_PAYLOAD_KIND && payload) {
          rememberAttachments(
            attachmentsByMessageIdRef.current,
            payload as unknown as AgenticEvent,
            raw.attachments as WireAttachment[] | undefined
          );
          const envelope = pubsubAgenticEventToEnvelope(c.channelId, {
            pubsubId: raw.id,
            senderId: raw.senderId,
            ts: raw.ts,
            senderMetadata: raw.senderMetadata as
              | { name?: string; type?: string; handle?: string }
              | undefined,
            payload: payload as unknown as AgenticEvent,
          });
          channelStateRef.current = reduceChannelView(channelStateRef.current, envelope);
        }
      }

      rebuildFromChannelState(true);
    } catch (err) {
      console.error("[useChannelMessages] loadEarlierMessages failed:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, rebuildFromChannelState]);

  const backfillAfterLocalPublish = useCallback(
    async (pubsubId: number | undefined) => {
      const c = clientRef.current;
      if (!c || pubsubId === undefined) return;
      const cursor = newestSeqRef.current ?? 0;
      if (cursor >= pubsubId) return;
      try {
        for await (const result of iterateChannelReplayAfterPages(
          (request) => c.getReplayAfter(request),
          { after: cursor, throughSeq: pubsubId }
        )) {
          for (const raw of result.logEvents) {
            const payload = raw.payload as Record<string, unknown> | undefined;
            if (raw.type === CREDENTIAL_CONNECT_PAYLOAD_KIND && payload) {
              channelStateRef.current = reduceChannelView(
                channelStateRef.current,
                pubsubChannelEventToEnvelope(c.channelId, CREDENTIAL_CONNECT_PAYLOAD_KIND, {
                  pubsubId: raw.id,
                  senderId: raw.senderId,
                  ts: raw.ts,
                  senderMetadata: raw.senderMetadata as
                    | { name?: string; type?: string; handle?: string }
                    | undefined,
                  payload,
                })
              );
              continue;
            }
            if (raw.type === AGENTIC_EVENT_PAYLOAD_KIND && payload) {
              rememberAttachments(
                attachmentsByMessageIdRef.current,
                payload as unknown as AgenticEvent,
                raw.attachments as WireAttachment[] | undefined
              );
              const envelope = pubsubAgenticEventToEnvelope(c.channelId, {
                pubsubId: raw.id,
                senderId: raw.senderId,
                ts: raw.ts,
                senderMetadata: raw.senderMetadata as
                  | { name?: string; type?: string; handle?: string }
                  | undefined,
                payload: payload as unknown as AgenticEvent,
              });
              channelStateRef.current = reduceChannelView(channelStateRef.current, envelope);
              if (raw.id < (oldestRootIdRef.current ?? Infinity)) oldestRootIdRef.current = raw.id;
              if (newestSeqRef.current === null || raw.id > newestSeqRef.current)
                newestSeqRef.current = raw.id;
            }
          }
        }
        rebuildFromChannelState();
      } catch (err) {
        console.error("[useChannelMessages] backfillAfterLocalPublish failed:", err);
      }
    },
    [rebuildFromChannelState]
  );

  return {
    messages,
    actionBar,
    messageTypes,
    hasMoreHistory,
    loadingMore,
    hasOpenTurn,
    loadEarlierMessages,
    backfillAfterLocalPublish,
    replaySettled,
  };
}

type WireAttachment = {
  id?: string;
  data?: string | Uint8Array;
  mimeType: string;
  filename?: string;
  name?: string;
  size?: number;
};

function rememberAttachments(
  target: Map<string, Attachment[]>,
  payload: AgenticEvent,
  wireAttachments: WireAttachment[] | undefined
): void {
  const messageId = payload.causality?.messageId;
  if (!messageId || !wireAttachments || wireAttachments.length === 0) return;
  target.set(String(messageId), wireAttachments.map(wireAttachmentToAttachment));
}

function wireAttachmentToAttachment(attachment: WireAttachment): Attachment {
  const data =
    typeof attachment.data === "string"
      ? base64ToUint8Array(attachment.data)
      : attachment.data instanceof Uint8Array
        ? attachment.data
        : new Uint8Array();
  return {
    id: attachment.id ?? "",
    data,
    mimeType: attachment.mimeType,
    name: attachment.filename ?? attachment.name,
  };
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function attachmentSignatures(attachments: Attachment[] | undefined): string[] {
  return (attachments ?? []).map((attachment) =>
    [attachment.id, attachment.mimeType, attachment.name, attachment.data.length].join(":")
  );
}

function sameChatMessage(a: ChatMessage, b: ChatMessage): boolean {
  if (
    a.id !== b.id ||
    a.senderId !== b.senderId ||
    a.content !== b.content ||
    a.contentType !== b.contentType ||
    a.kind !== b.kind ||
    a.complete !== b.complete ||
    a.error !== b.error ||
    a.pending !== b.pending ||
    a.tier !== b.tier ||
    a.replyTo !== b.replyTo ||
    // Delivery-model fields: without these, incoming receipt/edit/retract
    // projections are treated as unchanged and the UI never updates.
    a.retracted !== b.retracted ||
    a.revision !== b.revision ||
    a.editedAt !== b.editedAt
  ) {
    return false;
  }
  if (JSON.stringify(a.receipts ?? null) !== JSON.stringify(b.receipts ?? null)) return false;
  if (JSON.stringify(a.mentions ?? []) !== JSON.stringify(b.mentions ?? [])) return false;
  if (
    JSON.stringify(attachmentSignatures(a.attachments)) !==
    JSON.stringify(attachmentSignatures(b.attachments))
  )
    return false;
  if (
    a.invocation !== b.invocation &&
    JSON.stringify(a.invocation) !== JSON.stringify(b.invocation)
  )
    return false;
  if (a.approval !== b.approval && JSON.stringify(a.approval) !== JSON.stringify(b.approval))
    return false;
  if (a.inlineUi !== b.inlineUi && JSON.stringify(a.inlineUi) !== JSON.stringify(b.inlineUi))
    return false;
  if (a.custom !== b.custom) {
    if (!a.custom || !b.custom) return false;
    if (
      a.custom.messageId !== b.custom.messageId ||
      a.custom.typeId !== b.custom.typeId ||
      a.custom.displayMode !== b.custom.displayMode ||
      a.custom.lastSeq !== b.custom.lastSeq ||
      a.custom.updates !== b.custom.updates ||
      a.custom.initialState !== b.custom.initialState
    ) {
      return false;
    }
  }
  return true;
}

function messageTypeDefinitionsSignature(definitions: MessageTypeDefinition[]): string {
  return JSON.stringify(
    definitions.map((definition) => ({
      typeId: definition.typeId,
      displayMode: definition.displayMode,
      source: definition.source,
      imports: definition.imports,
      stateSchema: definition.stateSchema,
      updateSchema: definition.updateSchema,
      registeredBy: definition.registeredBy,
      updatedAtSeq: definition.updatedAtSeq,
      clearedAtSeq: definition.clearedAtSeq,
      cleared: definition.cleared,
    }))
  );
}

function pubsubAgenticEventToEnvelope(
  channelId: string,
  wire: {
    pubsubId?: number;
    senderId?: string;
    ts?: number;
    senderMetadata?: { name?: string; type?: string; handle?: string };
    payload: AgenticEvent;
  }
): ChannelEnvelope<AgenticEvent> {
  const participantId = wire.senderId ?? wire.payload.actor.id;
  const metadata = wire.senderMetadata;
  return {
    envelopeId: `pubsub:${wire.pubsubId ?? crypto.randomUUID()}` as never,
    channelId: channelId as never,
    seq: wire.pubsubId ?? 0,
    from: {
      kind: participantKind(metadata?.type),
      id: participantId,
      displayName: metadata?.name,
      participantId,
      metadata,
    },
    payload: wire.payload,
    payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
    contentClass: "external",
    externalKeys: [`msg:${channelId}/${wire.pubsubId ?? "unattributed"}`],
    publishedAt: new Date(wire.ts ?? Date.now()).toISOString(),
  };
}

function participantKind(type: string | undefined): "user" | "agent" | "panel" | "external" {
  if (type === "agent") return "agent";
  if (type === "panel" || type === "client") return "panel";
  if (type === "headless") return "user";
  return "external";
}
