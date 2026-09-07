import { AGENTIC_EVENT_PAYLOAD_KIND, CREDENTIAL_CONNECT_PAYLOAD_KIND } from "./constants.js";
import type {
  ActorRef,
  ExternalEnvelopeObservedPayload,
  ExternalEnvelopePublishedPayload,
  AgenticEvent,
  AutomationDefinitionSnapshot,
  AutomationInstitutedPayload,
  ChannelForkArchivedPayload,
  ChannelForkRenamedPayload,
  ChannelForkedPayload,
  CustomStartedPayload,
  CustomUpdatedPayload,
  CustomMessageDisplayMode,
  MessageTypeClearedPayload,
  MessageTypeRegisteredPayload,
  ParticipantRef,
  SandboxSourcePayload,
} from "./events.js";
import type { ChannelEnvelope, ChannelRosterEntry } from "./envelopes.js";
import type {
  ApprovalMap,
  InlineUiMap,
  InvocationMap,
  MessageMap,
  ProjectedActionBar,
  TaskMap,
  TurnMap,
} from "./handlers.js";
import {
  applyApprovalEvent,
  applyInvocationEvent,
  applyMessageEvent,
  applyTaskEvent,
  applyUiEvent,
  participantKey,
  resolveIntendedRecipients,
} from "./handlers.js";
import { agenticEventEnvelopeSchema } from "./schemas.js";
import { assertNoStoredValueRefs } from "./stored-values.js";

export interface ChannelTimelineEntry {
  envelopeId: string;
  seq: number;
  participantId: string;
  kind: string;
  createdAt: string;
}

export interface ProjectedAutomationInstitution {
  definition: AutomationDefinitionSnapshot;
  actor: ActorRef;
  createdAt: string;
  seq: number;
}

export interface ProjectedMessageTypeDefinition {
  typeId: string;
  displayMode?: CustomMessageDisplayMode;
  source?: SandboxSourcePayload;
  imports?: Record<string, string>;
  stateSchema?: Record<string, unknown>;
  updateSchema?: Record<string, unknown>;
  registeredBy?: ActorRef;
  updatedAtSeq: number;
  clearedAtSeq?: number;
}

export interface ProjectedCustomMessageUpdate {
  update: unknown;
  seq: number;
}

export interface ProjectedCustomMessage {
  messageId: string;
  typeId?: string;
  displayMode?: CustomMessageDisplayMode;
  initialState?: unknown;
  by?: ActorRef;
  startedAtSeq?: number;
  startedAt?: string;
  updatedAt?: string;
  updates: ProjectedCustomMessageUpdate[];
  lastSeq: number;
  /** Set when the owner published a terminal failure for this card. */
  failed?: true;
  error?: { message: string; details?: unknown };
}

/** An unresolved model-credential connect request (one per credKey). */
export interface ProjectedCredentialRequest {
  credKey: string;
  providerId: string;
  /** Connect-preset props for the credential card (ModelCredentialSetupProps). */
  connectSpec: Record<string, unknown>;
  modelBaseUrl?: string;
  reason?: string;
  failureCode?: string;
  expiresAt?: string;
  envelopeId: string;
  seq: number;
  /** The requesting agent's participant id (card method-call target). */
  participantId: string;
  publishedAt?: string;
}

export interface ProjectedSystemNotice {
  noticeId: string;
  actor: ActorRef;
  kind: string;
  summary: string;
  detail?: string;
  turnId?: string;
  messageId?: string;
  seq: number;
  createdAt: string;
}

/**
 * A conversation fork rooted off this channel, folded from a durable
 * `channel.forked` envelope on the PARENT channel. `createdAtSeq` and `archived`
 * are synthesized by the reducer (from the envelope seq and the
 * `channel.fork_archived` latch), NOT carried on the payload.
 */
export interface ForkProjection {
  parentChannelId: string;
  forkId: string;
  forkedChannelId: string;
  forkedContextId: string;
  forkPointId: number;
  label: string;
  reason: string;
  actor: ParticipantRef;
  createdAtSeq: number;
  headSeq: number;
  archived: boolean;
}

/** Cross-channel refs are identified by (channel, envelope), never by envelope
 *  id alone — two channels can and do use the same message id. */
export function externalRefKey(channelId: string, envelopeId: string): string {
  return `${channelId}\u0000${envelopeId}`;
}


/** One reference to something an agent of this channel published elsewhere. */
export interface ProjectedExternalPublication {
  key: string;
  channelId: string;
  envelopeId: string;
  payloadKind?: string;
  /** One-line excerpt so the collapsed row reads well offline. It is NOT the
   *  record of record — the full text is durable in the target channel, and in
   *  this channel as the `notify` invocation's own arguments. */
  summary?: string;
  from: ActorRef;
  publishedAt: string;
  seq?: number;
}

/** The authoring context of a guest envelope that arrived here. */
export interface ProjectedExternalObservation {
  key: string;
  channelId: string;
  envelopeId: string;
  from: ParticipantRef;
  payloadKind?: string;
  observedAt: string;
}

export interface ChannelViewState {
  channelId?: string;
  cursor?: number;
  credentialRequests: Record<string, ProjectedCredentialRequest>;
  messages: MessageMap;
  invocations: InvocationMap;
  tasks: TaskMap;
  approvals: ApprovalMap;
  inlineUi: Record<string, InlineUiMap>;
  actionBars: Record<string, ProjectedActionBar | undefined>;
  messageTypes: Record<string, ProjectedMessageTypeDefinition>;
  customMessages: Record<string, ProjectedCustomMessage>;
  systemNotices: Record<string, ProjectedSystemNotice>;
  /** Durable definition events keyed by mission identity. A duplicate retry
   * updates no scheduler state and collapses to the same history item. */
  automationInstitutions: Record<string, ProjectedAutomationInstitution>;
  /** Direct-child forks rooted off this channel, in append (seq) order. */
  forks: ForkProjection[];
  turns: TurnMap;
  /** Intended-recipient snapshot per message, resolved against the roster AT
   *  the moment the message was first projected (send time) and never
   *  recomputed — a later join/leave must not change a message's recipients.
   *  Keyed by messageId; values are participant keys. */
  intendedRecipientsByMessage: Record<string, string[]>;
  roster: Record<string, ChannelRosterEntry>;
  /**
   * Cross-channel traffic (messaging plan §4.10.1), keyed `<channelId>\u0000<envelopeId>`.
   *
   * `externalPublications` is what THIS channel's agents said elsewhere — a
   * reference, never a relayed transcript: the utterance itself lives once, in
   * the target channel's log (D15). `externalObservations` is the reverse
   * back-pointer a guest envelope leaves behind, so an incoming message can
   * name the context it was authored in.
   */
  externalPublications: Record<string, ProjectedExternalPublication>;
  externalObservations: Record<string, ProjectedExternalObservation>;
  timeline: ChannelTimelineEntry[];
  seenEnvelopeIds: Record<string, true>;
  ignoredEnvelopeIds: string[];
  ignoredEnvelopeErrors: Record<string, string>;
}

export function createInitialChannelViewState(): ChannelViewState {
  return {
    externalPublications: {},
    externalObservations: {},
    credentialRequests: {},
    messages: {},
    invocations: {},
    tasks: {},
    approvals: {},
    inlineUi: {},
    actionBars: {},
    messageTypes: {},
    customMessages: {},
    systemNotices: {},
    automationInstitutions: {},
    forks: [],
    turns: {},
    intendedRecipientsByMessage: {},
    roster: {},
    timeline: [],
    seenEnvelopeIds: {},
    ignoredEnvelopeIds: [],
    ignoredEnvelopeErrors: {},
  };
}

export function reduceChannelView(
  state: ChannelViewState,
  envelope: ChannelEnvelope
): ChannelViewState {
  if (state.seenEnvelopeIds[envelope.envelopeId]) {
    return state;
  }

  if (envelope.payloadKind === CREDENTIAL_CONNECT_PAYLOAD_KIND) {
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;
    const credKey = typeof payload["credKey"] === "string" ? payload["credKey"] : "";
    const base = {
      ...state,
      channelId: envelope.channelId,
      cursor: envelope.seq,
      seenEnvelopeIds: { ...state.seenEnvelopeIds, [envelope.envelopeId]: true as const },
    };
    if (!credKey) return base;
    return {
      ...base,
      credentialRequests: {
        ...state.credentialRequests,
        [credKey]: {
          credKey,
          providerId: String(payload["providerId"] ?? ""),
          connectSpec: (payload["connectSpec"] ?? {}) as Record<string, unknown>,
          modelBaseUrl:
            typeof payload["modelBaseUrl"] === "string" ? payload["modelBaseUrl"] : undefined,
          reason: typeof payload["reason"] === "string" ? payload["reason"] : undefined,
          failureCode:
            typeof payload["failureCode"] === "string" ? payload["failureCode"] : undefined,
          expiresAt: typeof payload["expiresAt"] === "string" ? payload["expiresAt"] : undefined,
          envelopeId: String(envelope.envelopeId),
          seq: envelope.seq,
          participantId: participantKey(envelope.from),
          publishedAt: envelope.publishedAt,
        },
      },
    };
  }

  if (envelope.payloadKind !== AGENTIC_EVENT_PAYLOAD_KIND) {
    return {
      ...state,
      channelId: envelope.channelId,
      cursor: envelope.seq,
      seenEnvelopeIds: { ...state.seenEnvelopeIds, [envelope.envelopeId]: true },
      ignoredEnvelopeIds: [...state.ignoredEnvelopeIds, envelope.envelopeId],
      ignoredEnvelopeErrors: {
        ...state.ignoredEnvelopeErrors,
        [envelope.envelopeId]: `unsupported payloadKind: ${envelope.payloadKind ?? "<missing>"}`,
      },
    };
  }

  const result = agenticEventEnvelopeSchema.safeParse(envelope);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return {
      ...state,
      channelId: envelope.channelId,
      cursor: envelope.seq,
      seenEnvelopeIds: { ...state.seenEnvelopeIds, [envelope.envelopeId]: true },
      ignoredEnvelopeIds: [...state.ignoredEnvelopeIds, envelope.envelopeId],
      ignoredEnvelopeErrors: {
        ...state.ignoredEnvelopeErrors,
        [envelope.envelopeId]: message,
      },
    };
  }
  const parsed = result.data;
  const event = parsed.payload as AgenticEvent;
  assertNoStoredValueRefs(event, "channel view reducer input");
  const participantId = participantKey(parsed.from);
  let next: ChannelViewState = {
    ...state,
    channelId: parsed.channelId,
    cursor: parsed.seq,
    seenEnvelopeIds: { ...state.seenEnvelopeIds, [parsed.envelopeId]: true },
    timeline: [
      ...state.timeline,
      {
        envelopeId: parsed.envelopeId,
        seq: parsed.seq,
        participantId,
        kind: event.kind,
        createdAt: event.createdAt,
      },
    ],
  };

  if (event.kind.startsWith("message.")) {
    next = { ...next, messages: applyMessageEvent(next.messages, event as never, parsed.seq) };
    // Snapshot intended recipients the first time a message is projected (send
    // time). Stored once; never recomputed against a later roster.
    const messageId = event.causality?.messageId;
    if (
      messageId &&
      (event.kind === "message.started" || event.kind === "message.completed") &&
      next.intendedRecipientsByMessage[messageId] === undefined
    ) {
      const projected = next.messages[messageId];
      const payload = event.payload as { mentions?: string[] };
      next = {
        ...next,
        intendedRecipientsByMessage: {
          ...next.intendedRecipientsByMessage,
          [messageId]: resolveIntendedRecipients({
            to: projected?.to,
            mentions: projected?.mentions ?? payload.mentions,
            roster: Object.values(next.roster),
            senderKey: participantKey(event.actor),
          }),
        },
      };
    }
  } else if (event.kind.startsWith("invocation.")) {
    next = {
      ...next,
      invocations: applyInvocationEvent(next.invocations, event as never),
    };
  } else if (event.kind.startsWith("task.")) {
    next = {
      ...next,
      tasks: applyTaskEvent(next.tasks, event as never),
    };
  } else if (event.kind.startsWith("approval.")) {
    next = {
      ...next,
      approvals: applyApprovalEvent(next.approvals, event as never),
    };
  } else if (event.kind === "ui.feedback") {
    // Feedback is for the targeted agent's harness, not the channel view;
    // it lands in the timeline only.
  } else if (event.kind.startsWith("ui.")) {
    const inlineUi = next.inlineUi[participantId] ?? {};
    const { inlineUi: nextInlineUi, actionBar } = applyUiEvent(
      inlineUi,
      next.actionBars[participantId],
      event as never
    );
    next = {
      ...next,
      inlineUi: {
        ...next.inlineUi,
        [participantId]: nextInlineUi,
      },
      actionBars: {
        ...next.actionBars,
        [participantId]: actionBar,
      },
    };
  } else if (event.kind === "messageType.registered") {
    const payload = event.payload as MessageTypeRegisteredPayload;
    const existing = next.messageTypes[payload.typeId];
    const clearedAtSeq = existing?.clearedAtSeq;
    if (parsed.seq > (existing?.updatedAtSeq ?? -1) && parsed.seq > (clearedAtSeq ?? -1)) {
      next = {
        ...next,
        messageTypes: {
          ...next.messageTypes,
          [payload.typeId]: {
            typeId: payload.typeId,
            displayMode: payload.displayMode,
            source: payload.source,
            imports: payload.imports,
            stateSchema: payload.stateSchema,
            updateSchema: payload.updateSchema,
            registeredBy: payload.registeredBy,
            updatedAtSeq: parsed.seq,
            ...(clearedAtSeq !== undefined ? { clearedAtSeq } : {}),
          },
        },
      };
    }
  } else if (event.kind === "messageType.cleared") {
    const payload = event.payload as MessageTypeClearedPayload;
    const existing = next.messageTypes[payload.typeId];
    const clearedAtSeq = Math.max(existing?.clearedAtSeq ?? -1, parsed.seq);
    const cleared = existing
      ? { ...existing, clearedAtSeq }
      : { typeId: payload.typeId, updatedAtSeq: -1, clearedAtSeq };
    next = {
      ...next,
      messageTypes: {
        ...next.messageTypes,
        [payload.typeId]: cleared,
      },
    };
  } else if (event.kind === "custom.started") {
    const payload = event.payload as CustomStartedPayload;
    const existing: ProjectedCustomMessage = next.customMessages[payload.messageId] ?? {
      messageId: payload.messageId,
      updates: [],
      lastSeq: -1,
    };
    const shouldFillStart = existing.startedAtSeq === undefined;
    if (shouldFillStart) {
      next = {
        ...next,
        customMessages: {
          ...next.customMessages,
          [payload.messageId]: {
            ...existing,
            typeId: payload.typeId,
            displayMode: payload.displayMode,
            initialState: payload.initialState,
            by: payload.by ?? event.actor,
            startedAtSeq: parsed.seq,
            startedAt: event.createdAt,
            updatedAt: existing.updatedAt ?? event.createdAt,
            lastSeq: existing.lastSeq,
          },
        },
      };
    }
  } else if (event.kind === "custom.updated") {
    const payload = event.payload as CustomUpdatedPayload;
    const existing: ProjectedCustomMessage = next.customMessages[payload.messageId] ?? {
      messageId: payload.messageId,
      updates: [],
      lastSeq: -1,
    };
    if (existing.updates.some((update) => update.seq === parsed.seq)) {
      next = next.customMessages[payload.messageId]
        ? next
        : {
            ...next,
            customMessages: {
              ...next.customMessages,
              [payload.messageId]: existing,
            },
          };
    } else {
      const updates = [...existing.updates, { update: payload.update, seq: parsed.seq }].sort(
        (a, b) => a.seq - b.seq
      );
      const isNewest = parsed.seq >= existing.lastSeq;
      const updated: ProjectedCustomMessage = {
        ...existing,
        updates,
        updatedAt: isNewest ? event.createdAt : existing.updatedAt,
        lastSeq: Math.max(existing.lastSeq, parsed.seq),
      };
      // A failure marks the card; a newer successful update clears it.
      if (isNewest) {
        if (payload.status === "failed") {
          updated.failed = true;
          updated.error = payload.error ?? { message: "card failed" };
        } else {
          delete updated.failed;
          delete updated.error;
        }
      }
      next = {
        ...next,
        customMessages: {
          ...next.customMessages,
          [payload.messageId]: updated,
        },
      };
    }
  } else if (event.kind === "automation.instituted") {
    const payload = event.payload as AutomationInstitutedPayload;
    const missionId = payload.definition.missionId;
    const existing = next.automationInstitutions?.[missionId];
    if (!existing || parsed.seq < existing.seq) {
      next = {
        ...next,
        automationInstitutions: {
          ...(next.automationInstitutions ?? {}),
          [missionId]: {
            definition: payload.definition,
            actor: event.actor,
            createdAt: event.createdAt,
            seq: parsed.seq,
          },
        },
      };
    }
  } else if (
    event.kind === "turn.opened" ||
    event.kind === "turn.waiting" ||
    event.kind === "turn.closed"
  ) {
    const turnId = event.turnId;
    // Seq-monotonic turn lifecycle: ignore a stale/out-of-order status event
    // (lower seq than already applied) so a replayed turn.opened or a late
    // turn.waiting can never resurrect a closed turn.
    const existingTurn = turnId ? next.turns[turnId] : undefined;
    const staleTurnEvent = existingTurn?.lastSeq !== undefined && parsed.seq < existingTurn.lastSeq;
    if (turnId && !staleTurnEvent) {
      const existing = existingTurn;
      const summary = "summary" in event.payload ? event.payload.summary : existing?.summary;
      const reason = "reason" in event.payload ? event.payload.reason : existing?.reason;
      const metadata =
        "metadata" in event.payload &&
        event.payload.metadata &&
        typeof event.payload.metadata === "object" &&
        !Array.isArray(event.payload.metadata)
          ? (event.payload.metadata as Record<string, unknown>)
          : existing?.metadata;
      next = {
        ...next,
        turns: {
          ...next.turns,
          [turnId]: {
            turnId,
            actor: existing?.actor ?? event.actor,
            status:
              event.kind === "turn.closed"
                ? "closed"
                : event.kind === "turn.waiting"
                  ? "waiting"
                  : "open",
            openedAt: existing?.openedAt ?? event.createdAt,
            ...(event.kind === "turn.closed" ? { closedAt: event.createdAt } : {}),
            updatedAt: event.createdAt,
            lastSeq: parsed.seq,
            ...(summary ? { summary } : {}),
            ...(reason ? { reason } : {}),
            ...(metadata ? { metadata } : {}),
          },
        },
      };
    }
  } else if (event.kind === "system.event") {
    const payload = event.payload as Record<string, unknown>;
    const details = (payload["details"] ?? {}) as Record<string, unknown>;
    const sysKind = String(payload["kind"] ?? details["kind"] ?? "");
    if (sysKind === "model.fallback_continued" || sysKind === "model.local_fallback_continued") {
      const causality = (event.causality ?? {}) as Record<string, unknown>;
      const summary =
        typeof payload["summary"] === "string" && payload["summary"].trim()
          ? payload["summary"].trim()
          : "continued on fallback model";
      const detail =
        typeof details["summary"] === "string" && details["summary"].trim()
          ? details["summary"].trim()
          : undefined;
      next = {
        ...next,
        systemNotices: {
          ...next.systemNotices,
          [parsed.envelopeId]: {
            noticeId: parsed.envelopeId,
            actor: event.actor,
            kind: sysKind,
            summary,
            ...(detail ? { detail } : {}),
            ...(event.turnId
              ? { turnId: event.turnId }
              : typeof causality["turnId"] === "string"
                ? { turnId: causality["turnId"] }
                : {}),
            ...(typeof causality["messageId"] === "string"
              ? { messageId: causality["messageId"] }
              : {}),
            seq: parsed.seq,
            createdAt: event.createdAt,
          },
        },
      };
    }
    if (sysKind === "credential.wait_resolved" || sysKind === "credential.wait_expired") {
      const credKey = String(payload["credKey"] ?? details["credKey"] ?? "");
      if (credKey && credKey in next.credentialRequests) {
        const { [credKey]: _resolved, ...rest } = next.credentialRequests;
        next = { ...next, credentialRequests: rest };
      }
    }
  } else if (event.kind === "external.envelope_published") {
    const payload = event.payload as ExternalEnvelopePublishedPayload;
    const added: Record<string, ProjectedExternalPublication> = {};
    for (const publication of payload.publications ?? []) {
      const key = externalRefKey(String(publication.channelId), String(publication.envelopeId));
      added[key] = {
        key,
        channelId: String(publication.channelId),
        envelopeId: String(publication.envelopeId),
        ...(publication.payloadKind ? { payloadKind: publication.payloadKind } : {}),
        ...(publication.summary ? { summary: publication.summary } : {}),
        from: event.actor,
        publishedAt: event.createdAt,
        ...(envelope.seq !== undefined ? { seq: envelope.seq } : {}),
      };
    }
    if (Object.keys(added).length > 0) {
      next = { ...next, externalPublications: { ...next.externalPublications, ...added } };
    }
  } else if (event.kind === "external.envelope_observed") {
    const payload = event.payload as ExternalEnvelopeObservedPayload;
    const key = externalRefKey(String(payload.channelId), String(payload.envelopeId));
    next = {
      ...next,
      externalObservations: {
        ...next.externalObservations,
        [key]: {
          key,
          channelId: String(payload.channelId),
          envelopeId: String(payload.envelopeId),
          from: payload.from,
          ...(payload.payloadKind ? { payloadKind: payload.payloadKind } : {}),
          observedAt: event.createdAt,
        },
      },
    };
  } else if (event.kind === "external.participant_observed") {
    const payload = event.payload;
    if ("participant" in payload) {
      const key = participantKey(payload.participant);
      const existing = next.roster[key];
      next = {
        ...next,
        roster: {
          ...next.roster,
          [key]: {
            participant: payload.participant,
            joinedAt:
              payload.action === "joined"
                ? event.createdAt
                : (existing?.joinedAt ?? event.createdAt),
            leftAt: payload.action === "left" ? event.createdAt : existing?.leftAt,
            roles: payload.roles ?? existing?.roles ?? [],
          },
        },
      };
    }
  } else if (event.kind === "channel.forked") {
    // Direct-child fork rooted off this channel. Dedup by forkId (the journaled
    // fork op appends by deterministic envelopeId, but a distinct replay path
    // could still re-present it); `createdAtSeq`/`archived` are synthesized here.
    const payload = event.payload as ChannelForkedPayload;
    if (
      payload.parentChannelId === parsed.channelId &&
      !next.forks.some((fork) => fork.forkId === payload.forkId)
    ) {
      next = {
        ...next,
        forks: [
          ...next.forks,
          {
            parentChannelId: payload.parentChannelId,
            forkId: payload.forkId,
            forkedChannelId: payload.forkedChannelId,
            forkedContextId: payload.forkedContextId,
            forkPointId: payload.forkPointId,
            label: payload.label,
            reason: payload.reason,
            actor: payload.actor,
            createdAtSeq: parsed.seq,
            headSeq: payload.headSeq,
            archived: false,
          },
        ],
      };
    }
  } else if (event.kind === "channel.fork_renamed") {
    const payload = event.payload as ChannelForkRenamedPayload;
    if (payload.parentChannelId !== parsed.channelId) return next;
    next = {
      ...next,
      forks: next.forks.map((fork) =>
        fork.forkId === payload.forkId ? { ...fork, label: payload.label } : fork
      ),
    };
  } else if (event.kind === "channel.fork_archived") {
    // One-way latch: archived can never flip back.
    const payload = event.payload as ChannelForkArchivedPayload;
    if (payload.parentChannelId !== parsed.channelId) return next;
    next = {
      ...next,
      forks: next.forks.map((fork) =>
        fork.forkId === payload.forkId ? { ...fork, archived: true } : fork
      ),
    };
  }

  if (event.turnId && event.kind !== "turn.closed" && event.kind !== "turn.waiting") {
    const existing = next.turns[event.turnId];
    if (
      (existing?.status === "open" ||
        (existing?.status === "waiting" && reactivatesWaitingTurn(event))) &&
      existing.updatedAt !== event.createdAt
    ) {
      next = {
        ...next,
        turns: {
          ...next.turns,
          [event.turnId]: {
            ...existing,
            status: "open",
            updatedAt: event.createdAt,
          },
        },
      };
    }
  }

  return next;
}

function reactivatesWaitingTurn(event: AgenticEvent): boolean {
  return (
    event.kind === "message.started" ||
    event.kind === "message.delta" ||
    event.kind === "invocation.started"
  );
}
