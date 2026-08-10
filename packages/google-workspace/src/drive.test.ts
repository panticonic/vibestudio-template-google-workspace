import { describe, expect, it } from "vitest";
import type { RpcCaller } from "@vibestudio/rpc";
import {
  createCredentialClient,
  type StoredCredentialSummary,
} from "@workspace/runtime/credentials";
import { createDriveClient } from "./drive.js";

function makeMockEnv(
  respond: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string; bodyBase64?: string }
  ) => Response
) {
  const stats = {
    resolveCalls: 0,
    fetchCalls: [] as Array<{ url: string; method: string; headers: Record<string, string> }>,
  };
  const credential: StoredCredentialSummary = {
    id: "cred-drive",
    label: "Mock Drive",
    providerId: "mock",
    accountIdentity: { providerUserId: "mock" },
    audience: [],
    injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
    bindings: [],
    scopes: [],
    metadata: {},
    createdAt: Date.now(),
  } as unknown as StoredCredentialSummary;

  const rpc: RpcCaller = {
    call: (async <T = unknown>(_targetId: string, method: string, _args: unknown[]): Promise<T> => {
      if (method === "credentials.resolveCredential") {
        stats.resolveCalls++;
        return credential as unknown as T;
      }
      throw new Error(`unexpected method: ${method}`);
    }) as RpcCaller["call"],
    stream: async (_target: string, method: string, args: unknown[]) => {
      if (method !== "credentials.proxyFetch") {
        throw new Error(`unexpected stream method: ${method}`);
      }
      const params = args[0] as {
        url: string;
        method: string;
        headers?: Record<string, string>;
        body?: string;
        bodyBase64?: string;
      };
      stats.fetchCalls.push({
        url: params.url,
        method: params.method,
        headers: params.headers ?? {},
      });
      return respond(params.url, params);
    },
  };

  return { credentials: createCredentialClient(rpc), stats };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("createDriveClient", () => {
  it("memoizes the Drive credential handle across method calls", async () => {
    const { credentials, stats } = makeMockEnv((url) => {
      if (url.endsWith("/about?fields=kind,user,storageQuota")) {
        return jsonResponse({ kind: "drive#about" });
      }
      if (url.includes("/files?")) {
        return jsonResponse({ files: [] });
      }
      return jsonResponse({});
    });
    const drive = createDriveClient(credentials);

    await drive.about();
    await drive.listFiles({ q: "name contains 'spec'" });
    await drive.about();

    expect(stats.resolveCalls).toBe(1);
    expect(stats.fetchCalls.map((call) => call.method)).toEqual(["GET", "GET", "GET"]);
  });

  it("requests only supported fields from Drive about", async () => {
    const { credentials, stats } = makeMockEnv(() =>
      jsonResponse({
        kind: "drive#about",
        user: { emailAddress: "user@example.com" },
        storageQuota: { usage: "1" },
      })
    );
    const drive = createDriveClient(credentials);

    await drive.about();

    expect(stats.fetchCalls[0]?.url).toBe(
      "https://www.googleapis.com/drive/v3/about?fields=kind,user,storageQuota"
    );
  });

  it("lists files and builds Drive query parameters", async () => {
    const { credentials, stats } = makeMockEnv(() =>
      jsonResponse({
        files: [{ id: "file-1", name: "Spec.docx" }],
        nextPageToken: "next-token",
      })
    );
    const drive = createDriveClient(credentials);

    const result = await drive.listFiles({
      q: "mimeType != 'application/vnd.google-apps.folder'",
      pageSize: 10,
      corpora: "allDrives",
      driveId: "drive-1",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      orderBy: ["modifiedTime desc", "name"],
      fields: "files(id,name),nextPageToken",
    });

    expect(result.files).toHaveLength(1);
    expect(stats.fetchCalls[0]?.url).toContain("/drive/v3/files?");
    expect(stats.fetchCalls[0]?.url).toContain("pageSize=10");
    expect(stats.fetchCalls[0]?.url).toContain("corpora=allDrives");
    expect(stats.fetchCalls[0]?.url).toContain("driveId=drive-1");
    expect(stats.fetchCalls[0]?.url).toContain("orderBy=modifiedTime+desc%2Cname");
  });

  it("downloads file bytes with response metadata", async () => {
    const { credentials, stats } = makeMockEnv(
      () =>
        new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="poem.pdf"',
          },
        })
    );
    const drive = createDriveClient(credentials);

    const result = await drive.downloadFileBytes("file-1");

    expect([...result.bytes]).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(result.size).toBe(4);
    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("poem.pdf");
    expect(result.responseUrl).toBe(
      "https://www.googleapis.com/drive/v3/files/file-1?supportsAllDrives=true&alt=media"
    );
    expect(stats.fetchCalls[0]?.url).toBe(
      "https://www.googleapis.com/drive/v3/files/file-1?supportsAllDrives=true&alt=media"
    );
  });

  it("exports file bytes with decoded filename metadata", async () => {
    const { credentials, stats } = makeMockEnv(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-disposition": "attachment; filename*=UTF-8''poem%20export.pdf",
          },
        })
    );
    const drive = createDriveClient(credentials);

    const result = await drive.exportFileBytes("doc-1", "application/pdf");

    expect([...result.bytes]).toEqual([1, 2, 3]);
    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("poem export.pdf");
    expect(stats.fetchCalls[0]?.url).toBe(
      "https://www.googleapis.com/drive/v3/files/doc-1/export?mimeType=application%2Fpdf&supportsAllDrives=true"
    );
  });

  it("wraps byte helper response body failures with Drive context", async () => {
    const { credentials } = makeMockEnv(() => {
      const response = new Response("not readable");
      Object.defineProperty(response, "arrayBuffer", {
        value: async () => {
          throw new RangeError("Maximum call stack size exceeded");
        },
      });
      return response;
    });
    const drive = createDriveClient(credentials);

    await expect(drive.downloadFileBytes("file-1")).rejects.toThrow(
      "Google Drive download response body read failed: Maximum call stack size exceeded"
    );
  });

  it("uploads files with multipart/related content when media is provided", async () => {
    const { credentials, stats } = makeMockEnv((url, init) => {
      if (url.includes("upload/drive/v3/files")) {
        return jsonResponse({ id: "new-file", name: "hello.txt" });
      }
      return jsonResponse({ id: "unexpected" }, { status: 500 });
    });
    const drive = createDriveClient(credentials);

    const result = await drive.createFile(
      { name: "hello.txt", parents: ["folder-1"] },
      {
        media: {
          mimeType: "text/plain",
          body: "hello world",
        },
      }
    );

    expect(result.id).toBe("new-file");
    expect(stats.fetchCalls[0]?.url).toContain("/upload/drive/v3/files?uploadType=multipart");
    expect(stats.fetchCalls[0]?.headers["content-type"]).toMatch(/^multipart\/related; boundary=/);
  });

  it("builds move, permission, and change sync requests", async () => {
    const { credentials, stats } = makeMockEnv((url) => {
      if (url.includes("/changes/startPageToken")) {
        return jsonResponse({ startPageToken: "token-1" });
      }
      if (url.includes("/changes?")) {
        return jsonResponse({
          changes: [{ id: "chg-1", fileId: "file-1" }],
          newStartPageToken: "token-2",
        });
      }
      return jsonResponse({ id: "ok" });
    });
    const drive = createDriveClient(credentials);

    await drive.moveFile("file-1", { addParents: ["folder-a"], removeParents: "folder-b" });
    await drive.createPermission("file-1", {
      type: "user",
      role: "writer",
      emailAddress: "a@example.com",
    });
    const startToken = await drive.getStartPageToken();
    const changes = await drive.listChanges({
      pageToken: startToken.startPageToken,
      supportsAllDrives: true,
    });

    expect(changes.changes).toHaveLength(1);
    expect(stats.fetchCalls.some((call) => call.url.includes("/files/file-1?"))).toBe(true);
    expect(stats.fetchCalls.some((call) => call.url.includes("/files/file-1/permissions"))).toBe(
      true
    );
    expect(stats.fetchCalls.some((call) => call.url.includes("/changes/startPageToken"))).toBe(
      true
    );
    expect(stats.fetchCalls.some((call) => call.url.includes("/changes?"))).toBe(true);
  });
});
