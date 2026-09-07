/**
 * useChannelSignalMessages — React subscription to a channel's signal
 * message stream, filtered by contentType.
 *
 * Used for channel signal events (notifications, ext-status, ext-widget,
 * ext-working). The returned messages are an array with
 * `{ ts, content, contentType }` shape compatible with `parseSignalEvent`.
 *
 * Uses `client.events({ includeSignals: true })`, which fans out to multiple
 * subscribers without sharing iterator state.
 */

import { useState, useEffect } from "react";
import type { PubSubClient, ParticipantMetadata } from "@workspace/pubsub";

export interface SignalWireMessage {
  ts: number;
  content: string;
  contentType?: string;
}

/**
 * Subscribe to a PubSubClient's event stream and collect every signal
 * event whose `contentType` matches `expectedContentType`.
 * Returns a growing array as new messages arrive.
 *
 * The hook keeps the last 200 matching messages to avoid unbounded growth.
 */
export function useChannelSignalMessages<T extends ParticipantMetadata = ParticipantMetadata>(
  client: PubSubClient<T> | null,
  expectedContentType: string,
): ReadonlyArray<SignalWireMessage> {
  const [messages, setMessages] = useState<SignalWireMessage[]>([]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const consume = async () => {
      try {
        // Use events() with includeSignals so we get signals via the
        // fanout (supports multiple concurrent subscribers).
        for await (const event of client.events({ includeSignals: true })) {
          if (cancelled) break;
          const wire = event as unknown as {
            delivery?: "log" | "signal";
            type?: string;
            payload?: { content?: string; contentType?: string };
            ts?: number;
            contentType?: string;
            content?: string;
          };
          if (wire.delivery !== "signal") continue;
          // Signal events may arrive as normalized top-level fields or as the
          // raw protocol payload.
          const content =
            wire.content ?? wire.payload?.content ?? "";
          const contentType =
            wire.contentType ?? wire.payload?.contentType;
          if (contentType !== expectedContentType) continue;
          if (!content) continue;
          const ts = wire.ts ?? Date.now();
          setMessages((prev) => {
            const next = [...prev, { ts, content, contentType }];
            // Cap at 200 to avoid unbounded growth.
            if (next.length > 200) next.shift();
            return next;
          });
        }
      } catch (err) {
        if (!cancelled) console.error("[useChannelSignalMessages]", err);
      }
    };
    void consume();
    return () => {
      cancelled = true;
    };
  }, [client, expectedContentType]);

  return messages;
}
