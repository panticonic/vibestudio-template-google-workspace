import { AGENTIC_EVENT_PAYLOAD_KIND } from "./constants.js";
import type { ChannelId, EnvelopeId } from "./ids.js";
import type { ActorRef, ParticipantRef, ParticipantSelector, StoredAgenticEvent } from "./events.js";

export interface ChannelEnvelope<Payload = unknown> {
  envelopeId: EnvelopeId;
  channelId: ChannelId;
  seq: number;
  from: ActorRef;
  to?: ParticipantRef[] | ParticipantSelector;
  payload: Payload;
  payloadKind?: string;
  metadata?: Record<string, unknown>;
  attachments?: unknown[];
  /** Host-attested content provenance at the instant the sender published. */
  contentClass: "internal" | "external";
  /** Exact outside-content lineage folded into the sender session at publish time. */
  externalKeys: string[];
  /** Durable envelope annotations (policy folds — e.g. agentHops). */
  annotations?: Record<string, unknown>;
  publishedAt: string;
}

export type StoredChannelEnvelope = ChannelEnvelope<StoredAgenticEvent>;

export type EphemeralSignalKind = "typing" | "presence" | "cursor" | "custom";

export interface EphemeralSignal {
  channelId: ChannelId;
  from: ParticipantRef;
  kind: EphemeralSignalKind;
  payload?: unknown;
  emittedAt: string;
}

export interface ChannelRosterEntry {
  participant: ParticipantRef;
  joinedAt: string;
  leftAt?: string;
  roles: string[];
}

/** Lift a non-trajectory pubsub event into the canonical channel envelope. */
export function pubsubChannelEventToEnvelope<Payload>(
  channelId: string,
  payloadKind: string,
  wire: {
    pubsubId?: number;
    senderId?: string;
    ts?: number;
    senderMetadata?: { name?: string; type?: string; handle?: string };
    payload: Payload;
  }
): ChannelEnvelope<Payload> {
  const participantId = wire.senderId ?? "channel";
  const metadata = wire.senderMetadata;
  return {
    envelopeId: `pubsub:${wire.pubsubId ?? crypto.randomUUID()}` as EnvelopeId,
    channelId: channelId as ChannelId,
    seq: wire.pubsubId ?? 0,
    from: {
      kind: participantKindFromWire(metadata?.type),
      id: participantId,
      ...(metadata?.name === undefined ? {} : { displayName: metadata.name }),
      participantId,
      ...(metadata ? { metadata } : {}),
    } as ActorRef,
    payload: wire.payload,
    payloadKind,
    contentClass: "external",
    externalKeys: [`msg:${channelId}/${wire.pubsubId ?? "unattributed"}`],
    publishedAt: new Date(wire.ts ?? Date.now()).toISOString(),
  };
}

/**
 * Lift one pubsub wire event into the envelope `reduceChannelView` consumes.
 *
 * The reducer takes a `ChannelEnvelope`; a channel client's `events()` yields a
 * *wire* event with a different shape. Nothing enforces the difference at
 * runtime — an unconverted event misses every branch of the reducer and leaves
 * the state untouched — so a client that skips this step silently renders an
 * empty transcript no matter how healthy its subscription is. That is exactly
 * what the command overlay did.
 *
 * Two hand-rolled copies of this predate the shared one
 * (`agentic-chat/hooks/useChannelMessages.ts`,
 * `agentic-session/src/headless-session.ts`); they should converge here.
 */
export function pubsubAgenticEventToEnvelope<Payload extends { actor: { id: string } }>(
  channelId: string,
  wire: {
    pubsubId?: number;
    senderId?: string;
    ts?: number;
    senderMetadata?: { name?: string; type?: string; handle?: string };
    contentClass?: "internal" | "external";
    externalKeys?: string[];
    payload: Payload;
  }
): ChannelEnvelope<Payload> {
  const participantId = wire.senderId ?? wire.payload.actor.id;
  const metadata = wire.senderMetadata;
  return {
    envelopeId: `pubsub:${wire.pubsubId ?? crypto.randomUUID()}` as EnvelopeId,
    channelId: channelId as ChannelId,
    seq: wire.pubsubId ?? 0,
    from: {
      kind: participantKindFromWire(metadata?.type),
      id: participantId,
      ...(metadata?.name === undefined ? {} : { displayName: metadata.name }),
      participantId,
      ...(metadata ? { metadata } : {}),
    } as ActorRef,
    payload: wire.payload,
    payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
    contentClass: wire.contentClass ?? "internal",
    externalKeys: [...(wire.externalKeys ?? [])],
    publishedAt: new Date(wire.ts ?? Date.now()).toISOString(),
  };
}

function participantKindFromWire(type: string | undefined): "user" | "agent" | "panel" | "external" {
  if (type === "agent" || type === "headless") return "agent";
  if (type === "panel" || type === "client") return "panel";
  if (type === "external") return "external";
  return "user";
}
