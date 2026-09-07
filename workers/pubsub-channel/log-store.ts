/**
 * Channel log access on the unified-log core (WS2 §2).
 *
 * Appends and forks target the Stage-0 core surface (`appendLogEvent`,
 * `forkLog`, `getLogEvent`) directly; replay windows ride the lineage-aware
 * `readChannelEnvelopes` read (server-side windowing over `log_events` —
 * one round trip per page instead of N). Blob spill/hydrate stays here; all
 * schema validation and participant sanitization happens inside the GAD
 * append txn.
 */

import type { ChannelEvent } from "@workspace/pubsub";
import {
  collectChannelEnvelopePages,
  type ChannelEnvelopePage,
  type ChannelEnvelopePageInfo,
  type ChannelEnvelopeWindow,
} from "@vibestudio/shared/channelEnvelopePaging";
import {
  createGadServiceClient,
  type DurableObjectServiceClient,
} from "@workspace/runtime/workerd-client";
import {
  DEFAULT_CHANNEL_REPLAY_PAGE_LIMIT,
  MAX_CHANNEL_REPLAY_PAGE_LIMIT,
  type BootstrapSnapshot,
  type ChannelReplayAfterRequest,
  type ChannelReplayEnvelope,
  type ServerLogEvent,
  MessageTypeDefinitionSchema,
  type MessageTypeDefinition,
} from "@workspace/pubsub";
import {
  encodeChannelPayloadStoredValues,
  hydrateStoredValueRefs,
  participantRefFromMetadata,
  publicParticipantMetadata,
  type AppendIdempotency,
  type LogEnvelope,
} from "@workspace/agentic-protocol";
import type { StoredAttachment } from "./types.js";
import { buildChannelEvent } from "./broadcast.js";

export const CHANNEL_LOG_HEAD = "main";

export interface ChannelAppendInput {
  /** payloadKind: "agentic.trajectory.v1/event" | "presence" | "error" | ... */
  type: string;
  payload: unknown;
  senderId: string;
  senderMetadata?: Record<string, unknown>;
  /** Deterministic ids welcome: invocationId, `terminal:{id}`, `ik:{key}`. */
  messageId?: string;
  /** Append intent (see AppendIdempotency in agentic-protocol). Default
   *  "exact" — divergent duplicates are integrity errors. ONLY the client
   *  publish path passes "idempotent-by-id" (stable retry token, volatile
   *  payload fields → first write wins). */
  idempotency?: AppendIdempotency;
  /** Policy annotations (agentHops, ...). */
  annotations?: Record<string, unknown>;
  attachments?: StoredAttachment[];
  /** Derived only from the host-sealed caller attestation by PubSubChannel. */
  contentClass: "internal" | "external";
  externalKeys: string[];
}

export interface ChannelReplayContext {
  contextId?: string;
  channelConfig?: Record<string, unknown>;
  snapshots?: BootstrapSnapshot[];
}

interface RpcCallerLike {
  call<T = unknown>(targetId: string, method: string, args: unknown[]): Promise<T>;
}

type GadReplayPage = ChannelEnvelopePage<GadChannelEnvelopeView>;
type ReplayWindowPageInfo = Pick<
  ChannelEnvelopePageInfo,
  | "totalCount"
  | "firstSeq"
  | "lastSeq"
  | "returnedFromSeq"
  | "returnedToSeq"
  | "snapshotLastSeq"
  | "hasMoreBefore"
  | "hasMoreAfter"
>;
interface GadReplayWindow {
  items: GadChannelEnvelopeView[];
  pageInfo: ReplayWindowPageInfo;
}

/** The ChannelEnvelope view shape the gad replay-window read returns. */
interface GadChannelEnvelopeView {
  envelopeId: string;
  channelId: string;
  seq: number;
  from: {
    id: string;
    participantId?: string;
    metadata?: Record<string, unknown>;
  };
  payload: unknown;
  payloadKind?: string;
  metadata?: Record<string, unknown>;
  attachments?: unknown[];
  contentClass: "internal" | "external";
  externalKeys: string[];
  publishedAt: string;
}

interface AppendLogEventResultLike {
  headSeq: number;
  headHash: string;
  envelopes: LogEnvelope[];
}

/** annotations minus the metadata/attachments carriers. */
function policyAnnotations(
  annotations: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!annotations) return undefined;
  const {
    metadata: _metadata,
    attachments: _attachments,
    contentClass: _contentClass,
    externalKeys: _externalKeys,
    ...rest
  } = annotations;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function contentIntegrityFromAnnotations(annotations: Record<string, unknown>): {
  contentClass: "internal" | "external";
  externalKeys: string[];
} {
  const contentClass = annotations["contentClass"];
  const externalKeys = annotations["externalKeys"];
  if (
    (contentClass !== "internal" && contentClass !== "external") ||
    !Array.isArray(externalKeys) ||
    !externalKeys.every((key) => typeof key === "string") ||
    (contentClass === "internal" && externalKeys.length > 0)
  ) {
    throw new Error("Durable channel envelope is missing valid content-integrity provenance");
  }
  return { contentClass, externalKeys: [...externalKeys] };
}

export class ChannelLog {
  private readonly gad: DurableObjectServiceClient;
  constructor(
    private readonly rpc: RpcCallerLike,
    private readonly channelId: string
  ) {
    this.gad = createGadServiceClient(rpc);
  }

  async append(input: ChannelAppendInput): Promise<ChannelEvent> {
    const payload = await this.encodePayload(input.payload);
    const annotations: Record<string, unknown> = {
      ...(input.annotations ?? {}),
    };
    const publicMetadata = publicParticipantMetadata(input.senderMetadata);
    if (publicMetadata !== undefined) annotations["metadata"] = publicMetadata;
    if (input.attachments !== undefined) annotations["attachments"] = input.attachments;
    annotations["contentClass"] = input.contentClass;
    annotations["externalKeys"] = [...input.externalKeys];
    // Idempotency intent is the STORE's contract now (no error-string
    // matching here): "idempotent-by-id" callers get the journaled original
    // back as a replayed envelope; everyone else gets hard typed errors.
    const result = await this.gad.call<AppendLogEventResultLike>("appendLogEvent", {
      logId: this.channelId,
      head: CHANNEL_LOG_HEAD,
      logKind: "channel",
      ...(input.idempotency ? { idempotency: input.idempotency } : {}),
      events: [
        {
          envelopeId: input.messageId ?? null,
          actor: participantRefFromMetadata(input.senderId, input.senderMetadata),
          payloadKind: input.type,
          payload,
          ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
        },
      ],
    });
    const envelope = result.envelopes[result.envelopes.length - 1]!;
    return this.eventFromLogEnvelope(await this.hydrate(envelope));
  }

  async forkFrom(parentChannelId: string, throughSeq: number | null): Promise<void> {
    await this.gad.call("forkLog", {
      fromLogId: parentChannelId,
      fromHead: CHANNEL_LOG_HEAD,
      toLogId: this.channelId,
      toHead: CHANNEL_LOG_HEAD,
      atSeq: throughSeq,
    });
  }

  async headSeq(): Promise<number> {
    const head = await this.gad.call<{ seq: number } | null>("getLogHead", {
      logId: this.channelId,
      head: CHANNEL_LOG_HEAD,
    });
    return head?.seq ?? 0;
  }

  async listMessageTypes(): Promise<MessageTypeDefinition[]> {
    const rows = await this.gad.call<unknown[]>("listMessageTypes", {
      channelId: this.channelId,
    });
    return Promise.all(
      rows.map(async (row) => MessageTypeDefinitionSchema.parse(await this.hydrate(row)))
    );
  }

  async getMessageType(typeId: string): Promise<MessageTypeDefinition | null> {
    const row = await this.gad.call<unknown | null>("getMessageType", {
      channelId: this.channelId,
      typeId,
    });
    return row ? MessageTypeDefinitionSchema.parse(await this.hydrate(row)) : null;
  }

  async hasEnvelope(envelopeId: string): Promise<boolean> {
    const envelope = await this.gad.call<LogEnvelope | null>("getLogEvent", {
      logId: this.channelId,
      head: CHANNEL_LOG_HEAD,
      envelopeId,
    });
    return envelope != null;
  }

  async hasEnvelopes(envelopeIds: string[]): Promise<Set<string>> {
    const uniqueIds = Array.from(
      new Set(envelopeIds.filter((id) => typeof id === "string" && id.length > 0))
    );
    if (uniqueIds.length === 0) return new Set();
    const present = await this.gad.call<string[]>("hasLogEvents", {
      logId: this.channelId,
      head: CHANNEL_LOG_HEAD,
      envelopeIds: uniqueIds,
    });
    return new Set(present);
  }

  async getEventByEnvelopeId(envelopeId: string): Promise<ChannelEvent | null> {
    const envelope = await this.gad.call<LogEnvelope | null>("getLogEvent", {
      logId: this.channelId,
      head: CHANNEL_LOG_HEAD,
      envelopeId,
    });
    if (!envelope) return null;
    return this.eventFromLogEnvelope(await this.hydrate(envelope));
  }

  /** Lineage-aware ascending page over durable envelopes (policy folds,
   *  derivePendingCalls). Payloads are NOT hydrated (policies must not depend
   *  on blob-spilled fields). */
  async read(opts: {
    afterSeq?: number;
    beforeSeq?: number;
    limit?: number;
    payloadKind?: string;
  }): Promise<LogEnvelope[]> {
    return this.gad.call<LogEnvelope[]>("readLog", {
      logId: this.channelId,
      head: CHANNEL_LOG_HEAD,
      afterSeq: opts.afterSeq ?? 0,
      beforeSeq: opts.beforeSeq ?? null,
      limit: opts.limit ?? 500,
      payloadKind: opts.payloadKind ?? null,
    });
  }

  /** Hydrated ascending events for deterministic local projection folds. */
  async readEvents(opts: { afterSeq: number; limit?: number }): Promise<ChannelEvent[]> {
    const rows = await this.read({
      afterSeq: opts.afterSeq,
      limit: opts.limit ?? 500,
    });
    return Promise.all(rows.map(async (row) => this.eventFromLogEnvelope(await this.hydrate(row))));
  }

  async replayAfter(
    request: ChannelReplayAfterRequest,
    context: ChannelReplayContext
  ): Promise<ChannelReplayEnvelope> {
    const after = request.after;
    const limit = request.limit ?? DEFAULT_CHANNEL_REPLAY_PAGE_LIMIT;
    if (!Number.isInteger(after) || after < 0) {
      throw new RangeError("channel replay after must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CHANNEL_REPLAY_PAGE_LIMIT) {
      throw new RangeError(
        `channel replay limit must be an integer between 1 and ${MAX_CHANNEL_REPLAY_PAGE_LIMIT}`
      );
    }
    if (
      request.throughSeq !== undefined &&
      (!Number.isInteger(request.throughSeq) || request.throughSeq < after)
    ) {
      throw new RangeError("channel replay throughSeq must be an integer not less than after");
    }
    const window = await this.readReplayWindow(
      {
        kind: "after",
        seq: after,
        ...(request.throughSeq !== undefined ? { throughSeq: request.throughSeq } : {}),
      },
      limit,
      true
    );
    return this.replayFromWindow("after", window, context);
  }

  async replayBefore(
    beforeSeq: number,
    limit: number,
    context: ChannelReplayContext
  ): Promise<ChannelReplayEnvelope> {
    this.assertReplayLimit(limit);
    const window = await this.readReplayWindow({ kind: "before", seq: beforeSeq }, limit, true);
    return this.replayFromWindow("before", window, context);
  }

  async replayInitial(
    limit: number,
    context: ChannelReplayContext
  ): Promise<ChannelReplayEnvelope> {
    this.assertReplayLimit(limit, true);
    const window = await this.readReplayWindow({ kind: "tail" }, limit, true);
    return this.replayFromWindow("initial", window, context);
  }

  private assertReplayLimit(limit: number, allowZero = false): void {
    const minimum = allowZero ? 0 : 1;
    if (!Number.isInteger(limit) || limit < minimum || limit > MAX_CHANNEL_REPLAY_PAGE_LIMIT) {
      throw new RangeError(
        `channel replay limit must be an integer between ${minimum} and ${MAX_CHANNEL_REPLAY_PAGE_LIMIT}`
      );
    }
  }

  async inspectRows(opts: {
    afterId?: number;
    beforeId?: number;
    limit?: number;
  }): Promise<Record<string, unknown>[]> {
    const window = await this.readReplayWindow(
      opts.beforeId != null
        ? { kind: "before", seq: opts.beforeId }
        : opts.afterId != null
          ? { kind: "after", seq: opts.afterId }
          : { kind: "tail" },
      opts.limit ?? 50,
      false
    );
    return window.items.map((envelope) => this.inspectionRow(envelope));
  }

  async inspectEnvelope(envelopeId: string): Promise<Record<string, unknown>[]> {
    const envelope = await this.gad.call<LogEnvelope | null>("getLogEvent", {
      logId: this.channelId,
      head: CHANNEL_LOG_HEAD,
      envelopeId,
    });
    if (!envelope) return [];
    const contentIntegrity = contentIntegrityFromAnnotations(envelope.annotations ?? {});
    return [
      this.inspectionRow({
        envelopeId: String(envelope.envelopeId),
        channelId: this.channelId,
        seq: envelope.seq,
        from: envelope.actor as GadChannelEnvelopeView["from"],
        payload: envelope.payload,
        payloadKind: envelope.payloadKind,
        metadata: envelope.annotations?.["metadata"] as Record<string, unknown> | undefined,
        attachments: envelope.annotations?.["attachments"] as unknown[] | undefined,
        ...contentIntegrity,
        publishedAt: envelope.appendedAt,
      }),
    ];
  }

  private inspectionRow(envelope: GadChannelEnvelopeView): Record<string, unknown> {
    return {
      seq: envelope.seq,
      envelope_id: envelope.envelopeId,
      payload_kind: envelope.payloadKind,
      payload: JSON.stringify(envelope.payload),
      from_id: envelope.from.participantId ?? envelope.from.id,
      from_json: JSON.stringify(envelope.metadata ?? envelope.from.metadata ?? {}),
      attachments: envelope.attachments ? JSON.stringify(envelope.attachments) : null,
      published_at: Date.parse(envelope.publishedAt),
    };
  }

  private replayFromWindow(
    mode: ChannelReplayEnvelope["mode"],
    window: GadReplayWindow,
    context: ChannelReplayContext
  ): ChannelReplayEnvelope {
    return {
      mode,
      logEvents: window.items.map(
        (envelope): ServerLogEvent => this.eventFromChannelView(envelope)
      ),
      snapshots: context.snapshots ?? [],
      ready: {
        contextId: context.contextId,
        channelConfig: context.channelConfig,
        totalCount: window.pageInfo.totalCount,
        envelopeCount: window.pageInfo.totalCount,
        firstEnvelopeSeq: window.pageInfo.firstSeq,
        replayFromId: window.pageInfo.returnedFromSeq,
        replayToId: window.pageInfo.returnedToSeq,
        snapshotLastSeq: window.pageInfo.snapshotLastSeq,
        hasMoreBefore: window.pageInfo.hasMoreBefore,
        hasMoreAfter: window.pageInfo.hasMoreAfter,
      },
    };
  }

  private eventFromChannelView(envelope: GadChannelEnvelopeView): ChannelEvent {
    return buildChannelEvent(
      envelope.seq,
      envelope.envelopeId,
      envelope.payloadKind ?? "message",
      JSON.stringify(envelope.payload),
      envelope.from.participantId ?? envelope.from.id,
      envelope.metadata ?? envelope.from.metadata,
      Date.parse(envelope.publishedAt),
      envelope.attachments as StoredAttachment[] | undefined,
      policyAnnotations((envelope as { annotations?: Record<string, unknown> }).annotations),
      {
        contentClass: envelope.contentClass,
        externalKeys: envelope.externalKeys,
      }
    );
  }

  eventFromLogEnvelope(envelope: LogEnvelope): ChannelEvent {
    const annotations = envelope.annotations ?? {};
    return buildChannelEvent(
      envelope.seq,
      String(envelope.envelopeId),
      envelope.payloadKind,
      JSON.stringify(envelope.payload),
      (envelope.actor as { participantId?: string }).participantId ?? envelope.actor.id,
      (annotations["metadata"] as Record<string, unknown> | undefined) ??
        (envelope.actor as { metadata?: Record<string, unknown> }).metadata,
      Date.parse(envelope.appendedAt),
      annotations["attachments"] as StoredAttachment[] | undefined,
      policyAnnotations(envelope.annotations),
      contentIntegrityFromAnnotations(annotations)
    );
  }

  private async encodePayload(payload: unknown): Promise<unknown> {
    return encodeChannelPayloadStoredValues(payload, {
      putText: (value) =>
        this.rpc.call<{ digest: string; size: number }>("main", "blobstore.putText", [value]),
    });
  }

  private async hydrateReplayPage(window: GadReplayPage): Promise<GadReplayPage> {
    return {
      ...window,
      items: await Promise.all(window.items.map((envelope) => this.hydrate(envelope))),
    };
  }

  private async readReplayWindow(
    window: ChannelEnvelopeWindow,
    maximumItems: number | "all",
    hydrate: boolean
  ): Promise<GadReplayWindow> {
    const pages = await collectChannelEnvelopePages(
      { channelId: this.channelId, window },
      { maximumItems },
      async (request) => {
        const page = await this.gad.call<GadReplayPage>("readChannelEnvelopes", request);
        return hydrate ? this.hydrateReplayPage(page) : page;
      }
    );
    const firstPage = pages[0]!;
    const lastPage = pages[pages.length - 1]!;
    const items = pages.flatMap((page) => page.items);
    return {
      items,
      pageInfo: {
        totalCount: firstPage.pageInfo.totalCount,
        ...(firstPage.pageInfo.firstSeq !== undefined
          ? { firstSeq: firstPage.pageInfo.firstSeq }
          : {}),
        ...(firstPage.pageInfo.lastSeq !== undefined
          ? { lastSeq: firstPage.pageInfo.lastSeq }
          : {}),
        ...(firstPage.pageInfo.snapshotLastSeq !== undefined
          ? { snapshotLastSeq: firstPage.pageInfo.snapshotLastSeq }
          : {}),
        ...(items[0]?.seq !== undefined ? { returnedFromSeq: items[0].seq } : {}),
        ...(items[items.length - 1]?.seq !== undefined
          ? { returnedToSeq: items[items.length - 1]!.seq }
          : {}),
        hasMoreBefore: firstPage.pageInfo.hasMoreBefore,
        hasMoreAfter: lastPage.pageInfo.hasMoreAfter,
      },
    };
  }

  private async hydrate<T>(value: T): Promise<T> {
    return hydrateStoredValueRefs(value, {
      getText: (digest) => this.rpc.call<string | null>("main", "blobstore.getText", [digest]),
    }) as Promise<T>;
  }
}
