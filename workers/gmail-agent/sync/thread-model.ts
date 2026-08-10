import type { GmailMessage, GmailThread } from "@workspace/gmail";
import type {
  GmailAttentionDecision,
  GmailAttentionHit,
  GmailDigestItem,
  GmailThreadCardState,
} from "@workspace/gmail/card-types";
import type { GmailThreadStateRow } from "../types.js";

/** The static/cheap signal snapshot triage decisions are made against. */
export interface GmailAttentionEvent {
  threadId: string;
  messageId?: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  labels: string[];
  category?: string;
  hasAttachment: boolean;
  priorReplyToSender?: boolean;
  unread: boolean;
  inInbox: boolean;
  addressedToUser: boolean;
  internalDate?: number;
}

export const METADATA_HEADERS = [
  "Subject",
  "From",
  "To",
  "Cc",
  "Date",
  "Message-ID",
  "References",
  "In-Reply-To",
];

export const GMAIL_SYSTEM_CATEGORIES: Record<string, string> = {
  CATEGORY_PERSONAL: "Primary",
  CATEGORY_PROMOTIONS: "Promotions",
  CATEGORY_SOCIAL: "Social",
  CATEGORY_UPDATES: "Updates",
  CATEGORY_FORUMS: "Forums",
};

export function header(message: GmailMessage, name: string): string | undefined {
  const lower = name.toLowerCase();
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

export function latestMessage(thread: GmailThread): GmailMessage | undefined {
  return thread.messages?.[thread.messages.length - 1];
}

/** Raw bytes from base64url — REQUIRED for binary payloads (attachments). */
export function decodeBase64UrlBytes(data: string): Uint8Array {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return typeof Buffer !== "undefined"
    ? new Uint8Array(Buffer.from(padded, "base64"))
    : Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

/** Text from base64url. Do NOT use for binary data — TextDecoder corrupts it. */
export function decodeBase64Url(data: string): string {
  return new TextDecoder().decode(decodeBase64UrlBytes(data));
}

export function textFromPart(part: NonNullable<GmailMessage["payload"]> | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const text = textFromPart(child);
    if (text) return text;
  }
  return "";
}

export function partHasAttachment(part: NonNullable<GmailMessage["payload"]> | undefined): boolean {
  if (!part) return false;
  if (part.filename || part.body?.attachmentId) return true;
  return (part.parts ?? []).some(partHasAttachment);
}

export function categoryFromLabels(labels: Set<string>): string | undefined {
  for (const [labelId, category] of Object.entries(GMAIL_SYSTEM_CATEGORIES)) {
    if (labels.has(labelId)) return category;
  }
  return undefined;
}

export function normalizeEmailAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = /<([^>]+)>/.exec(value)?.[1] ?? value;
  const match = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(candidate);
  return match?.[0].toLowerCase();
}

export function parseAddressList(value: string | string[] | undefined): string[] {
  const text = Array.isArray(value) ? value.join(",") : value ?? "";
  return Array.from(text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)).map((match) =>
    match[0]!.toLowerCase()
  );
}

export function maxInternalDate(thread: GmailThread): number {
  const newest = Math.max(
    ...(thread.messages ?? [])
      .map((m) => Number(m.internalDate ?? 0))
      .filter((value) => Number.isFinite(value) && value > 0)
  );
  return Number.isFinite(newest) && newest > 0 ? newest : Date.now();
}

export function isExcludedActionableCategory(labels: Set<string>): boolean {
  return (
    labels.has("CATEGORY_PROMOTIONS") ||
    labels.has("CATEGORY_SOCIAL") ||
    labels.has("CATEGORY_UPDATES") ||
    labels.has("CATEGORY_FORUMS")
  );
}

export function addressHeaderIncludes(
  message: GmailMessage | undefined,
  email: string | undefined
): boolean {
  if (!message || !email) return false;
  const normalizedEmail = email.toLowerCase();
  const recipients = [header(message, "To"), header(message, "Cc"), header(message, "Bcc")]
    .filter((value): value is string => Boolean(value))
    .join(",")
    .toLowerCase();
  return recipients.includes(normalizedEmail);
}

export function threadCardState(
  thread: GmailThread,
  category?: string | null,
  userEmail?: string,
  attention?: GmailAttentionDecision
): GmailThreadCardState {
  const message = latestMessage(thread) ?? thread.messages?.[0];
  const labels = new Set((thread.messages ?? []).flatMap((m) => m.labelIds ?? []));
  const latestLabels = new Set(message?.labelIds ?? []);
  const resolvedCategory = category ?? categoryFromLabels(labels);
  const unread = labels.has("UNREAD");
  const inInbox = labels.has("INBOX");
  const actionable =
    latestLabels.has("UNREAD") &&
    !isExcludedActionableCategory(labels) &&
    addressHeaderIncludes(message, userEmail);
  const updatedAt = maxInternalDate(thread);
  return {
    threadId: thread.id,
    subject: (message && header(message, "Subject")) || "(no subject)",
    from: (message && header(message, "From")) || "",
    snippet: message?.snippet ?? "",
    participants: Array.from(
      new Set(
        (thread.messages ?? [])
          .flatMap((m) => [header(m, "From"), header(m, "To")])
          .filter((value): value is string => Boolean(value))
      )
    ),
    lastSnippet: message?.snippet ?? "",
    unreadCount: unread ? 1 : 0,
    hasDraft: false,
    status: unread ? "unread" : inInbox ? "open" : "archived",
    unread,
    inInbox,
    actionable: actionable || Boolean(attention?.wake),
    ...(attention?.wake ? { attention } : {}),
    ...(resolvedCategory ? { category: resolvedCategory } : {}),
    updatedAt,
  };
}

export function attentionEventFromThread(
  thread: GmailThread,
  userEmail?: string
): GmailAttentionEvent | null {
  const message = latestMessage(thread) ?? thread.messages?.[0];
  if (!message) return null;
  const labels = Array.from(new Set((thread.messages ?? []).flatMap((m) => m.labelIds ?? [])));
  const labelSet = new Set(labels);
  return {
    threadId: thread.id,
    messageId: message.id,
    from: header(message, "From") ?? "",
    to: [header(message, "To"), header(message, "Cc"), header(message, "Bcc")]
      .filter((value): value is string => Boolean(value))
      .join(", "),
    subject: header(message, "Subject") ?? "",
    snippet: message.snippet ?? "",
    labels,
    ...(categoryFromLabels(labelSet) ? { category: categoryFromLabels(labelSet) } : {}),
    hasAttachment: (thread.messages ?? []).some((item) => partHasAttachment(item.payload)),
    unread: labelSet.has("UNREAD"),
    inInbox: labelSet.has("INBOX"),
    addressedToUser: addressHeaderIncludes(message, userEmail),
    internalDate: Number(message.internalDate ?? 0) || undefined,
  };
}

export function threadCardFromRow(
  row: GmailThreadStateRow,
  hit?: GmailAttentionHit | null
): GmailThreadCardState {
  return {
    threadId: row.thread_id,
    subject: row.subject,
    from: row.from_addr,
    snippet: row.snippet,
    participants: row.from_addr ? [row.from_addr] : [],
    lastSnippet: row.snippet,
    unreadCount: row.unread === 1 ? 1 : 0,
    hasDraft: false,
    status: row.unread === 1 ? "unread" : row.in_inbox === 1 ? "open" : "archived",
    unread: row.unread === 1,
    inInbox: row.in_inbox === 1,
    actionable: row.actionable === 1,
    ...(hit
      ? {
          attention: {
            wake: true,
            directiveId: hit.directiveId,
            directiveName: hit.directiveName,
            reason: hit.reason,
            actions: hit.actions,
          },
        }
      : {}),
    ...(row.category ? { category: row.category } : {}),
    updatedAt: row.updated_at,
  };
}

/** Compact row shape used by the digest and search-result cards. */
export function digestItemFromCard(card: GmailThreadCardState): GmailDigestItem {
  return {
    threadId: card.threadId,
    from: card.from,
    subject: card.subject,
    ...(card.lastSnippet || card.snippet ? { gist: (card.lastSnippet || card.snippet).slice(0, 140) } : {}),
    ...(card.unreadCount > 0 ? { unread: true } : {}),
  };
}

export function searchResultCardState(message: GmailMessage): GmailThreadCardState {
  const labels = new Set(message.labelIds ?? []);
  const unread = labels.has("UNREAD");
  const inInbox = labels.has("INBOX");
  const category = categoryFromLabels(labels);
  return {
    threadId: message.threadId,
    subject: header(message, "Subject") ?? "(no subject)",
    from: header(message, "From") ?? "",
    snippet: message.snippet ?? "",
    participants: [header(message, "From") ?? ""].filter(Boolean),
    lastSnippet: message.snippet ?? "",
    unreadCount: unread ? 1 : 0,
    hasDraft: false,
    status: unread ? "unread" : inInbox ? "open" : "archived",
    unread,
    inInbox,
    actionable: false,
    updatedAt: Number(message.internalDate ?? Date.now()),
    ...(category ? { category } : {}),
  };
}
