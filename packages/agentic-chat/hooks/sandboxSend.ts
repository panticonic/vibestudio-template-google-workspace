import type { MessageTier } from "@workspace/agentic-protocol";

export interface SandboxSendOptions {
  idempotencyKey?: string;
  tier?: MessageTier;
  mentions?: string[];
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

export function normalizeSandboxSendOptions(
  options: SandboxSendOptions | undefined,
  fallbackIdempotencyKey: string
): {
  idempotencyKey: string;
  tier: MessageTier;
  mentions?: string[];
  replyTo?: string;
  metadata?: Record<string, unknown>;
} {
  return {
    idempotencyKey: options?.idempotencyKey ?? fallbackIdempotencyKey,
    tier: options?.tier ?? "secondary",
    ...(options?.mentions?.length ? { mentions: options.mentions } : {}),
    ...(options?.replyTo ? { replyTo: options.replyTo } : {}),
    ...(options?.metadata ? { metadata: options.metadata } : {}),
  };
}

/**
 * Publish text from a rendered sandbox surface through the chat core's
 * send-and-backfill path. Channel transports do not echo a publisher's own
 * event, so calling the raw client directly leaves the sender transcript stale
 * until a full replay (for example, after reloading the panel).
 */
export function sendSandboxText(
  publishText: (
    content: string,
    options: ReturnType<typeof normalizeSandboxSendOptions>
  ) => Promise<void>,
  content: string,
  options: SandboxSendOptions | undefined,
  fallbackIdempotencyKey: string
): Promise<void> {
  return publishText(content, normalizeSandboxSendOptions(options, fallbackIdempotencyKey));
}
