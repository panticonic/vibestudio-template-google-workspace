import { describe, expect, it, vi } from "vitest";
import type { CredentialClient, UrlCredentialHandle } from "@workspace/runtime/credentials";

import { GmailApiError, createGmailClient } from "./gmail-client.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText,
    headers: { "Content-Type": "application/json" },
  });
}

function createClient(routes: Record<string, unknown | ((url: URL, init?: RequestInit) => unknown)>) {
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/batch/gmail/v1") {
      // Resolve each inner GET against the same route table and assemble a
      // multipart response (response boundary intentionally differs).
      const body = String(init?.body);
      const inner = [...body.matchAll(/Content-ID: <([^>]+)>\r\n\r\n(GET|POST) (\S+) HTTP\/1\.1/g)];
      const parts = inner.map(([, id, method, path]) => {
        const innerUrl = new URL(`https://gmail.googleapis.com${path}`);
        const key = `${method} ${innerUrl.pathname}${innerUrl.search}`;
        const route = routes[key];
        const status = route === undefined ? 404 : 200;
        const payload =
          route === undefined
            ? { error: `No route for ${key}` }
            : typeof route === "function"
              ? route(innerUrl, init)
              : route;
        return [
          "--resp_boundary",
          "Content-Type: application/http",
          `Content-ID: <response-${id}>`,
          "",
          `HTTP/1.1 ${status} ${status === 200 ? "OK" : "Not Found"}`,
          "Content-Type: application/json; charset=UTF-8",
          "",
          JSON.stringify(payload),
        ].join("\r\n");
      });
      return new Response(parts.join("\r\n") + "\r\n--resp_boundary--\r\n", {
        status: 200,
        headers: { "Content-Type": "multipart/mixed; boundary=resp_boundary" },
      });
    }
    const key = `${init?.method ?? "GET"} ${parsed.pathname}${parsed.search}`;
    const route = routes[key];
    if (route === undefined) {
      return jsonResponse({ error: `No route for ${key}` }, { status: 404, statusText: "Not Found" });
    }
    const body = typeof route === "function" ? route(parsed, init) : route;
    return jsonResponse(body);
  });
  const handle: UrlCredentialHandle = { credentialId: "cred-1", fetch };
  const credentials = {
    forAudience: vi.fn(async () => handle),
  } as unknown as CredentialClient;
  return { client: createGmailClient(credentials), fetch, credentials };
}

describe("Gmail client", () => {
  it("lists messages and fetches message details via one batch call", async () => {
    const { client, fetch } = createClient({
      "GET /gmail/v1/users/me/messages?maxResults=2": {
        messages: [{ id: "m1", threadId: "t1" }],
        resultSizeEstimate: 1,
      },
      "GET /gmail/v1/users/me/messages/m1?format=metadata&metadataHeaders=Subject": {
        id: "m1",
        threadId: "t1",
        payload: { headers: [{ name: "Subject", value: "Hello" }] },
      },
    });

    await expect(client.listMessages({
      maxResults: 2,
      format: "metadata",
      metadataHeaders: ["Subject"],
    })).resolves.toEqual({
      messages: [{
        id: "m1",
        threadId: "t1",
        payload: { headers: [{ name: "Subject", value: "Hello" }] },
      }],
      nextPageToken: undefined,
      resultSizeEstimate: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("paginates history and preserves all four history mutation types", async () => {
    const { client, fetch } = createClient({
      "GET /gmail/v1/users/me/history?startHistoryId=h0&historyTypes=messageAdded&historyTypes=messageDeleted&historyTypes=labelAdded&historyTypes=labelRemoved": {
        historyId: "h1",
        nextPageToken: "p2",
        history: [{ id: "1", messagesAdded: [{ message: { id: "m1", threadId: "t1" } }] }],
      },
      "GET /gmail/v1/users/me/history?startHistoryId=h0&historyTypes=messageAdded&historyTypes=messageDeleted&historyTypes=labelAdded&historyTypes=labelRemoved&pageToken=p2": {
        historyId: "h2",
        history: [{
          id: "2",
          labelsRemoved: [{ message: { id: "m1", threadId: "t1" }, labelIds: ["UNREAD"] }],
        }],
      },
    });

    await expect(client.syncSince("h0")).resolves.toEqual({
      historyId: "h2",
      rawHistory: {
        historyId: "h2",
        history: [
          { id: "1", messagesAdded: [{ message: { id: "m1", threadId: "t1" } }] },
          { id: "2", labelsRemoved: [{ message: { id: "m1", threadId: "t1" }, labelIds: ["UNREAD"] }] },
        ],
      },
      threads: [{
        threadId: "t1",
        messagesAdded: [{ id: "m1", threadId: "t1" }],
        messagesDeleted: [],
        labelsAdded: [],
        labelsRemoved: [{ message: { id: "m1", threadId: "t1" }, labelIds: ["UNREAD"] }],
      }],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects CR/LF header injection in sendMessage fields and custom headers", async () => {
    const { client } = createClient({});

    await expect(client.sendMessage({
      to: "a@example.com",
      subject: "ok\r\nBcc: x@example.com",
      body: "Hello",
    })).rejects.toThrow("Subject value contains CR/LF");

    await expect(client.sendMessage({
      to: "a@example.com",
      subject: "ok",
      body: "Hello",
      headers: { "Bad Header": "value" },
    })).rejects.toThrow("invalid header name");

    await expect(client.sendMessage({
      to: "a@example.com",
      subject: "ok",
      body: "Hello",
      headers: { "X-Test": "one\ntwo" },
    })).rejects.toThrow("X-Test value contains CR/LF");
  });

  it("sends messages, drafts, label modifications, searches, profiles, labels, and threads", async () => {
    const { client } = createClient({
      "GET /gmail/v1/users/me/profile": { emailAddress: "me@example.com", messagesTotal: 1, threadsTotal: 1, historyId: "h1" },
      "GET /gmail/v1/users/me/labels": { labels: [{ id: "INBOX", name: "Inbox" }] },
      "GET /gmail/v1/users/me/messages?q=from%3Aa": { messages: [] },
      "GET /gmail/v1/users/me/threads/t1?format=full": { id: "t1", messages: [] },
      "POST /gmail/v1/users/me/messages/send": { id: "sent-1", threadId: "t1" },
      "POST /gmail/v1/users/me/drafts": { id: "d1", message: { id: "draft-msg", threadId: "t1" } },
      "POST /gmail/v1/users/me/drafts/send": { id: "sent-draft", threadId: "t1" },
      "POST /gmail/v1/users/me/messages/m1/modify": { id: "m1", threadId: "t1", labelIds: [] },
      "POST /gmail/v1/users/me/threads/t1/modify": { id: "t1", messages: [] },
    });

    await expect(client.getProfile()).resolves.toMatchObject({ historyId: "h1" });
    await expect(client.listLabels()).resolves.toEqual([{ id: "INBOX", name: "Inbox" }]);
    await expect(client.search("from:a")).resolves.toEqual({ messages: [], nextPageToken: undefined, resultSizeEstimate: undefined });
    await expect(client.getThread("t1", { format: "full" })).resolves.toEqual({ id: "t1", messages: [] });
    await expect(client.sendMessage({ to: "a@example.com", subject: "s", body: "b" })).resolves.toEqual({ id: "sent-1", threadId: "t1" });
    await expect(client.createDraft({ to: "a@example.com", subject: "s", body: "b" })).resolves.toMatchObject({ id: "d1" });
    await expect(client.sendDraft("d1")).resolves.toEqual({ id: "sent-draft", threadId: "t1" });
    await expect(client.modifyLabels({ messageId: "m1", removeLabelIds: ["UNREAD"] })).resolves.toMatchObject({ id: "m1" });
    await expect(client.modifyLabels({ threadId: "t1", addLabelIds: ["STARRED"] })).resolves.toMatchObject({ id: "t1" });
  });

  it("searches People API contacts with a best-effort warmup and normalizes results", async () => {
    const { client, fetch } = createClient({
      // Warmup (empty query) routes are intentionally absent: the 404 must be swallowed.
      "GET /v1/people:searchContacts?query=ada&readMask=names%2CemailAddresses&pageSize=10": {
        results: [
          {
            person: {
              names: [{ displayName: "Ada Lovelace" }],
              emailAddresses: [{ value: "Ada@Math.example" }, { value: "ada@home.example" }],
            },
          },
          { person: { emailAddresses: [{ value: "ada@math.example" }] } },
        ],
      },
      "GET /v1/otherContacts:search?query=ada&readMask=names%2CemailAddresses&pageSize=3": {
        results: [{ person: { emailAddresses: [{ value: "other@x.example" }] } }],
      },
    });

    await expect(client.searchContacts("ada")).resolves.toEqual([
      { email: "ada@math.example", displayName: "Ada Lovelace" },
      { email: "ada@home.example", displayName: "Ada Lovelace" },
    ]);
    await expect(client.searchOtherContacts("ada", { pageSize: 3 })).resolves.toEqual([
      { email: "other@x.example" },
    ]);
    // Two warmup requests fired exactly once (per client), then the two searches.
    const warmups = fetch.mock.calls.filter(([url]) => String(url).includes("query=&"));
    expect(warmups).toHaveLength(2);
  });

  it("maps People API 403 to a forbidden GmailApiError", async () => {
    const fetch = vi.fn(async (url: string | URL) => {
      const parsed = new URL(String(url));
      if (parsed.searchParams.get("query") === "") return jsonResponse({});
      return new Response("missing scope", { status: 403, statusText: "Forbidden" });
    });
    const credentials = {
      forAudience: vi.fn(async () => ({ credentialId: "cred-1", fetch }) as UrlCredentialHandle),
    } as unknown as CredentialClient;
    const client = createGmailClient(credentials);

    const error = await client.searchContacts("ada").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GmailApiError);
    expect((error as GmailApiError).code).toBe("forbidden");
  });
});
