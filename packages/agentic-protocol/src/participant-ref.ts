import type {
  ActorRef,
  AgenticEvent,
  ApprovalPayload,
  ChannelForkedPayload,
  CustomStartedPayload,
  ExternalEnvelopeObservedPayload,
  ExternalParticipantObservedPayload,
  InvocationPayload,
  MessageTypeRegisteredPayload,
  ParticipantKind,
  ParticipantRef,
} from "./events.js";
import { PARTICIPANT_KINDS } from "./events.js";

const PUBLIC_METADATA_KEYS = [
  "kind",
  "type",
  "name",
  "displayName",
  "handle",
  "typing",
  "executionMode",
  "activeModel",
  // Personalization / presence (WP6 §6, shared with WP8): rendered live for
  // `user:` participants from the host-projected profile, never frozen.
  "status",
  "color",
  "avatar",
  // Discovery (messaging plan §4.4): an agent's one-line self-description and,
  // for a subagent, the run it belongs to. Bounded strings, public by design —
  // they are what `discover_agents` searches and what lineage joins on.
  "description",
  "subagentRunId",
] as const;

export interface PublicMethodSummary {
  name: string;
  streaming?: boolean;
  menu?: Record<string, unknown>;
}

export type PublicParticipantMetadata = Partial<Record<(typeof PUBLIC_METADATA_KEYS)[number], string | number | boolean>> & {
  methods?: PublicMethodSummary[];
};

export type PrivateParticipantMetadata = PublicParticipantMetadata & Record<string, unknown>;

export function publicParticipantMetadata(
  metadata?: Record<string, unknown> | null
): PublicParticipantMetadata | undefined {
  if (!metadata) return undefined;
  const out: PublicParticipantMetadata = {};
  for (const key of PUBLIC_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  const methods = publicMethodSummaries(metadata["methods"]);
  if (methods.length > 0) out["methods"] = methods;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function participantRefFromMetadata(
  participantId: string,
  metadata?: Record<string, unknown> | null
): ParticipantRef {
  const publicMetadata = publicParticipantMetadata(metadata);
  const declaredKind = publicMetadata?.["kind"] ?? publicMetadata?.["type"];
  const kind = participantKindFromMetadata(participantId, declaredKind);
  const displayName = typeof publicMetadata?.["name"] === "string"
    ? publicMetadata["name"]
    : typeof publicMetadata?.["displayName"] === "string"
      ? publicMetadata["displayName"]
      : undefined;
  return {
    kind,
    id: participantId,
    participantId,
    ...(displayName ? { displayName } : {}),
    ...(publicMetadata ? { metadata: publicMetadata } : {}),
  };
}

export function publicActorRef<T extends ActorRef>(actor: T): T {
  const publicMetadata = publicParticipantMetadata(actor.metadata);
  const { metadata: _metadata, ...rest } = actor;
  return {
    ...rest,
    ...(publicMetadata ? { metadata: publicMetadata } : {}),
  } as T;
}

export function publicParticipantRef(participant: ParticipantRef): ParticipantRef {
  return publicActorRef(participant);
}

export function isParticipantKind(kind: unknown): kind is ParticipantKind {
  return PARTICIPANT_KINDS.includes(kind as ParticipantKind);
}

export function isParticipantRef(value: unknown): value is ParticipantRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isParticipantKind(record["kind"]) && typeof record["id"] === "string";
}

export function participantRefFromActor(actor: ActorRef): ParticipantRef {
  if (isParticipantKind(actor.kind)) {
    return actor as ParticipantRef;
  }
  return {
    kind: "external",
    id: actor.id,
    ...(actor.displayName ? { displayName: actor.displayName } : {}),
    metadata: {
      ...(actor.metadata ?? {}),
      principalKind: actor.kind,
    },
    ...(actor.participantId ? { participantId: actor.participantId } : {}),
  };
}

export function sanitizeAgenticEventParticipantRefs<T extends AgenticEvent>(event: T): T {
  return {
    ...event,
    actor: publicActorRef(event.actor),
    payload: sanitizePayloadParticipantRefs(event.kind, event.payload),
  } as T;
}

function publicMethodSummaries(value: unknown): PublicMethodSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((method) => {
    if (!method || typeof method !== "object" || Array.isArray(method)) return [];
    const record = method as Record<string, unknown>;
    if (typeof record["name"] !== "string") return [];
    const summary: PublicMethodSummary = {
      name: record["name"],
    };
    if (typeof record["streaming"] === "boolean") summary.streaming = record["streaming"];
    if (record["menu"] && typeof record["menu"] === "object" && !Array.isArray(record["menu"])) {
      summary.menu = record["menu"] as Record<string, unknown>;
    }
    return [summary];
  });
}

function sanitizePayloadParticipantRefs(kind: AgenticEvent["kind"], payload: AgenticEvent["payload"]): AgenticEvent["payload"] {
  switch (kind) {
    case "invocation.started":
      return sanitizeInvocationPayload(payload as InvocationPayload);
    case "approval.requested":
    case "approval.resolved":
      return sanitizeApprovalPayload(payload as ApprovalPayload);
    case "messageType.registered":
      return sanitizeMessageTypeRegisteredPayload(payload as MessageTypeRegisteredPayload);
    case "custom.started":
      return sanitizeCustomStartedPayload(payload as CustomStartedPayload);
    case "external.envelope_observed":
      return sanitizeExternalEnvelopeObservedPayload(payload as ExternalEnvelopeObservedPayload);
    case "external.participant_observed":
      return sanitizeExternalParticipantObservedPayload(payload as ExternalParticipantObservedPayload);
    case "channel.forked":
      return sanitizeChannelForkedPayload(payload as ChannelForkedPayload);
    default:
      return payload;
  }
}

function sanitizeChannelForkedPayload(payload: ChannelForkedPayload): ChannelForkedPayload {
  return {
    ...payload,
    actor: publicParticipantRef(payload.actor),
  };
}

function sanitizeInvocationPayload(payload: InvocationPayload): InvocationPayload {
  if (!("transport" in payload) || payload.transport?.kind !== "channel") return payload;
  return {
    ...payload,
    transport: {
      ...payload.transport,
      target: publicParticipantRef(payload.transport.target),
    },
  };
}

function sanitizeApprovalPayload(payload: ApprovalPayload): ApprovalPayload {
  if ("question" in payload) {
    return {
      ...payload,
      ...(payload.requestedBy ? { requestedBy: publicActorRef(payload.requestedBy) } : {}),
      ...(isParticipantRef(payload.approver) ? { approver: publicParticipantRef(payload.approver) } : {}),
    };
  }
  return {
    ...payload,
    resolvedBy: publicActorRef(payload.resolvedBy),
  };
}

function sanitizeMessageTypeRegisteredPayload(payload: MessageTypeRegisteredPayload): MessageTypeRegisteredPayload {
  return {
    ...payload,
    ...(payload.registeredBy ? { registeredBy: publicActorRef(payload.registeredBy) } : {}),
  };
}

function sanitizeCustomStartedPayload(payload: CustomStartedPayload): CustomStartedPayload {
  return {
    ...payload,
    ...(payload.by ? { by: publicActorRef(payload.by) } : {}),
  };
}

function sanitizeExternalEnvelopeObservedPayload(
  payload: ExternalEnvelopeObservedPayload
): ExternalEnvelopeObservedPayload {
  return {
    ...payload,
    from: publicParticipantRef(payload.from),
  };
}

function sanitizeExternalParticipantObservedPayload(
  payload: ExternalParticipantObservedPayload
): ExternalParticipantObservedPayload {
  return {
    ...payload,
    participant: publicParticipantRef(payload.participant),
  };
}

/**
 * Stable principal-derived human participant id (WP6 §4): `user:<userId>`.
 * One roster identity per human, shared across every panel/device.
 */
export function userParticipantId(userId: string): string {
  return userId.startsWith("user:") ? userId : `user:${userId}`;
}

/** Why a handle did not resolve, with near-miss handles to suggest back to
 *  the caller. Messaging plan §4.2.1: the tool surfaces this text instead of
 *  guessing, so an agent can correct itself in one turn. */
export interface HandleResolutionFailure {
  error: "unknown" | "ambiguous";
  /** Candidate handles (or ids) worth trying — near misses for "unknown",
   *  the colliding participants for "ambiguous". */
  suggestions: string[];
}

export type HandleResolution = ParticipantRef | HandleResolutionFailure;

export function isHandleResolutionFailure(
  value: HandleResolution
): value is HandleResolutionFailure {
  return "error" in value;
}

/** Matching is tiered, exact-first: id, then handle, then displayName. Fuzzy
 *  never resolves — it only populates suggestions. */
const HANDLE_MATCH_TIERS = ["id", "handle", "displayName"] as const;

function suggestionFor(ref: ParticipantRef): string {
  const handle = ref.metadata?.["handle"];
  if (typeof handle === "string" && handle.length > 0) return `@${handle}`;
  return ref.participantId ?? ref.id;
}

/**
 * Resolve an `@mention` / handle / id token against a roster (messaging plan
 * §4.2.1). Matching is attribution-grade (mutual trust, plan §0.0), never an
 * authorization check — it answers "who was meant", and the write path decides
 * whether the message lands.
 *
 * Tiered and exact: participant id first (a bare `<id>` also matches a human's
 * `user:<id>`), then exact case-insensitive `metadata.handle`, then
 * displayName. A tier is only consulted when no earlier tier matched, so an id
 * on a late roster entry can never lose to a handle on an early one.
 *
 * **Ambiguity is an error, not a tie-break.** Two participants sharing a handle
 * in one roster is a directory bug; failing closed surfaces it instead of
 * silently delivering to whichever the iteration order happened to hit.
 */
export function resolveHandle(
  mention: string,
  roster: Iterable<ParticipantRef>,
  opts?: { kinds?: readonly ParticipantKind[] }
): HandleResolution {
  const token = mention.trim().replace(/^@/, "");
  if (token.length === 0) return { error: "unknown", suggestions: [] };
  const asMemberId = userParticipantId(token);
  const needle = token.toLowerCase();
  const kinds = opts?.kinds;
  const matches: Record<(typeof HANDLE_MATCH_TIERS)[number], ParticipantRef[]> = {
    id: [],
    handle: [],
    displayName: [],
  };
  const candidates: ParticipantRef[] = [];

  for (const ref of roster) {
    if (kinds && !kinds.includes(ref.kind)) continue;
    candidates.push(ref);
    const id = ref.participantId ?? ref.id;
    if (id === token || (ref.kind === "user" && id === asMemberId)) {
      matches.id.push(ref);
      continue;
    }
    const handle = ref.metadata?.["handle"];
    if (typeof handle === "string" && handle.toLowerCase() === needle) {
      matches.handle.push(ref);
      continue;
    }
    if (typeof ref.displayName === "string" && ref.displayName.toLowerCase() === needle) {
      matches.displayName.push(ref);
    }
  }

  for (const tier of HANDLE_MATCH_TIERS) {
    const tiered = matches[tier];
    if (tiered.length === 1) return tiered[0] as ParticipantRef;
    if (tiered.length > 1) {
      return {
        error: "ambiguous",
        suggestions: tiered.map((ref) => ref.participantId ?? ref.id),
      };
    }
  }

  // Near misses: substring either way, so both "gmail" → "@gmail-agent" and
  // "gmail-agent-2" → "@gmail-agent" suggest something useful.
  const suggestions = candidates
    .filter((ref) => {
      const handle = ref.metadata?.["handle"];
      const label = typeof handle === "string" ? handle.toLowerCase() : "";
      const name = typeof ref.displayName === "string" ? ref.displayName.toLowerCase() : "";
      return (
        (label.length > 0 && (label.includes(needle) || needle.includes(label))) ||
        (name.length > 0 && (name.includes(needle) || needle.includes(name)))
      );
    })
    .slice(0, 5)
    .map(suggestionFor);
  return { error: "unknown", suggestions };
}

/**
 * Resolve an `@mention` / handle / `user:<id>` token to the roster's stable
 * human participant (WP7 §5). The policy agent uses this to target `ask_user` /
 * `feedback_form` at a SPECIFIC human; an UNaddressed prompt falls back to all
 * `kind:"user"` participants (first-answer-wins), so this helper's job is only
 * the addressed case. Returns the matching `ParticipantRef`, or null when no
 * human in the roster matches unambiguously.
 *
 * Human-only by contract, not by accident: `ask_user` asks a *person*. Agent
 * addressing goes through `resolveHandle` directly.
 */
export function resolveMentionToUser(
  mention: string,
  roster: Iterable<ParticipantRef>
): ParticipantRef | null {
  const resolved = resolveHandle(mention, roster, { kinds: ["user"] });
  return isHandleResolutionFailure(resolved) ? null : resolved;
}

function participantKindFromMetadata(
  participantId: string,
  declaredKind: unknown
): ParticipantKind {
  if (
    declaredKind === "user" ||
    declaredKind === "agent" ||
    declaredKind === "system" ||
    declaredKind === "panel" ||
    declaredKind === "external"
  ) {
    return declaredKind;
  }
  if (participantId === "system") return "system";
  // Stable principal-derived human id (WP6 §4): one `user:<userId>` identity
  // per human, shared across all their panels/devices.
  if (participantId.startsWith("user:")) return "user";
  if (participantId.startsWith("panel:")) return "panel";
  if (participantId.startsWith("do:")) return "agent";
  return "external";
}
