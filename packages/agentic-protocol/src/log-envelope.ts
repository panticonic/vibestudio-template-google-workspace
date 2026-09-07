import { z } from "zod";
import { canonicalJson, sha256HexSyncText } from "@vibestudio/content-addressing";
import { GENESIS_EVENT_HASH } from "./constants.js";
import type { EnvelopeId } from "./ids.js";
import type { ActorRef, EventCausality, ParticipantRef, ParticipantSelector } from "./events.js";
import {
  actorRefSchema,
  causalitySchema,
  participantRefSchema,
  participantSelectorSchema,
} from "./schemas.js";

export type LogKind = "trajectory" | "channel" | "vcs" | "builds" | "generic";

/** Causality keys for unified log events. Extends trajectory causality with
 *  cross-log publication provenance. */
export interface LogEventCausality extends EventCausality {
  originLogId?: string;
  originHead?: string;
  originEnvelopeId?: string;
  turnId?: string; // turnId folds into causality in the unified shape
}

export interface LogEnvelope<Payload = unknown> {
  logId: string;
  head: string;
  seq: number; // starts at 1 for new logs; child fork appends start at forkSeq + 1
  envelopeId: EnvelopeId;
  actor: ActorRef;
  to?: ParticipantRef[] | ParticipantSelector;
  payloadKind: string; // for trajectory logs: the agentic EventKind; for channels: e.g. "agentic.trajectory.v1/event", "presence", ...
  payload: Payload;
  annotations?: Record<string, unknown>; // policy-fold annotations (agentHops...), channel metadata/attachments
  causality?: LogEventCausality;
  appendedAt: string; // ISO timestamp
  prevHash: string; // GENESIS_EVENT_HASH or parent fork hash for the first event
  hash: string;
}

export const LOG_GENESIS_HASH = GENESIS_EVENT_HASH;

/** Structural input for the hash-covered slice — accepts both full
 *  LogEnvelopes and the semantic control plane's pre-append event shape. */
export interface LogEnvelopeSemanticInput {
  envelopeId: string;
  actor: unknown;
  to?: unknown;
  payloadKind: string;
  payload: unknown;
  annotations?: Record<string, unknown>;
  causality?: unknown;
  appendedAt: string;
}

/** The hash-covered slice: everything except logId/head/seq/prevHash/hash,
 *  which are mixed into the hash separately. */
export function logEnvelopeSemantic(envelope: LogEnvelopeSemanticInput): Record<string, unknown> {
  return {
    envelopeId: envelope.envelopeId,
    actor: envelope.actor,
    ...(envelope.to !== undefined ? { to: envelope.to } : {}),
    payloadKind: envelope.payloadKind,
    payload: envelope.payload,
    ...(envelope.annotations !== undefined ? { annotations: envelope.annotations } : {}),
    ...(envelope.causality !== undefined ? { causality: envelope.causality } : {}),
    appendedAt: envelope.appendedAt,
  };
}

/** Hash preimage format version. v2 length-prefixes the variable-width
 *  fields so distinct (logId, head, seq) tuples can never produce the same
 *  preimage (v1 concatenated them raw, which was ambiguous at the
 *  logId/head and head/seq boundaries). Bump on any preimage change. */
export const LOG_ENVELOPE_HASH_FORMAT = 2;

export interface LogEnvelopeHashInput {
  prevHash: string;
  logId: string;
  head: string;
  seq: number;
  semantic: Record<string, unknown>;
}

/** The ONE preimage construction for envelope hashes. Both the async
 *  protocol path (computeLogEnvelopeHash) and the semantic control plane's sync path
 *  hash exactly this string — never assemble the preimage anywhere else.
 *  Length prefixes (UTF-16 code units, matching String.length in both
 *  implementations) make every field boundary unambiguous; the semantic
 *  JSON is last and needs no terminator. */
export function logEnvelopeHashPreimage(input: LogEnvelopeHashInput): string {
  return [
    `gadlog:${LOG_ENVELOPE_HASH_FORMAT}`,
    input.prevHash,
    `${input.logId.length}:${input.logId}`,
    `${input.head.length}:${input.head}`,
    String(input.seq),
    canonicalJson(input.semantic),
  ].join("\n");
}

export async function computeLogEnvelopeHash(input: LogEnvelopeHashInput): Promise<string> {
  return sha256HexSyncText(logEnvelopeHashPreimage(input));
}

export async function verifyLogEnvelopeHash(envelope: LogEnvelope): Promise<boolean> {
  const expected = await computeLogEnvelopeHash({
    prevHash: envelope.prevHash,
    logId: envelope.logId,
    head: envelope.head,
    seq: envelope.seq,
    semantic: logEnvelopeSemantic(envelope),
  });
  return expected === envelope.hash;
}

export interface LogIntegrityOptions {
  /** prevHash expected for the first (lowest-seq) envelope of a (logId, head)
   *  group — GENESIS for root logs, the parent fork hash for forked logs.
   *  Key format: `${logId} ${head}`. Missing key ⇒ accept any start. */
  startPrevHashByLog?: Record<string, string>;
}

export async function checkLogIntegrity(
  envelopes: LogEnvelope[],
  options?: LogIntegrityOptions
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  const byLog = new Map<string, LogEnvelope[]>();
  for (const envelope of envelopes) {
    const key = `${envelope.logId} ${envelope.head}`;
    const group = byLog.get(key) ?? [];
    group.push(envelope);
    byLog.set(key, group);
  }

  for (const [logKey, group] of byLog) {
    const ordered = [...group].sort((a, b) => a.seq - b.seq);
    const expectedStart = options?.startPrevHashByLog?.[logKey];
    for (let index = 0; index < ordered.length; index += 1) {
      const envelope = ordered[index];
      if (!envelope) continue;
      if (index === 0) {
        if (expectedStart !== undefined && envelope.prevHash !== expectedStart) {
          errors.push(`log ${logKey} seq ${envelope.seq} prevHash does not match expected start`);
        }
      } else {
        const previous = ordered[index - 1];
        if (previous) {
          if (envelope.seq !== previous.seq + 1) {
            errors.push(`log ${logKey} seq gap between ${previous.seq} and ${envelope.seq}`);
          }
          if (envelope.prevHash !== previous.hash) {
            errors.push(`log ${logKey} seq ${envelope.seq} prevHash does not match seq ${previous.seq}`);
          }
        }
      }
      if (!(await verifyLogEnvelopeHash(envelope))) {
        errors.push(`log ${logKey} seq ${envelope.seq} hash mismatch`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

const logEventCausalitySchema = causalitySchema
  .extend({
    originLogId: z.string().optional(),
    originHead: z.string().optional(),
    originEnvelopeId: z.string().optional(),
    turnId: z.string().optional(),
  })
  .strict();

export const logEnvelopeSchema = z
  .object({
    logId: z.string().min(1),
    head: z.string().min(1),
    seq: z.number().int().nonnegative(),
    envelopeId: z.string().min(1),
    actor: actorRefSchema,
    to: z.union([z.array(participantRefSchema), participantSelectorSchema]).optional(),
    payloadKind: z.string().min(1),
    payload: z.unknown(),
    annotations: z.record(z.unknown()).optional(),
    causality: logEventCausalitySchema.optional(),
    appendedAt: z.string().datetime({ offset: true }),
    prevHash: z.string().min(1),
    hash: z.string().min(1),
  })
  .strict();
