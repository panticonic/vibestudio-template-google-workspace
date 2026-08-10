import { describe, expect, it, vi } from "vitest";
import type { CredentialClient, UrlCredentialHandle } from "@workspace/runtime/credentials";

import { BATCH_CHUNK_SIZE, executeBatch, parseBatchResponse, type BatchPart } from "./batch.js";
import { GmailApiError, createGmailClient } from "./gmail-client.js";

/** Build a multipart/mixed batch response body with the given boundary. */
function batchResponseBody(
  boundary: string,
  parts: Array<{ contentId: string; status: number; statusText?: string; body: string }>
): string {
  const segments = parts.map((part) =>
    [
      `--${boundary}`,
      "Content-Type: application/http",
      `Content-ID: <${part.contentId}>`,
      "",
      `HTTP/1.1 ${part.status} ${part.statusText ?? "OK"}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      part.body,
    ].join("\r\n")
  );
  return segments.join("\r\n") + `\r\n--${boundary}--\r\n`;
}

function multipartResponse(boundary: string, body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
  });
}

describe("parseBatchResponse", () => {
  it("correlates parts via response-prefixed Content-IDs and parses inner statuses", () => {
    const body = batchResponseBody("rb", [
      { contentId: "response-item-0", status: 200, body: JSON.stringify({ id: "m1" }) },
      { contentId: "response-item-1", status: 404, statusText: "Not Found", body: JSON.stringify({ error: "gone" }) },
    ]);
    const results = parseBatchResponse(body, "rb");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ id: "item-0", status: 200, ok: true, json: { id: "m1" } });
    expect(results[1]).toMatchObject({ id: "item-1", status: 404, ok: false });
  });

  it("tolerates non-JSON part bodies", () => {
    const body = batchResponseBody("rb", [
      { contentId: "response-item-0", status: 500, statusText: "Server Error", body: "oops" },
    ]);
    const results = parseBatchResponse(body, "rb");
    expect(results[0]).toMatchObject({ id: "item-0", status: 500, ok: false, bodyText: "oops" });
    expect(results[0]!.json).toBeUndefined();
  });
});

describe("executeBatch", () => {
  it("uses the RESPONSE boundary (not the request boundary) when parsing", async () => {
    const fetchRaw = vi.fn(async () =>
      multipartResponse(
        "totally-different-boundary",
        batchResponseBody("totally-different-boundary", [
          { contentId: "response-a", status: 200, body: JSON.stringify({ ok: 1 }) },
        ])
      )
    );
    const results = await executeBatch(fetchRaw, [
      { id: "a", method: "GET", path: "/gmail/v1/users/me/messages/m1" },
    ]);
    expect(results.get("a")).toMatchObject({ ok: true, json: { ok: 1 } });
  });

  it("chunks requests at BATCH_CHUNK_SIZE and runs chunks sequentially", async () => {
    const calls: string[] = [];
    const fetchRaw = vi.fn(async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      const ids = [...body.matchAll(/Content-ID: <([^>]+)>/g)].map((m) => m[1]!);
      calls.push(`chunk:${ids.length}`);
      return multipartResponse(
        "rb",
        batchResponseBody(
          "rb",
          ids.map((id) => ({
            contentId: `response-${id}`,
            status: 200,
            body: JSON.stringify({ id }),
          }))
        )
      );
    });
    const requests: BatchPart[] = Array.from({ length: BATCH_CHUNK_SIZE + 3 }, (_, i) => ({
      id: `r${i}`,
      method: "GET" as const,
      path: `/gmail/v1/users/me/messages/m${i}`,
    }));
    const results = await executeBatch(fetchRaw, requests);
    expect(calls).toEqual([`chunk:${BATCH_CHUNK_SIZE}`, "chunk:3"]);
    expect(results.size).toBe(BATCH_CHUNK_SIZE + 3);
  });

  it("paces sequential chunks and retries rate-limited parts once with fixed backoff", async () => {
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
    });
    let call = 0;
    const fetchRaw = vi.fn(async (_url: string, init: RequestInit) => {
      call += 1;
      const ids = [...String(init.body).matchAll(/Content-ID: <([^>]+)>/g)].map((m) => m[1]!);
      return multipartResponse(
        "rb",
        batchResponseBody(
          "rb",
          ids.map((id) => ({
            contentId: `response-${id}`,
            // First pass: r1 rate-limited. Retry pass (call 3): succeeds.
            status: call <= 2 && id === "r1" ? 429 : 200,
            body: JSON.stringify({ id }),
          }))
        )
      );
    });
    const requests: BatchPart[] = Array.from({ length: BATCH_CHUNK_SIZE + 1 }, (_, i) => ({
      id: `r${i}`,
      method: "GET" as const,
      path: `/gmail/v1/users/me/messages/m${i}`,
    }));

    const results = await executeBatch(fetchRaw, requests, { sleep, retryDelayMs: 1000 });
    // Two chunks + one retry call.
    expect(fetchRaw).toHaveBeenCalledTimes(3);
    // Inter-chunk pacing before chunk 2, then the retry backoff.
    expect(sleeps).toEqual([200, 1000]);
    expect(results.get("r1")).toMatchObject({ ok: true, json: { id: "r1" } });
  });

  it("surfaces parts that stay rate-limited after the single retry", async () => {
    const fetchRaw = vi.fn(async (_url: string, init: RequestInit) => {
      const ids = [...String(init.body).matchAll(/Content-ID: <([^>]+)>/g)].map((m) => m[1]!);
      return multipartResponse(
        "rb",
        batchResponseBody(
          "rb",
          ids.map((id) => ({ contentId: `response-${id}`, status: 429, body: "rateLimitExceeded" }))
        )
      );
    });
    const results = await executeBatch(
      fetchRaw,
      [{ id: "a", method: "GET", path: "/gmail/v1/users/me/messages/m1" }],
      { sleep: async () => undefined }
    );
    expect(fetchRaw).toHaveBeenCalledTimes(2);
    expect(results.get("a")).toMatchObject({ ok: false, status: 429 });
  });

  it("serializes POST part bodies as JSON inside the multipart payload", async () => {
    let captured = "";
    const fetchRaw = vi.fn(async (_url: string, init: RequestInit) => {
      captured = String(init.body);
      return multipartResponse(
        "rb",
        batchResponseBody("rb", [{ contentId: "response-p", status: 204, body: "" }])
      );
    });
    await executeBatch(fetchRaw, [
      {
        id: "p",
        method: "POST",
        path: "/gmail/v1/users/me/messages/batchModify",
        body: { ids: ["m1"], removeLabelIds: ["UNREAD"] },
      },
    ]);
    expect(captured).toContain("POST /gmail/v1/users/me/messages/batchModify HTTP/1.1");
    expect(captured).toContain('{"ids":["m1"],"removeLabelIds":["UNREAD"]}');
  });
});

describe("GmailClient batch methods", () => {
  function clientWith(fetch: ReturnType<typeof vi.fn>) {
    const handle: UrlCredentialHandle = { credentialId: "cred-1", fetch } as UrlCredentialHandle;
    const credentials = {
      forAudience: vi.fn(async () => handle),
    } as unknown as CredentialClient;
    return createGmailClient(credentials);
  }

  it("batchGetThreads returns per-item values and per-item GmailApiErrors", async () => {
    const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      multipartResponse(
        "rb",
        batchResponseBody("rb", [
          { contentId: "response-item-0", status: 200, body: JSON.stringify({ id: "t1", messages: [] }) },
          { contentId: "response-item-1", status: 404, statusText: "Not Found", body: "{}" },
        ])
      )
    );
    const client = clientWith(fetch);
    const items = await client.batchGetThreads(["t1", "t-missing"], { format: "metadata" });
    expect(items[0]).toMatchObject({ id: "t1", value: { id: "t1", messages: [] } });
    expect(items[1]!.error).toBeInstanceOf(GmailApiError);
    expect(items[1]!.error!.code).toBe("not-found");
    // Request body carries the format query on each inner GET.
    const body = String(fetch.mock.calls[0]![1]!.body);
    expect(body).toContain("GET /gmail/v1/users/me/threads/t1?format=metadata HTTP/1.1");
  });

  it("whole-batch 429 surfaces as a rate-limited GmailApiError", async () => {
    const fetch = vi.fn(
      async () => new Response("rateLimitExceeded", { status: 429, statusText: "Too Many Requests" })
    );
    const client = clientWith(fetch);
    const error = await client.batchGetMessages(["m1"]).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GmailApiError);
    expect((error as GmailApiError).code).toBe("rate-limited");
  });

  it("batchModify posts ids and label changes, tolerating an empty 204 body", async () => {
    const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    const client = clientWith(fetch);
    await expect(
      client.batchModify({ messageIds: ["m1", "m2"], removeLabelIds: ["UNREAD", "INBOX"] })
    ).resolves.toBeUndefined();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toContain("/messages/batchModify");
    expect(JSON.parse(String(init!.body))).toEqual({
      ids: ["m1", "m2"],
      addLabelIds: [],
      removeLabelIds: ["UNREAD", "INBOX"],
    });
  });

  it("batchModify rejects more than 1000 ids and skips empty calls", async () => {
    const fetch = vi.fn();
    const client = clientWith(fetch);
    await expect(client.batchModify({ messageIds: [] })).resolves.toBeUndefined();
    await expect(
      client.batchModify({ messageIds: Array.from({ length: 1001 }, (_, i) => `m${i}`) })
    ).rejects.toThrow("at most 1000");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("label CRUD hits the labels endpoints", async () => {
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "POST" && path.endsWith("/labels")) {
        return new Response(JSON.stringify({ id: "Label_1", name: "Receipts" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ id: "Label_1", name: "Receipts2" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = clientWith(fetch);
    await expect(client.createLabel({ name: "Receipts" })).resolves.toMatchObject({ id: "Label_1" });
    await expect(client.updateLabel("Label_1", { name: "Receipts2" })).resolves.toMatchObject({
      name: "Receipts2",
    });
    await expect(client.deleteLabel("Label_1")).resolves.toBeUndefined();
  });
});
