import { sha256HexSyncText } from "@vibestudio/content-addressing";
import { createGmailClient, isGmailApiError, type GmailMessage } from "@workspace/gmail";
import type { CredentialClient } from "@workspace/runtime/credentials";
import type { ProviderRecord, ReadResult } from "./program/types.js";

export type Mail = Omit<ProviderRecord, "digest" | "sent">;
export type ProviderWorld = {
  drafts: readonly Mail[];
  sent?: readonly Mail[];
  pageSize?: number;
  changeAfterRead?: { id: string; next: Mail | null };
  faults?: Readonly<Record<string, number>>;
};
export type ProviderRequest = { kind: "draft" | "find" | "sent"; id: string; cursor: string | null; status: number };
const root = "/gmail/v1/users/me";

function messageFrom(record: Mail, sent: boolean): GmailMessage {
  return {
    id: record.messageId, threadId: record.threadId, snippet: record.preview,
    labelIds: sent ? ["SENT"] : ["DRAFT"], payload: { headers: [
      { name: "Message-ID", value: record.mimeId },
      { name: "Subject", value: record.subject },
      { name: "From", value: record.sender },
      { name: "To", value: record.recipient },
    ] },
  };
}

export function providerRecord(id: string, message: GmailMessage): ProviderRecord {
  const header = (name: string) => message.payload?.headers?.find(({ name: attr }) =>
    attr.toLowerCase() === name)?.value ?? "";
  const record = {
    id, messageId: message.id, threadId: message.threadId,
    mimeId: header("message-id"), subject: header("subject"), sender: header("from"),
    recipient: header("to"), preview: message.snippet ?? "", sent: Boolean(message.labelIds?.includes("SENT")),
  };
  return { ...record, digest: sha256HexSyncText(JSON.stringify(record)) };
}

export function ownedGmailProvider(world: ProviderWorld) {
  const drafts = new Map(world.drafts.map((record) => [record.id, structuredClone(record)]));
  const sent = new Map((world.sent ?? []).map((record) => [record.messageId, structuredClone(record)]));
  const requests: ProviderRequest[] = [];
  let credentialReads = 0;
  let blockedProviderCalls = 0;
  let providerRevisionChanged = false;
  const seenMail = new Set<string>();
  const credentials = {
    async forAudience({ credentialId }: { credentialId?: string }) {
      if (credentialId !== "gmail-owned-fixture") throw new Error("Use the isolated Gmail fixture account");
      credentialReads++;
      return {
        credentialId,
        async fetch(input: string | URL, init?: RequestInit) {
          const url = new URL(input);
          if (url.origin !== "https://gmail.googleapis.com" || (init?.method ?? "GET") !== "GET" ||
              init?.body || new Headers(init?.headers).get("accept") !== "application/json") {
            blockedProviderCalls++;
            throw new Error("The owned Gmail transport accepts metadata reads only");
          }
          function respond(kind: ProviderRequest["kind"], id: string, cursor: string | null, value: object | null) {
            const key = `${kind}:${id}${cursor === null ? "" : ":" + cursor}`;
            const status = world.faults?.[key] ?? (value ? 200 : 404);
            requests.push({ kind, id, cursor, status });
            return Response.json(status === 200 ? value : { error: { message: "Provider observation unavailable" } }, { status });
          }
          if (url.pathname === root + "/drafts") {
            const mimeId = url.searchParams.get("q")?.match(/^rfc822msgid:(<[^<>]+>)$/u)?.[1];
            const cursor = url.searchParams.get("pageToken");
            const offset = cursor === null ? 0 : Number(cursor.match(/^page-(\d+)$/u)?.[1]);
            if (!mimeId || !seenMail.has(mimeId) || !Number.isSafeInteger(offset))
              throw new Error("Read the exact authorized draft identity and returned page token");
            const matching = [...drafts.values()].filter((row) => row.mimeId === mimeId);
            const size = world.pageSize ?? 2;
            const values = matching.slice(offset, offset + size).map((row) => ({
              id: row.id, message: { id: row.messageId, threadId: row.threadId },
            }));
            return respond("find", mimeId, cursor, {
              drafts: values,
              ...(offset + size < matching.length ? { nextPageToken: "page-" + (offset + size) } : {}),
            });
          }
          if (url.pathname.startsWith(root + "/drafts/")) {
            const id = decodeURIComponent(url.pathname.slice(root.length + "/drafts/".length));
            const record = drafts.get(id);
            const result = respond("draft", id, null, record ? { id, message: messageFrom(record, false) } : null);
            const change = world.changeAfterRead;
            if (result.ok && change?.id === id && !providerRevisionChanged) {
              if (change.next) drafts.set(id, structuredClone(change.next));
              else drafts.delete(id);
              providerRevisionChanged = true;
            }
            return result;
          }
          if (url.pathname.startsWith(root + "/messages/")) {
            const id = decodeURIComponent(url.pathname.slice(root.length + "/messages/".length));
            const record = sent.get(id);
            return respond("sent", id, null, record ? messageFrom(record, true) : null);
          }
          blockedProviderCalls++;
          throw new Error("Only the owned draft or retained Sent receipt may be inspected");
        },
      };
    },
  } as unknown as CredentialClient;
  const gmail = createGmailClient(credentials, { credentialId: "gmail-owned-fixture" });

  async function readRecord(id: string, read: () => Promise<GmailMessage | null>): Promise<ReadResult> {
    try {
      const message = await read();
      return message ? { status: "found", record: providerRecord(id, message) } : { status: "missing", record: null };
    } catch (error) {
      if (isGmailApiError(error, "not-found")) return { status: "missing", record: null };
      if (isGmailApiError(error) && ["server", "forbidden", "network", "auth-expired", "rate-limited"].includes(error.code))
        return { status: "unavailable", record: null };
      throw error;
    }
  }
  return {
    async getDraft(id: string) {
      return readRecord(id, async () => {
        const draft = await gmail.getDraft(id);
        if (draft.id !== id) throw new Error("Provider returned a different draft identity");
        return draft.message;
      });
    },
    async findDrafts(mimeId: string, cursor: string | null) {
      seenMail.add(mimeId);
      return gmail.listDrafts({ q: `rfc822msgid:${mimeId}`, ...(cursor === null ? {} : { pageToken: cursor }), maxResults: 2 });
    },
    async readSent(id: string) {
      return readRecord(id, async () => {
        const message = await gmail.getMessage(id);
        if (message.id !== id) throw new Error("Provider returned a different message identity");
        return message;
      });
    },
    requests,
    readback() {
      return {
        drafts: [...drafts.values()].map((row) => providerRecord(row.id, messageFrom(row, false))),
        sent: [...sent.values()].map((row) => providerRecord(row.messageId, messageFrom(row, true))),
        credentialReads, blockedProviderCalls, providerRevisionChanged,
      };
    },
  };
}
