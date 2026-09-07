import { stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { SnugServer } from "./snugServer.js";

describe("SnugServer", () => {
  it.skipIf(process.platform === "win32")("creates the socket directory with private permissions", async () => {
    const server = new SnugServer(makeOps());
    await server.start();
    const { env, token } = server.envForSession({});
    const socketPath = env["SNUG_SOCK"];
    if (!socketPath) throw new Error("missing SNUG_SOCK");
    await waitForStat(socketPath);

    expect((await stat(dirname(socketPath))).mode & 0o777).toBe(0o700);

    server.discardPending(token);
    await server.dispose();
  });

  it("discards pending session sockets that never register", async () => {
    const server = new SnugServer(makeOps());
    await server.start();
    const { env, token } = server.envForSession({});
    const socketPath = env["SNUG_SOCK"];
    if (!socketPath) throw new Error("missing SNUG_SOCK");
    await waitForStat(socketPath);

    server.discardPending(token);

    await waitForMissing(socketPath);
    await server.dispose();
  });

  it("does not inject a broken Unix-socket transport on Windows v1", async () => {
    const env = { PATH: "existing" };
    const server = new SnugServer(makeOps(), { platform: "win32" });

    await server.start();
    const result = server.envForSession(env);
    server.register(result.token, "session");
    server.discardPending(result.token);

    expect(result).toEqual({ env, token: "" });
    await server.dispose();
  });

  it("rejects snug send to sessions owned by another caller", async () => {
    const writes: Array<{ sessionId: string; text: string }> = [];
    const owners = new Map([
      ["source", "panel:a"],
      ["same-owner", "panel:a"],
      ["other-owner", "panel:b"],
    ]);
    const server = new SnugServer({
      list: () => [],
      setMeta: () => {},
      getMeta: () => undefined,
      deleteMeta: () => {},
      setLabel: () => {},
      write: (sessionId, text) => writes.push({ sessionId, text }),
      ownerOf: (sessionId) => owners.get(sessionId),
      openSplit: async () => "unused",
      openUrl: async () => {},
    });
    await server.start();
    const { env, token } = server.envForSession({});
    const socketPath = env["SNUG_SOCK"];
    if (!socketPath) throw new Error("missing SNUG_SOCK");
    await waitForStat(socketPath);
    server.register(token, "source");

    await expect(sendSnug(socketPath, ["send", "--to", "same-owner", "--text", "hello"])).resolves.toEqual({ ok: true });
    await expect(sendSnug(socketPath, ["send", "--to", "other-owner", "--text", "secret"])).resolves.toMatchObject({
      ok: false,
      error: "EACCES",
    });

    expect(writes).toEqual([{ sessionId: "same-owner", text: "hello" }]);
    await server.dispose();
  });

  it("rate-limits notifications per session", async () => {
    const server = new SnugServer(makeOps({ ownerOf: () => "panel:a" }));
    await server.start();
    const { env, token } = server.envForSession({});
    const socketPath = env["SNUG_SOCK"];
    if (!socketPath) throw new Error("missing SNUG_SOCK");
    await waitForStat(socketPath);
    server.register(token, "source");

    const responses: unknown[] = [];
    for (let i = 1; i <= 51; i += 1) {
      responses.push(await sendSnug(socketPath, ["notify", `n${i}`]));
    }

    const okResponses = responses.filter((item) => (item as { ok?: unknown }).ok === true);
    expect(okResponses).toHaveLength(50);
    expect(okResponses.every((item) => String((item as { stdout?: unknown }).stdout ?? "").includes("1337;snug"))).toBe(true);
    expect(responses[50]).toMatchObject({
      ok: false,
      error: "snug notify rate limit exceeded",
    });
    await server.dispose();
  });
});

function makeOps(overrides: Partial<ConstructorParameters<typeof SnugServer>[0]> = {}): ConstructorParameters<typeof SnugServer>[0] {
  return {
    list: () => [],
    setMeta: () => {},
    getMeta: () => undefined,
    deleteMeta: () => {},
    setLabel: () => {},
    write: () => {},
    ownerOf: () => undefined,
    openSplit: async () => "unused",
    openUrl: async () => {},
    ...overrides,
  };
}

async function waitForStat(path: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    try {
      await stat(path);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForMissing(path: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    try {
      await stat(path);
    } catch {
      return;
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for ${path} removal`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendSnug(socketPath: string, argv: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    socket.on("connect", () => {
      socket.write(JSON.stringify({ proto: 1, version: "0.1.0", pid: process.pid, argv }) + "\n");
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    socket.on("error", reject);
  });
}
