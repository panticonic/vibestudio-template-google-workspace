/**
 * Observe one envelope — and the replies threaded under it — in a channel this
 * panel is not otherwise connected to (messaging plan §4.10.3).
 *
 * The read side of the dispatch card: expanding a card mounts the target
 * channel's envelope through the same observer connection `SubagentRunCard`
 * uses for a child transcript. It observes; it never copies (D15) — the
 * utterance stays in the other channel's log, this hook just looks at it.
 */
import { useMemo } from "react";
import type { ChatMessage } from "../types";
import {
  useChildTranscript,
  type ChildTranscriptConnection,
  type ChildTranscriptResult,
} from "./useChildTranscript";

export interface ForeignEnvelopeResult extends ChildTranscriptResult {
  /** The envelope itself, once observed. */
  envelope: ChatMessage | null;
  /** Ordinary messages replying to it, in transcript order. */
  replies: ChatMessage[];
  /** What is known so far, from the envelope's own receipts (§4.10.3 status line). */
  status: "queued" | "delivered" | "read" | "replied";
}

export function useForeignEnvelope(options: {
  connection: ChildTranscriptConnection | null;
  channelId: string | null;
  envelopeId: string | null;
  enabled: boolean;
}): ForeignEnvelopeResult {
  const { connection, channelId, envelopeId, enabled } = options;
  const transcript = useChildTranscript({
    connection,
    channelId,
    // A foreign channel's context is its own; the channel resolves it.
    contextId: null,
    enabled: enabled && Boolean(envelopeId),
  });
  return useMemo(() => {
    const envelope = envelopeId
      ? (transcript.messages.find((message) => message.id === envelopeId) ?? null)
      : null;
    const replies = envelopeId
      ? transcript.messages.filter(
          (message) => message.replyTo === envelopeId && message.kind !== "system"
        )
      : [];
    const status: ForeignEnvelopeResult["status"] =
      replies.length > 0
        ? "replied"
        : envelope?.receipts?.aggregate === "read"
          ? "read"
          : envelope
            ? "delivered"
            : "queued";
    // Only the envelope and its thread render in the card; the rest of the
    // foreign transcript is not this conversation's business.
    const messages = envelope ? [envelope, ...replies] : [];
    return { ...transcript, messages, envelope, replies, status };
  }, [transcript, envelopeId]);
}
