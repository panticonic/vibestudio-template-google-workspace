import { useEffect, useState } from "react";
import type { ParticipantMetadata, PubSubClient } from "@workspace/pubsub";

export interface ChannelSignal {
  id: string;
  ts: number;
  content: string;
  contentType?: string;
}

export interface UseChannelSignalsOptions {
  maxSignals?: number;
  ttlMs?: number;
}

interface StoredChannelSignal extends ChannelSignal {
  expiresAt: number;
}

function normalizeSignalContent(contentType: string | undefined, content: string): string | null {
  if (contentType === "inline_ui") return null;
  if (contentType === "fork.head_changed") return null;
  // Agentic transcript events (streaming deltas) ride the signal channel but
  // belong to the transcript reducer; thinking pills arrive separately as
  // `vibestudio-ext-working` signals from the agent vessel.
  if (contentType === "agentic.trajectory.v1/event") return null;
  if (contentType !== "vibestudio-ext-working") return content;
  try {
    const parsed = JSON.parse(content) as { message?: unknown };
    if (parsed.message == null || parsed.message === "") return null;
    return typeof parsed.message === "string" ? parsed.message : JSON.stringify(parsed.message);
  } catch {
    return content.trim() || null;
  }
}

function logSuppressedSignal(event: {
  contentType?: string;
  content?: string;
  senderId?: string;
  ts?: number;
}): void {
  console.debug("[useChannelSignals] suppressed transient signal", {
    contentType: event.contentType,
    senderId: event.senderId,
    ts: event.ts,
    content: event.content,
  });
}

/**
 * Subscribe to live, non-durable channel signals and keep a small expiring
 * window for transient UI affordances.
 */
export function useChannelSignals<T extends ParticipantMetadata = ParticipantMetadata>(
  client: PubSubClient<T> | null,
  options: UseChannelSignalsOptions = {},
): ReadonlyArray<ChannelSignal> {
  const maxSignals = options.maxSignals ?? 5;
  const ttlMs = options.ttlMs ?? 8000;
  const [signals, setSignals] = useState<StoredChannelSignal[]>([]);

  useEffect(() => {
    if (!client) {
      setSignals([]);
      return;
    }

    let cancelled = false;
    let sequence = 0;

    const consume = async () => {
      try {
        for await (const event of client.events({ includeSignals: true })) {
          if (cancelled) break;
          if (event.delivery !== "signal" || event.type !== "signal") continue;
          if (!event.content) continue;
          const content = normalizeSignalContent(event.contentType, event.content);
          if (content == null) {
            logSuppressedSignal(event);
            continue;
          }

          const ts = event.ts ?? Date.now();
          const nextSignal: StoredChannelSignal = {
            id: `${ts}:${sequence++}`,
            ts,
            content,
            contentType: event.contentType,
            expiresAt: Date.now() + ttlMs,
          };

          setSignals((prev) => {
            const now = Date.now();
            const next = [...prev.filter((item) => item.expiresAt > now), nextSignal];
            return next.slice(Math.max(0, next.length - maxSignals));
          });
        }
      } catch (err) {
        if (!cancelled) console.error("[useChannelSignals]", err);
      }
    };

    void consume();
    return () => {
      cancelled = true;
    };
  }, [client, maxSignals, ttlMs]);

  useEffect(() => {
    if (signals.length === 0) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      setSignals((prev) => prev.filter((item) => item.expiresAt > now));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [signals.length]);

  return signals.map(({ expiresAt: _expiresAt, ...signal }) => signal);
}
