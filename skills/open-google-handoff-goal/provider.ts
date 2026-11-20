import { Buffer } from "node:buffer";
import { createGmailClient, type GmailMessagePart, type GmailThread } from "@workspace/gmail";
import { createDriveClient, type DriveFile, type DrivePermission } from "@workspace/google-workspace/drive";
import type { CredentialClient } from "@workspace/runtime/credentials";
import type { MailThread } from "./program/types.js";

export type Mail = { id: string; from: string; subject: string; receivedAt: string; body: string; multipart?: boolean };
export type Thread = { id: string; messages: readonly Mail[]; next?: readonly Mail[] | number; status?: number };
type PermissionPage = readonly DrivePermission[] | number;
export type FileState = { metadata: DriveFile; bytes?: string | number; permissions?: readonly PermissionPage[] };
export type File = { id: string; initial: FileState | number; next?: FileState | number };
export type ProviderWorld = {
  pages: readonly (readonly string[] | number)[];
  nextPages?: readonly (readonly string[] | number)[];
  threads: readonly Thread[];
  files: readonly File[];
};
export type ProviderRequest = {
  op: "mail-list" | "mail-thread" | "drive-file" | "drive-media" | "drive-export" | "drive-permissions";
  id: string | null; cursor: string | null; status: number;
};
export const nativeDoc = "application/vnd.google-apps.document";
export const driveShortcut = "application/vnd.google-apps.shortcut";
export const mailboxScope = "label:vibestudio-handoff";
export const handoffPermissionFields = "nextPageToken,permissions(id,type,role,emailAddress,domain,deleted,pendingOwner,permissionDetails(inherited,role))";
const gmailBase = "https://gmail.googleapis.com";
const driveBase = "https://www.googleapis.com";
const mailboxPath = "/gmail/v1/users/me/threads";
const drivePath = "/drive/v3/files";

function links(body: string): string[] {
  const ids = new Set<string>();
  const candidates = body.matchAll(/https:\/\/(?:drive|docs)\.google\.com\/[^\s<>"')]+/gu);
  for (const [candidate] of candidates) {
    const url = new URL(candidate.replace(/[.,;:!?]+$/u, ""));
    let id: string | null | undefined;
    if (url.origin === "https://drive.google.com" && url.pathname === "/open") id = url.searchParams.get("id");
    if (url.origin === "https://drive.google.com" && url.pathname.startsWith("/file/d/")) id = url.pathname.split("/")[3];
    if (url.origin === "https://docs.google.com") id = url.pathname.match(/^\/document\/d\/([^/]+)(?:\/|$)/u)?.[1];
    if (id && /^[A-Za-z0-9_-]+$/u.test(id)) ids.add(id);
  }
  return [...ids];
}

function plainParts(part: GmailMessagePart | undefined): string[] {
  if (!part) return [];
  if (part.mimeType === "text/plain" && part.body?.data) return [Buffer.from(part.body.data, "base64url").toString("utf8")];
  return (part.parts ?? []).flatMap(plainParts);
}

export function projectMail(thread: GmailThread): MailThread {
  return {
    id: thread.id,
    messages: (thread.messages ?? []).map((item) => {
      if (item.threadId !== thread.id) throw new Error("Gmail returned a message outside its requested thread");
      const header = (name: string) => item.payload?.headers?.find((row) => row.name.toLowerCase() === name)?.value ?? "";
      const body = plainParts(item.payload).join("\n").slice(0, 8192);
      return { id: item.id, from: header("from"), subject: header("subject"),
        receivedAt: new Date(Number(item.internalDate)).toISOString(), body, fileIds: links(body) };
    }).toSorted((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id)),
  };
}

function wireMail(thread: Thread, messages: readonly Mail[]): GmailThread {
  return { id: thread.id, messages: messages.map(({ id, from, subject, body, receivedAt, multipart }) => {
    const bytes = Buffer.from(body, "utf8");
    const plain = { mimeType: "text/plain", body: { size: bytes.length, data: bytes.toString("base64url") } };
    const headers = [{ name: "From", value: from }, { name: "Subject", value: subject }];
    return {
      id, threadId: thread.id, internalDate: String(Date.parse(receivedAt)), labelIds: ["vibestudio-handoff"],
      payload: multipart ? { mimeType: "multipart/alternative", headers, parts: [plain] } : { ...plain, headers },
    };
  }) };
}

export function ownedGoogleHandoffProvider(world: ProviderWorld) {
  const requests: ProviderRequest[] = [];
  const threadReads = new Map<string, number>();
  const fileReads = new Map<string, number>();
  const credentialIds: string[] = [];
  let mailLists = 0;
  let denied = 0;
  function deny(message: string): never {
    denied++;
    throw new Error(message);
  }
  const credentials = {
    async forAudience({ credentialId }: { credentialId?: string }) {
      if (credentialId !== "handoff-mail-fixture" && credentialId !== "handoff-drive-fixture")
        return deny("Use an owned provider account for the handoff");
      const origin = credentialId === "handoff-mail-fixture" ? gmailBase : driveBase;
      credentialIds.push(credentialId);
      return {
        credentialId,
        async fetch(input: string | URL, init?: RequestInit) {
          const url = new URL(input);
          if (url.origin !== origin || (init?.method ?? "GET") !== "GET" || init?.body || requests.length >= 128)
            return deny("The handoff fixture accepts only bounded provider reads");
          const cursor = url.searchParams.get("pageToken");
          const index = cursor === null ? 0 : Number(cursor.match(/^p([1-9][0-9]*)$/u)?.[1]);
          if (!Number.isSafeInteger(index)) return deny("Use only returned provider pages");
          function reply(op: ProviderRequest["op"], id: string | null, value: object | string | number, type?: string) {
            const status = typeof value === "number" ? value : 200;
            requests.push({ op, id, cursor, status });
            if (typeof value === "string") return new Response(value, { headers: { "Content-Type": type ?? "text/plain" } });
            return Response.json(typeof value === "number" ? { error: { message: "Owned provider resource unavailable" } } : value, { status });
          }
          if (origin === gmailBase && url.pathname === mailboxPath) {
            if (url.searchParams.get("q") !== mailboxScope) return deny("Search only the owned mail scope");
            if (!cursor) mailLists++;
            const pages = mailLists > 1 ? world.nextPages ?? world.pages : world.pages;
            const page = pages[index];
            if (page === undefined) return deny("Mail page is outside the owned scope");
            return reply("mail-list", null, typeof page === "number" ? page : {
              threads: page.map((id) => ({ id })), ...(index + 1 < pages.length ? { nextPageToken: "p" + (index + 1) } : {}),
            });
          }
          if (origin === gmailBase && url.pathname.startsWith(mailboxPath + "/")) {
            const id = decodeURIComponent(url.pathname.slice(mailboxPath.length + 1));
            const thread = world.threads.find((item) => item.id === id);
            if (!thread || url.searchParams.get("format") !== "full") return deny("Read only an owned complete mail thread");
            const count = (threadReads.get(id) ?? 0) + 1;
            threadReads.set(id, count);
            const frame = count > 1 ? thread.next ?? thread.status ?? thread.messages : thread.status ?? thread.messages;
            return reply("mail-thread", id, typeof frame === "number" ? frame : wireMail(thread, frame));
          }
          if (origin === driveBase && url.pathname.startsWith(drivePath + "/")) {
            const [encoded, route, ...extra] = url.pathname.slice(drivePath.length + 1).split("/");
            const id = decodeURIComponent(encoded ?? "");
            const file = world.files.find((item) => item.id === id);
            if (!file || extra.length) return deny("Read only an owned Drive asset");
            const metadata = route === undefined && url.searchParams.get("alt") !== "media";
            if (metadata) fileReads.set(id, (fileReads.get(id) ?? 0) + 1);
            const frame = (fileReads.get(id) ?? 0) > 1 ? file.next ?? file.initial : file.initial;
            if (metadata) return reply("drive-file", id, typeof frame === "number" ? frame : frame.metadata);
            if (typeof frame === "number") return deny("Read Drive evidence only after current metadata");
            if (route === "permissions") {
              if (url.searchParams.get("fields") !== handoffPermissionFields)
                return deny("Request complete Drive audience evidence");
              const permissions = frame.permissions ?? [[]];
              const page = permissions[index];
              if (page === undefined) return deny("Drive permissions page lies outside the owned scope");
              return reply("drive-permissions", id, typeof page === "number" ? page : {
                permissions: page, ...(index + 1 < permissions.length ? { nextPageToken: "p" + (index + 1) } : {}),
              });
            }
            if (route === "export" && frame.metadata.mimeType === nativeDoc && url.searchParams.get("mimeType") === "text/plain")
              return reply("drive-export", id, frame.bytes ?? 404, "text/plain");
            if (route === undefined && url.searchParams.get("alt") === "media" && frame.metadata.mimeType !== nativeDoc)
              return reply("drive-media", id, frame.bytes ?? 404, frame.metadata.mimeType);
          }
          return deny("The provider route lies outside the owned handoff scope");
        },
      };
    },
  };
  return {
    gmail: createGmailClient(credentials as unknown as CredentialClient, { credentialId: "handoff-mail-fixture" }),
    drive: createDriveClient(credentials, { credentialId: "handoff-drive-fixture" }),
    trace: () => structuredClone({ requests, credentialIds, denied }),
  };
}
