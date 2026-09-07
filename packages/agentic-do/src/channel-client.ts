/**
 * ChannelClient — Typed wrapper for channel DO operations.
 *
 * All operations go through the RPC bridge, which routes to the
 * channel service DO via the server's workspace service resolver.
 */
import type { RpcCaller } from "@vibestudio/rpc";
import {
  iterateChannelReplayAfterPages,
  type ChannelReplayAfterRequest,
  type ChannelReplayEnvelope,
} from "@workspace/pubsub";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  type AgenticEvent,
  type MessageTier,
} from "@workspace/agentic-protocol";
/** Binary payload riding on a message — base64 for the DO wire, stored by the
 *  channel DO alongside the envelope and rendered by the chat panel. */
export interface ChannelAttachment {
  id?: string;
  /** base64-encoded bytes */
  data: string;
  mimeType: string;
  name?: string;
  size?: number;
}
interface ChannelSendOptions {
  senderMetadata?: Record<string, unknown>;
  replyTo?: string;
  mentions?: string[];
  /** Explicit direction: only the selected participants should respond. */
  to?: Array<{ kind: "all" | "role" | "participant"; role?: string; participantId?: string }>;
  idempotencyKey?: string;
  attachments?: ChannelAttachment[];
  /**
   * Salience tier. A `ChannelClient.send` is an explicit, deliberate message
   * — the agent (or headless participant) choosing to surface text to the
   * channel, e.g. the silent agent's `notify` tool — so it defaults to "primary"
   * (tier 1). The model-loop's own turn narration is tiered separately in
   * agent-loop. Pass "secondary" to send a deliberately slight message.
   */
  tier?: MessageTier;
  /**
   * Salience flag: `"say"` marks the message as an explicit, deliberate
   * utterance (the generalized `notify` tool; the wire value is frozen at
   * "say"). It survives the `turn-final`
   * wake filter and is surfaced by the chat projection. Omit for ordinary
   * traffic.
   */
  saliency?: "say";
  /**
   * Free-form send intent carried on the message payload. `notify` puts its
   * escalation rung and headline here (`{ notify: { alert, title } }`) so the
   * durable envelope — not a side table — records what the sender asked the
   * recipient to experience.
   */
  metadata?: Record<string, unknown>;
  /**
   * Caller-computed conversation depth. The channel policy folds a per-channel
   * agent streak of its own, but honours an explicit count — which is what
   * carries the hop cap across a channel boundary on a guest envelope
   * (messaging plan §4.6). Omit for ordinary sends.
   */
  agentHops?: number;
}
/** Decoded byte count of a base64 string (padding-aware). */
function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}
const DEFAULT_CHANNEL_SERVICE_PROTOCOL = "vibestudio.channel.v1";
interface ResolvedService {
  kind: "durable-object" | "worker";
  targetId?: string;
}

export type ChannelDeliveryEndpoint =
  | { kind: "entity"; entityId: string; invocation: "direct" | "mailbox" }
  | { kind: "session" };

export interface ChannelJoinInput {
  participantId: string;
  revision: number;
  contextId: string;
  metadata: Record<string, unknown>;
  delivery: "all" | "addressed" | "none";
  endpoint: ChannelDeliveryEndpoint;
  applicationConfig: { version: number; value: unknown } | null;
  replay: boolean;
}

export interface ChannelJoinResult {
  ok: boolean;
  participantId: string;
  revision: number;
  channelConfig?: Record<string, unknown>;
  envelope?: ChannelReplayEnvelope;
}

export class ChannelClient {
  private targetPromise: Promise<string> | null = null;
  constructor(
    private rpc: RpcCaller,
    private channelId: string,
    private protocol: string = DEFAULT_CHANNEL_SERVICE_PROTOCOL
  ) {}
  private async target(): Promise<string> {
    this.targetPromise ??= this.rpc
      .call<ResolvedService>("main", "workers.resolveService", [this.protocol, this.channelId])
      .then((service) => {
        if (service.kind !== "durable-object" || !service.targetId) {
          throw new Error("Channel service must resolve to a Durable Object service");
        }
        return service.targetId;
      });
    return this.targetPromise;
  }
  private async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return this.rpc.call<T>(await this.target(), method, [...args]);
  }
  async send(
    participantId: string,
    messageId: string,
    content: string,
    opts?: ChannelSendOptions
  ): Promise<void> {
    const senderMetadata = opts?.senderMetadata ?? {};
    const participantType =
      typeof senderMetadata["type"] === "string" ? senderMetadata["type"] : undefined;
    const displayName =
      typeof senderMetadata["name"] === "string" ? senderMetadata["name"] : participantId;
    const attachments = opts?.attachments?.map((attachment, index) => ({
      id: attachment.id ?? `att_${index}`,
      data: attachment.data,
      mimeType: attachment.mimeType,
      name: attachment.name,
      size: attachment.size ?? base64ByteLength(attachment.data),
    }));
    const event: AgenticEvent = {
      kind: "message.completed",
      actor: {
        kind:
          participantType === "agent" ? "agent" : participantType === "headless" ? "user" : "panel",
        id: participantId,
        displayName,
        metadata: senderMetadata,
      },
      causality: {
        messageId: messageId as never,
        ...(typeof opts?.agentHops === "number" ? { agentHops: opts.agentHops } : {}),
      },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: participantType === "agent" ? "assistant" : "user",
        blocks: [
          { blockId: `${messageId}:block:0` as never, type: "text", content },
          ...(attachments?.map((attachment, index) => ({
            blockId: `${messageId}:block:${index + 1}` as never,
            type: "attachment" as const,
            metadata: { mimeType: attachment.mimeType, filename: attachment.name },
          })) ?? []),
        ],
        outcome: "completed",
        tier: opts?.tier ?? "primary",
        ...(opts?.saliency ? { saliency: opts.saliency } : {}),
        mentions: opts?.mentions,
        replyTo: opts?.replyTo as never,
        to: opts?.to,
        ...(opts?.metadata ? { metadata: opts.metadata } : {}),
      },
      createdAt: new Date().toISOString(),
    };
    await this.publishAgenticEvent(participantId, event, {
      idempotencyKey: opts?.idempotencyKey,
      senderMetadata,
      attachments,
    });
  }
  async publishAgenticEvent(
    participantId: string,
    event: AgenticEvent,
    opts?: {
      idempotencyKey?: string;
      senderMetadata?: Record<string, unknown>;
      attachments?: Array<
        Required<Pick<ChannelAttachment, "id" | "data" | "mimeType" | "size">> &
          Pick<ChannelAttachment, "name">
      >;
    }
  ): Promise<{ id?: number }> {
    return this.call("publish", participantId, AGENTIC_EVENT_PAYLOAD_KIND, event, opts);
  }
  async publish(
    participantId: string,
    payloadKind: string,
    payload: unknown,
    opts?: { idempotencyKey?: string }
  ): Promise<{ id?: number }> {
    return this.call("publish", participantId, payloadKind, payload, opts);
  }
  /**
   * Add a workspace member to this channel (WP7 §3). Used by `notify` when it
   * addresses a person who is not yet on the roster: membership is what lets
   * the escalated inbox entry open the conversation (messaging plan §4.6).
   * Idempotent on the channel side.
   */
  async addMember(userId: string): Promise<{ alreadyMember: boolean }> {
    return this.call("addMember", { userId });
  }
  async recordReadReceipt(
    participantId: string,
    messageId: string,
    turnId?: string
  ): Promise<void> {
    await this.call("recordReceipt", participantId, messageId, "read", {
      ...(turnId ? { turnId } : {}),
    });
  }
  async update(
    participantId: string,
    messageId: string,
    content: string,
    idempotencyKey?: string,
    opts?: {
      append?: boolean;
    }
  ): Promise<void> {
    await this.call("update", participantId, messageId, content, idempotencyKey, opts);
  }
  async complete(participantId: string, messageId: string, idempotencyKey?: string): Promise<void> {
    await this.call("complete", participantId, messageId, idempotencyKey);
  }
  async error(
    participantId: string,
    messageId: string,
    error: string,
    code?: string
  ): Promise<void> {
    await this.call("error", participantId, messageId, error, code);
  }
  async sendSignal(participantId: string, content: string, contentType?: string): Promise<void> {
    await this.call("sendSignal", participantId, content, contentType);
  }
  /**
   * Typed wrapper for signal messages with structured (JSON) payloads.
   * The payload is JSON-serialized and routed through the same string-based
   * sendSignal path. Receivers decode via
   * `parseSignalEvent` from `@workspace/agentic-core`.
   */
  async sendSignalEvent<T>(participantId: string, contentType: string, payload: T): Promise<void> {
    await this.sendSignal(participantId, JSON.stringify(payload), contentType);
  }
  /** Durable semantic signal. Unlike UI/model progress hints, this is appended
   * to the canonical log and therefore survives restart and hint loss. */
  async publishSignalFact<T>(
    participantId: string,
    contentType: string,
    payload: T,
    idempotencyKey: string
  ): Promise<void> {
    await this.publish(
      participantId,
      "signal",
      { content: JSON.stringify(payload), contentType },
      { idempotencyKey }
    );
  }
  async broadcastStoredEnvelopes(envelopeIds: string[]): Promise<{ broadcasted: number }> {
    return this.call("broadcastStoredEnvelopes", envelopeIds) as Promise<{ broadcasted: number }>;
  }
  async updateMetadata(participantId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.call("updateMetadata", participantId, metadata);
  }
  async setTypingState(participantId: string, typing: boolean): Promise<void> {
    await this.call("setTypingState", participantId, typing);
  }
  async join(input: ChannelJoinInput): Promise<ChannelJoinResult> {
    return this.call("join", input) as Promise<ChannelJoinResult>;
  }

  async leave(participantId: string, revision: number): Promise<void> {
    await this.call("leave", { participantId, revision });
  }

  async relationshipState(participantId: string): Promise<{ revision: number; active: boolean }> {
    return this.call("relationshipState", participantId);
  }
  async getParticipants(): Promise<
    Array<{
      participantId: string;
      ref: import("@workspace/agentic-protocol").ParticipantRef;
      metadata: Record<string, unknown>;
    }>
  > {
    return this.call("getParticipants") as Promise<
      Array<{
        participantId: string;
        ref: import("@workspace/agentic-protocol").ParticipantRef;
        metadata: Record<string, unknown>;
      }>
    >;
  }
  async callMethod(
    callerPid: string,
    targetPid: string,
    callId: string,
    method: string,
    args: unknown,
    opts?: { invocationId?: string; transportCallId?: string; turnId?: string; timeoutMs?: number }
  ): Promise<void> {
    await this.call("callMethod", callerPid, targetPid, callId, method, args, opts);
  }
  async cancelCall(participantId: string, callId: string): Promise<void> {
    await this.call("cancelMethodCall", participantId, callId);
  }
  async getReplayAfter(request: ChannelReplayAfterRequest): Promise<ChannelReplayEnvelope> {
    return this.call("getReplayAfter", request) as Promise<ChannelReplayEnvelope>;
  }
  /** Iterate a stable forward snapshot without ever assembling it into one RPC
   * payload. Appends after the first page's watermark belong to the next read. */
  async *replayAfterPages(
    request: ChannelReplayAfterRequest
  ): AsyncGenerator<ChannelReplayEnvelope, void, void> {
    yield* iterateChannelReplayAfterPages((page) => this.getReplayAfter(page), request);
  }
  /** Look up one durable channel envelope by its stable id. */
  async getEnvelope(envelopeId: string): Promise<unknown | null> {
    return this.call("getEnvelope", envelopeId) as Promise<unknown | null>;
  }
  async getMessageType(typeId: string): Promise<Record<string, unknown> | null> {
    return this.call("getMessageType", typeId) as Promise<Record<string, unknown> | null>;
  }
  async getMessageSender(participantId: string, messageId: string): Promise<string | null> {
    return this.call("getMessageSender", participantId, messageId) as Promise<string | null>;
  }
  async getMessageTypes(): Promise<Record<string, unknown>[]> {
    return this.call("getMessageTypes") as Promise<Record<string, unknown>[]>;
  }
  /** Channel policy fold state (WS2 §4.4 — replaces getConversationState).
   *  Default policy "agentic.conversation.v1" carries the conversation
   *  state (last completed sender, agent streak), rebuilt by replay so it
   *  survives forks. */
  async getPolicyState(name?: string): Promise<{
    policy: string;
    version: number;
    foldedThroughSeq: number;
    state: unknown;
  }> {
    return this.call("getPolicyState", ...(name ? [name] : [])) as Promise<{
      policy: string;
      version: number;
      foldedThroughSeq: number;
      state: unknown;
    }>;
  }
  async updateConfig(config: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call("updateConfig", config) as Promise<Record<string, unknown>>;
  }
  async getConfig(): Promise<Record<string, unknown> | null> {
    return this.call("getConfig") as Promise<Record<string, unknown> | null>;
  }
  /** Channel provenance used for fork/task lineage recovery. */
  async getProvenance(): Promise<unknown> {
    return this.call("getProvenance");
  }
  /** Stamp task provenance on a subagent task channel so its `getProvenance`
   *  reports `kind:"task"` (B1). Called by the spawning vessel right after the
   *  task channel is created/subscribed. */
  async recordTaskProvenance(args: {
    parentChannelId: string;
    parentContextId: string;
    runId: string;
  }): Promise<void> {
    await this.call("recordTaskProvenance", args);
  }
}
