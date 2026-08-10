export const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const INITIAL_THREAD_LOAD_LIMIT = 12;

export type GmailSyncState = "ok" | "auth-needed";

export interface GmailChannelState {
  channelId: string;
  historyId?: string;
  emailAddress?: string;
  credentialId?: string;
  pollIntervalMs: number;
  lastSyncAt?: number;
  lastError?: string;
  setupStatus: "needs-user-preferences" | "configured";
  setupPromptedAt?: number;
  configuredAt?: number;
  setupSummary?: string;
  syncState: GmailSyncState;
  rateLimitedUntil?: number;
  backoffMs?: number;
  lastSetupJson?: string;
  peopleApiStatus?: "ok" | "unavailable";
  /** Epoch ms until which the Gmail users.watch push registration is live. */
  watchExpiration?: number;
}

export interface GmailThreadStateRow {
  channel_id: string;
  thread_id: string;
  subject: string;
  from_addr: string;
  snippet: string;
  unread: number;
  in_inbox: number;
  actionable: number;
  category: string | null;
  updated_at: number;
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

export function gmailAgentObjectKey(channelId: string): string {
  return `gmail-${channelId}`;
}
