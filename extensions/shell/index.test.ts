import { readFile, stat, mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@vibestudio/extension";
import { activate } from "./index.js";
import type { SessionInfoEvent } from "./types.js";

async function makeApi(
  approval: "allow" | "deny" | Array<"allow" | "deny"> = "allow",
) {
  const root = await mkdtemp(join(tmpdir(), "vibestudio-shell-test-"));
  void approval;
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  // Materialize a per-context folder on demand, mirroring the host capability.
  const ensureContextFolder = vi.fn(async (contextId: string) => {
    const dir = join(root, ".context-projections", "v5", contextId);
    await mkdir(dir, { recursive: true });
    return { source: `${dir}-source`, scratch: dir };
  });
  const rpcCall = vi.fn(
    async (_target: string, _method: string, ..._args: unknown[]) =>
      [] as unknown,
  );
  const invoke = vi.fn(
    async (_name: string, _method: string, _args: unknown[]) => null as unknown,
  );
  const invokeProvider = vi.fn(
    async (_provider: string, _method: string, _args: unknown[]) =>
      null as unknown,
  );
  const invocationCurrent = vi.fn(() => ({
    caller: { callerId: "panel:test", callerKind: "panel" },
  }));
  const ctx = {
    storage: { root },
    workspace: {
      getInfo: async () => ({
        id: "ws",
        name: "ws",
        path: root,
        contextProjectionsPath: join(root, ".context-projections", "v5"),
      }),
      ensureContextFolder,
    },
    invocation: { current: invocationCurrent },
    extensions: {
      invoke,
      invokeProvider,
      use: vi.fn(),
      on: vi.fn(),
      list: vi.fn(),
      reload: vi.fn(),
    },
    rpc: { call: rpcCall, stream: vi.fn(), on: vi.fn() },
    health: {
      healthy: vi.fn(),
      degraded: vi.fn(),
      unhealthy: vi.fn(),
      report: vi.fn(),
    },
    log,
  } as unknown as ExtensionContext;
  return {
    api: await activate(ctx),
    root,
    log,
    ensureContextFolder,
    rpcCall,
    invoke,
    invokeProvider,
    invocationCurrent,
  };
}

describe("@workspace-extensions/shell", () => {
  it("rejects cwd escapes before execution", async () => {
    const { api } = await makeApi();
    await expect(
      api.exec({ intent: { kind: "argv", executable: "pwd" }, cwd: "../../" }),
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("keeps generated shell-integration paths out of the session label", async () => {
    const { api } = await makeApi("allow");
    const { sessionId } = await api.open({});
    const info = await api.get(sessionId);

    expect(info.label).toBe("Shell");
    if (info.command.argv.some((part) => part === "--init-file")) {
      expect(info.command.argv.join(" ")).toContain("shellIntegration-bash.sh");
    }

    await api.kill(sessionId);
    await api.dispose(sessionId);
  });

  it("runs argv-style exec without invoking a shell", async () => {
    const { api } = await makeApi("allow");
    const result = await api.exec({
      intent: {
        kind: "argv",
        executable: "node",
        args: ["-e", "console.log(process.argv[1])", "hello;not-a-shell"],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello;not-a-shell");
  });

  it("rejects the removed command/args/shell exec shape", async () => {
    const { api } = await makeApi("allow");
    await expect(
      api.exec({ command: "echo", args: ["legacy"], shell: true } as never),
    ).rejects.toThrow();
  });

  it("stashes scratch files inside the workspace with a hard size cap", async () => {
    const { api, root } = await makeApi("allow");
    const result = await api.stashScratch(new Uint8Array([1, 2, 3]), "png");
    expect(result.absolutePath.startsWith(join(root, ".snug", "scratch"))).toBe(
      true,
    );
    expect(result.workspaceRelative.startsWith(".snug/scratch/")).toBe(true);
    await expect(readFile(result.absolutePath)).resolves.toEqual(
      Buffer.from([1, 2, 3]),
    );
    await expect(
      api.stashScratch(new Uint8Array(), "png"),
    ).rejects.toMatchObject({
      code: "EINVAL",
    });
    await expect(
      api.stashScratch(new Uint8Array(25 * 1024 * 1024 + 1), "png"),
    ).rejects.toMatchObject({ code: "E2BIG" });
  });

  it("normalizes hostile scratch extensions to bin", async () => {
    const { api } = await makeApi("allow");
    const result = await api.stashScratch(new Uint8Array([1]), "../png;rm");

    expect(result.absolutePath.endsWith(".bin")).toBe(true);
    expect(result.workspaceRelative.endsWith(".bin")).toBe(true);
  });

  it("publishes bulk session info snapshots and lifecycle events for the current caller", async () => {
    const { api } = await makeApi("allow");
    const response = await api.watchAllSessionInfo();
    const reader = response.body!.getReader();
    const first = await readEvent(reader);
    expect(first.type).toBe("snapshot-batch");
    if (first.type !== "snapshot-batch")
      throw new Error(`unexpected event ${first.type}`);
    expect(first.sessions).toEqual([]);

    const opened = api.open({
      command: "node",
      args: ["-e", "console.log('http://localhost:5173')"],
    });
    const openedEvent = await readEvent(reader);
    expect(openedEvent.type).toBe("opened");
    if (openedEvent.type !== "opened")
      throw new Error(`unexpected event ${openedEvent.type}`);
    const { sessionId } = await opened;
    expect(openedEvent.sessionId).toBe(sessionId);

    let snapshot: SessionInfoEvent | null = null;
    for (let i = 0; i < 10; i += 1) {
      const event = await readEvent(reader);
      if (
        event.type === "snapshot" &&
        event.sessionId === sessionId &&
        event.info.detectedPorts.includes(5173) &&
        event.info.detectedUrls.includes("http://localhost:5173")
      ) {
        snapshot = event;
        break;
      }
    }
    expect(snapshot && "info" in snapshot ? snapshot.info : null).toMatchObject(
      {
        detectedPorts: [5173],
        detectedUrls: ["http://localhost:5173"],
      },
    );
    await reader.cancel();
  });

  it("supports metadata, restart, scrollback clearing, and disposal", async () => {
    const { api } = await makeApi("allow");
    const { sessionId } = await api.open({
      command: "node",
      args: ["-e", "process.stdout.write('one')"],
    });
    await api.awaitExit(sessionId);
    const beforeClear = await api.getScrollback(sessionId);
    expect(beforeClear.text).toContain("one");

    await api.setMeta(sessionId, "badge", { text: "1" });
    await expect(api.getMeta(sessionId, "badge")).resolves.toEqual({
      text: "1",
    });
    await api.deleteMeta(sessionId, "badge");
    await expect(api.getMeta(sessionId, "badge")).resolves.toBeUndefined();

    await api.clearScrollback(sessionId);
    await expect(api.getScrollback(sessionId)).resolves.toMatchObject({
      text: "",
    });
    await api.setScrollbackLimit(sessionId, 1024 * 1024);

    const restarted = await api.restart(sessionId);
    expect(restarted.sessionId).not.toBe(sessionId);
    await api.dispose(sessionId);
    await expect(api.dispose(sessionId)).resolves.toBeUndefined();
    await expect(api.get(sessionId)).rejects.toMatchObject({ code: "ENOENT" });
    await api.dispose(restarted.sessionId);
    await expect(api.dispose(restarted.sessionId)).resolves.toBeUndefined();
  });

  it("prevents public metadata RPCs from setting host-owned handoff keys", async () => {
    const { api } = await makeApi("allow");
    const { sessionId } = await api.open({ command: "node", args: ["-e", ""] });
    await api.awaitExit(sessionId);

    await expect(
      api.setMeta(sessionId, "snugOpenUrl", {
        id: "spoof",
        url: "https://spoof.test",
        requestedAt: 1,
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
    await expect(
      api.deleteMeta(sessionId, "snugOpenUrl"),
    ).rejects.toMatchObject({
      code: "EACCES",
    });
    await expect(
      api.getMeta(sessionId, "snugOpenUrl"),
    ).resolves.toBeUndefined();
  });

  it("coalesces bulk stream snapshots while keeping lifecycle events immediate", async () => {
    const { api } = await makeApi("allow");
    const { sessionId } = await api.open({
      command: "node",
      args: ["-e", "setTimeout(() => {}, 5000)"],
    });
    const response = await api.watchAllSessionInfo();
    const reader = response.body!.getReader();
    await readEvent(reader);

    await api.setMeta(sessionId, "one", 1);
    await api.setMeta(sessionId, "two", 2);
    await api.setMeta(sessionId, "three", 3);

    const firstSnapshot = await readEvent(reader);
    expect(firstSnapshot).toMatchObject({ type: "snapshot", sessionId });

    await api.dispose(sessionId);
    const disposed = await readEvent(reader, 500);
    expect(disposed).toMatchObject({ type: "disposed", sessionId });
    await reader.cancel();
  });

  it("injects snug CLI and routes session-scoped metadata commands", async () => {
    const { api } = await makeApi("allow");
    const { sessionId } = await api.open({
      command: "/bin/sh",
      args: [
        "-lc",
        "snug version && snug meta set mood '{\"ok\":true}' && snug meta get mood && snug badge 7 --color amber && snug label renamed && snug notify --severity done --title Build finished",
      ],
    });
    await api.awaitExit(sessionId);
    const info = await api.get(sessionId);
    const scrollback = await api.getScrollback(sessionId);
    expect(scrollback.text).toContain("snug 0.1.0");
    expect(scrollback.text).toContain('{"ok":true}');
    expect(scrollback.text).toContain("1337;snug");
    expect(info.label).toBe("renamed");
    await expect(api.getMeta(sessionId, "mood")).resolves.toEqual({ ok: true });
    await expect(api.getMeta(sessionId, "badge")).resolves.toEqual({
      text: "7",
      color: "amber",
    });
  });

  it("allocates isolated snug sockets and unlinks them when sessions exit", async () => {
    const { api } = await makeApi("allow");
    const first = await api.open({
      command: "/bin/sh",
      args: ["-lc", "printf '%s\\n' \"$SNUG_SOCK\""],
    });
    const second = await api.open({
      command: "/bin/sh",
      args: ["-lc", "printf '%s\\n' \"$SNUG_SOCK\""],
    });
    await api.awaitExit(first.sessionId);
    await api.awaitExit(second.sessionId);

    const firstSocket = socketPathFrom(
      (await api.getScrollback(first.sessionId)).text,
    );
    const secondSocket = socketPathFrom(
      (await api.getScrollback(second.sessionId)).text,
    );

    expect(firstSocket).toBeTruthy();
    expect(secondSocket).toBeTruthy();
    expect(firstSocket).not.toBe(secondSocket);
    expect((await stat(join(firstSocket!, ".."))).mode & 0o777).toBe(0o700);
    await expect(stat(firstSocket!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(secondSocket!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not expose snug routing tokens in the session environment", async () => {
    const { api } = await makeApi("allow");
    const { sessionId } = await api.open({
      command: "/bin/sh",
      args: [
        "-lc",
        'test -n "$SNUG_SOCK" && test -z "${SNUG_TOKEN:-}" && snug version',
      ],
    });
    await api.awaitExit(sessionId);
    const scrollback = await api.getScrollback(sessionId);

    expect(scrollback.text).toContain("snug 0.1.0");
  });

  it("injects VS Code shell integration into interactive bash sessions", async () => {
    await expect(stat("/bin/bash")).resolves.toBeTruthy();
    const { api } = await makeApi("allow");
    const { sessionId } = await api.open({ command: "/bin/bash" });

    await api.write(
      sessionId,
      "cd /tmp\nprintf 'vibestudio-shell-integration-proof\\n'\nexit\n",
    );
    await api.awaitExit(sessionId);
    const scrollback = await api.getScrollback(sessionId, 1024 * 1024);

    expect(scrollback.text).toContain("vibestudio-shell-integration-proof");
    expect(scrollback.text).toContain("\x1b]633;P;Cwd=/tmp\x07");
    expect(scrollback.text).toContain("\x1b]633;E;cd /tmp;");
    expect(scrollback.text).toContain("\x1b]633;C\x07");
    expect(scrollback.text).toMatch(/\x1b]633;D;0\x07/);
  });

  it("rejects stale snug clients before dispatching commands", async () => {
    const { api } = await makeApi("allow");
    const staleClient = [
      "const net = require('node:net');",
      "const c = net.createConnection(process.env.SNUG_SOCK);",
      "let data = '';",
      "c.on('connect', () => c.write(JSON.stringify({ proto: 1, version: '0.0.0', pid: process.pid, argv: ['meta', 'set', 'stale', 'true'] }) + '\\n'));",
      "c.on('data', (chunk) => data += chunk);",
      "c.on('end', () => process.stdout.write(data));",
    ].join(" ");
    const { sessionId } = await api.open({
      command: "node",
      args: ["-e", staleClient],
    });
    await api.awaitExit(sessionId);
    const scrollback = await api.getScrollback(sessionId);

    expect(scrollback.text).toContain("incompatible snug client");
    await expect(api.getMeta(sessionId, "stale")).resolves.toBeUndefined();
  });

  it("prevents snug meta from spoofing host-owned handoff keys", async () => {
    const { api } = await makeApi("allow");
    const { sessionId } = await api.open({
      command: "/bin/sh",
      args: [
        "-lc",
        'snug meta set snugOpenUrl \'{"id":"spoof","url":"https://spoof.test","requestedAt":1}\' || echo rejected',
      ],
    });
    await api.awaitExit(sessionId);
    const scrollback = await api.getScrollback(sessionId);

    expect(scrollback.text).toContain(
      "reserved snug metadata key: snugOpenUrl",
    );
    expect(scrollback.text).toContain("rejected");
    await expect(
      api.getMeta(sessionId, "snugOpenUrl"),
    ).resolves.toBeUndefined();
  });

  it("lets snug clear a tab badge", async () => {
    const { api } = await makeApi("allow");
    const { sessionId } = await api.open({
      command: "/bin/sh",
      args: ["-lc", "snug badge busy --color blue && snug badge clear"],
    });
    await api.awaitExit(sessionId);
    await expect(api.getMeta(sessionId, "badge")).resolves.toBeUndefined();
  });

  it("rejects invalid snug badge colors without writing badge metadata", async () => {
    const { api } = await makeApi("allow");
    const { sessionId } = await api.open({
      command: "/bin/sh",
      args: ["-lc", "snug badge busy --color nope || echo rejected"],
    });
    await api.awaitExit(sessionId);
    const scrollback = await api.getScrollback(sessionId);

    expect(scrollback.text).toContain("invalid snug badge color: nope");
    expect(scrollback.text).toContain("rejected");
    await expect(api.getMeta(sessionId, "badge")).resolves.toBeUndefined();
  });

  it("rejects invalid snug notification severities with a clear error", async () => {
    const { api } = await makeApi("allow");
    const { sessionId } = await api.open({
      command: "/bin/sh",
      args: ["-lc", "snug notify --severity weird hello || echo rejected"],
    });
    await api.awaitExit(sessionId);
    const scrollback = await api.getScrollback(sessionId);

    expect(scrollback.text).toContain("invalid snug notify severity: weird");
    expect(scrollback.text).toContain("rejected");
    expect(scrollback.text).not.toContain("1337;snug");
  });

  it("routes snug split through receiver-admitted shell open and tags spawned sessions", async () => {
    const { api } = await makeApi("allow");
    const { sessionId } = await api.open({
      command: "/bin/sh",
      args: ["-lc", "snug split right --command 'printf child'"],
    });
    await api.awaitExit(sessionId);
    const sessions = await api.list();
    const child = sessions.find(
      (item) => item.sessionId !== sessionId && item.meta["snugSpawn"],
    );
    expect(child?.meta["snugSpawn"]).toMatchObject({
      parentSessionId: sessionId,
      direction: "row",
    });
    expect(child?.command.argv.join(" ")).toContain("printf child");
  });

  it("routes approved snug open into a trusted session metadata handoff", async () => {
    const { api } = await makeApi("allow");
    const { sessionId } = await api.open({
      command: "/bin/sh",
      args: ["-lc", "snug open --url https://example.test"],
    });
    await api.awaitExit(sessionId);
    await expect(api.getMeta(sessionId, "snugOpenUrl")).resolves.toMatchObject({
      id: expect.any(String),
      url: "https://example.test",
      requestedAt: expect.any(Number),
    });
  });

  it("tags an agent only when it is the launched executable", async () => {
    const { api, root } = await makeApi("allow");
    const claude = join(root, "claude");
    await symlink(process.execPath, claude);
    const { sessionId } = await api.open({
      command: claude,
      args: ["--version"],
    });
    await api.awaitExit(sessionId);
    const info = await api.get(sessionId);
    expect(info.detectedAgent).toEqual({
      kind: "claude-code",
      title: "Claude Code",
    });
  });

  it("does not infer an agent from labels or arbitrary arguments", async () => {
    const { api } = await makeApi("allow");
    const { sessionId } = await api.open({
      command: "node",
      args: ["-e", "process.exit(0)", "claude"],
      label: "Claude Code",
    });
    await api.awaitExit(sessionId);
    const info = await api.get(sessionId);
    expect(info.detectedAgent).toBeUndefined();
  });

  it("places context sessions in the materialized context folder and carries contextId", async () => {
    const { api, ensureContextFolder, root } = await makeApi("allow");
    const { sessionId } = await api.open({
      command: "node",
      args: ["-e", "process.exit(0)"],
      contextId: "ctx-1",
    });
    await api.awaitExit(sessionId);
    expect(ensureContextFolder).toHaveBeenCalledWith("ctx-1");
    const info = await api.get(sessionId);
    expect(info.contextId).toBe("ctx-1");
    expect(info.command.cwd).toBe(
      join(root, ".context-projections", "v5", "ctx-1"),
    );
  });

  it("uses shell-created context tokens for the newly created context", async () => {
    const { api, ensureContextFolder, rpcCall } = await makeApi("allow");
    rpcCall.mockImplementation(async (_target: string, method: string) => {
      if (method === "runtime.createEntity")
        return { id: "entity-new", contextId: "ctx-new" };
      if (method === "runtime.resolveContext") return "ctx-new";
      return [];
    });

    const created = await api.createContext({ title: "New terminal context" });
    expect(created.contextId).toBe("ctx-new");
    expect(created.contextAttachToken).toEqual(expect.any(String));
    expect(rpcCall).toHaveBeenCalledWith("main", "runtime.createEntity", {
      kind: "session",
      execution: { surface: "inert" },
      source: "terminal",
      title: "New terminal context",
    });

    const { sessionId } = await api.open({
      command: "node",
      args: ["-e", "process.exit(0)"],
      contextId: created.contextId,
      contextAttachToken: created.contextAttachToken,
    });
    await api.awaitExit(sessionId);

    expect(ensureContextFolder).toHaveBeenCalledWith("ctx-new");
  });

  it("supports multiple sessions attached to the same context", async () => {
    const { api } = await makeApi(["allow", "allow", "allow"]);
    const first = await api.open({
      command: "node",
      args: ["-e", "setTimeout(() => {}, 5000)"],
      contextId: "ctx-attached",
    });
    const second = await api.open({
      command: "node",
      args: ["-e", "process.exit(0)"],
      contextId: "ctx-attached",
    });

    await api.kill(first.sessionId, "SIGTERM");
    await api.awaitExit(first.sessionId);
    await api.awaitExit(second.sessionId);
  });
});

const readerBuffers = new WeakMap<
  ReadableStreamDefaultReader<Uint8Array>,
  string
>();

async function readEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 5000,
): Promise<SessionInfoEvent> {
  const decoder = new TextDecoder();
  let buffer = readerBuffers.get(reader) ?? "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bufferedNewline = buffer.indexOf("\n");
    if (bufferedNewline >= 0) {
      const line = buffer.slice(0, bufferedNewline);
      readerBuffers.set(reader, buffer.slice(bufferedNewline + 1));
      return JSON.parse(line) as SessionInfoEvent;
    }
    const remaining = Math.max(1, deadline - Date.now());
    const next = await Promise.race([
      reader.read(),
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), remaining),
      ),
    ]);
    if (!next) break;
    const { value, done } = next;
    if (done) throw new Error("stream ended before event");
    buffer += decoder.decode(value, { stream: true });
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
      const line = buffer.slice(0, newline);
      readerBuffers.set(reader, buffer.slice(newline + 1));
      return JSON.parse(line) as SessionInfoEvent;
    }
  }
  readerBuffers.set(reader, buffer);
  throw new Error("timed out waiting for stream event");
}

function socketPathFrom(scrollback: string): string | undefined {
  return scrollback
    .split(/\r?\n/)
    .find((line) => line.includes("/snug-") && line.endsWith(".sock"));
}
