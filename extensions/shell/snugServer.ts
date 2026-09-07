import { randomBytes } from "node:crypto";
import { mkdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionInfo } from "./types.js";

const SNUG_CLI_VERSION = "0.1.0";

export interface SnugSessionOps {
  list(ownerCallerId: string): SessionInfo[];
  setMeta(sessionId: string, key: string, value: unknown): void;
  getMeta(sessionId: string, key?: string): unknown;
  deleteMeta(sessionId: string, key: string): void;
  setLabel(sessionId: string, label: string): void;
  write(sessionId: string, text: string): void;
  ownerOf(sessionId: string): string | undefined;
  openSplit(sessionId: string, direction: "row" | "column", command?: string): Promise<string>;
  openUrl(sessionId: string, url: string): Promise<void>;
}

export interface SnugServerOptions {
  platform?: NodeJS.Platform;
}

export class SnugServer {
  private dir?: string;
  private binDir?: string;
  private readonly platform: NodeJS.Platform;
  private readonly pending = new Map<string, { server: Server; socketPath: string }>();
  private readonly sessions = new Map<
    string,
    { token: string; server: Server; socketPath: string }
  >();
  private readonly tokens = new Map<string, string>();
  private readonly notificationBuckets = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly ops: SnugSessionOps,
    opts: SnugServerOptions = {}
  ) {
    this.platform = opts.platform ?? process.platform;
  }

  async start(): Promise<void> {
    if (this.platform === "win32") return;
    if (this.dir) return;
    this.dir = path.join(tmpdir(), `snug-${randomBytes(16).toString("hex")}`);
    this.binDir = path.join(this.dir, "bin");
    await mkdir(this.binDir, { recursive: true, mode: 0o700 });
    await assertPrivateDir(this.dir, this.platform);
    await this.writeCli();
  }

  envForSession(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; token: string } {
    if (!this.dir || !this.binDir) return { env, token: "" };
    const token = randomBytes(24).toString("hex");
    const socketPath = path.join(this.dir, `${randomBytes(16).toString("hex")}.sock`);
    const server = createServer((socket) => this.handleSocket(socket, token));
    server.listen(socketPath);
    this.pending.set(token, { server, socketPath });
    return {
      token,
      env: {
        ...env,
        SNUG_SOCK: socketPath,
        PATH: `${this.binDir}${path.delimiter}${env["PATH"] ?? ""}`,
      },
    };
  }

  register(token: string, sessionId: string): void {
    if (!token) return;
    this.tokens.set(token, sessionId);
    const pending = this.pending.get(token);
    if (!pending) return;
    this.pending.delete(token);
    this.sessions.set(sessionId, { token, ...pending });
  }

  discardPending(token: string): void {
    const pending = this.pending.get(token);
    if (!pending) return;
    this.pending.delete(token);
    closeAndUnlink(pending.server, pending.socketPath);
  }

  unregister(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.tokens.delete(session.token);
    this.notificationBuckets.delete(sessionId);
    closeAndUnlink(session.server, session.socketPath);
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values())
      closeAndUnlink(session.server, session.socketPath);
    for (const pending of this.pending.values()) closeAndUnlink(pending.server, pending.socketPath);
    this.sessions.clear();
    this.pending.clear();
    this.tokens.clear();
    this.notificationBuckets.clear();
    if (this.dir) await rm(this.dir, { recursive: true, force: true }).catch(() => {});
    this.dir = undefined;
    this.binDir = undefined;
  }

  private async writeCli(): Promise<void> {
    const script = `#!/usr/bin/env node
const net = require("node:net");
const argv = process.argv.slice(2);
function osc(sev, title, msg) {
  const p = new URLSearchParams();
  p.set("sev", sev || "info");
  if (title) p.set("title", title);
  p.set("msg", msg || "");
  return "\\x1b]1337;snug;" + p.toString().replace(/&/g, ";") + "\\x07";
}
if (argv[0] === "version") {
  console.log("snug ${SNUG_CLI_VERSION}");
  process.exit(0);
}
const sock = process.env.SNUG_SOCK;
if (!sock) {
  console.error("snug: missing SNUG_SOCK");
  process.exit(2);
}
let data = "";
let attempts = 0;
function connect() {
  const client = net.createConnection(sock);
  client.on("connect", () => client.write(JSON.stringify({ proto: 1, version: "${SNUG_CLI_VERSION}", pid: process.pid, argv }) + "\\n"));
  client.on("data", chunk => data += chunk);
  client.on("end", () => {
    const res = JSON.parse(data || "{}");
    if (!res.ok) {
      console.error(res.error || "snug command failed");
      process.exit(1);
    }
    if (res.stdout !== undefined) process.stdout.write(String(res.stdout));
  });
  client.on("error", err => {
    if ((err.code === "ENOENT" || err.code === "ECONNREFUSED") && attempts++ < 20) {
      setTimeout(connect, 10);
      return;
    }
    console.error("snug:", err.message);
    process.exit(1);
  });
}
connect();
`;
    const target = path.join(this.binDir!, "snug");
    await writeFile(target, script, { mode: 0o700 });
  }

  private handleSocket(socket: Socket, socketToken: string): void {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      const line = buffer.split("\n", 1)[0] ?? "";
      void this.handleRequest(line, socketToken).then((response) => {
        socket.end(JSON.stringify(response));
      });
    });
  }

  private async handleRequest(
    line: string,
    socketToken: string
  ): Promise<{ ok: true; stdout?: string } | { ok: false; error: string }> {
    try {
      const req = JSON.parse(line) as {
        proto: number;
        version?: string;
        pid?: number;
        argv: string[];
      };
      if (req.proto !== 1) return { ok: false, error: "unsupported snug protocol" };
      if (req.version !== SNUG_CLI_VERSION)
        return {
          ok: false,
          error: `incompatible snug client: expected ${SNUG_CLI_VERSION}, got ${req.version ?? "unknown"}`,
        };
      if (typeof req.pid !== "number" || !Number.isInteger(req.pid) || req.pid <= 0)
        return { ok: false, error: "invalid snug client" };
      const sessionId = this.tokens.get(socketToken);
      if (!sessionId) return { ok: false, error: "invalid snug session" };
      const ownerCallerId = this.ops.ownerOf(sessionId);
      if (!ownerCallerId) return { ok: false, error: "unknown snug owner" };
      return await this.dispatch(sessionId, ownerCallerId, req.argv);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async dispatch(
    sessionId: string,
    ownerCallerId: string,
    argv: string[]
  ): Promise<{ ok: true; stdout?: string } | { ok: false; error: string }> {
    const [cmd, ...rest] = argv;
    if (cmd === "ls")
      return { ok: true, stdout: `${JSON.stringify(this.ops.list(ownerCallerId), null, 2)}\n` };
    if (cmd === "badge") {
      const parsed = parseBadgeArgs(rest);
      if (!parsed.text || parsed.text === "clear") this.ops.deleteMeta(sessionId, "badge");
      else
        this.ops.setMeta(
          sessionId,
          "badge",
          parsed.color ? { text: parsed.text, color: parsed.color } : { text: parsed.text }
        );
      return { ok: true };
    }
    if (cmd === "label") {
      this.ops.setLabel(sessionId, rest.join(" "));
      return { ok: true };
    }
    if (cmd === "meta") return this.meta(sessionId, rest);
    if (cmd === "notify") return this.notify(sessionId, rest);
    if (cmd === "send") return this.send(ownerCallerId, rest);
    if (cmd === "split") return await this.split(sessionId, rest);
    if (cmd === "open") return await this.open(sessionId, rest);
    return { ok: false, error: `unknown snug command: ${cmd ?? ""}` };
  }

  private meta(
    sessionId: string,
    argv: string[]
  ): { ok: true; stdout?: string } | { ok: false; error: string } {
    const [op, key, ...rest] = argv;
    if (!key) return { ok: false, error: "meta requires a key" };
    if (isReservedMetaKey(key)) return { ok: false, error: `reserved snug metadata key: ${key}` };
    if (op === "set") {
      this.ops.setMeta(sessionId, key, parseValue(rest.join(" ")));
      return { ok: true };
    }
    if (op === "get")
      return { ok: true, stdout: `${JSON.stringify(this.ops.getMeta(sessionId, key))}\n` };
    if (op === "delete") {
      this.ops.deleteMeta(sessionId, key);
      return { ok: true };
    }
    return { ok: false, error: "meta supports set/get/delete" };
  }

  private send(ownerCallerId: string, argv: string[]): { ok: true } | { ok: false; error: string } {
    const toIndex = argv.indexOf("--to");
    const textIndex = argv.indexOf("--text");
    const target = toIndex >= 0 ? argv[toIndex + 1] : undefined;
    const text = textIndex >= 0 ? argv.slice(textIndex + 1).join(" ") : undefined;
    if (!target || text === undefined) return { ok: false, error: "send requires --to and --text" };
    if (this.ops.ownerOf(target) !== ownerCallerId) return { ok: false, error: "EACCES" };
    this.ops.write(target, text);
    return { ok: true };
  }

  private notify(
    sessionId: string,
    argv: string[]
  ): { ok: true; stdout?: string } | { ok: false; error: string } {
    const parsed = parseNotifyArgs(argv);
    if (!this.consumeNotificationQuota(sessionId)) {
      return { ok: false, error: "snug notify rate limit exceeded" };
    }
    return { ok: true, stdout: osc(parsed.severity, parsed.title, parsed.message) };
  }

  private consumeNotificationQuota(sessionId: string): boolean {
    const now = Date.now();
    const current = this.notificationBuckets.get(sessionId);
    if (!current || now - current.startedAt >= 60_000) {
      this.notificationBuckets.set(sessionId, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= 50) return false;
    current.count += 1;
    return true;
  }

  private async split(
    sessionId: string,
    argv: string[]
  ): Promise<{ ok: true; stdout?: string } | { ok: false; error: string }> {
    const directionArg = argv[0];
    const commandIndex = argv.indexOf("--command");
    const command = commandIndex >= 0 ? argv.slice(commandIndex + 1).join(" ") : undefined;
    const direction =
      directionArg === "down" ? "column" : directionArg === "right" ? "row" : undefined;
    if (!direction) return { ok: false, error: "split requires right or down" };
    const sessionIdOut = await this.ops.openSplit(sessionId, direction, command || undefined);
    return { ok: true, stdout: `${sessionIdOut}\n` };
  }

  private async open(
    sessionId: string,
    argv: string[]
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const urlIndex = argv.indexOf("--url");
    const url = urlIndex >= 0 ? argv[urlIndex + 1] : undefined;
    if (!url) return { ok: false, error: "open requires --url" };
    await this.ops.openUrl(sessionId, url);
    return { ok: true };
  }
}

async function assertPrivateDir(dir: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") return;
  const mode = (await stat(dir)).mode & 0o777;
  if (mode !== 0o700) {
    throw new Error(`snug socket directory must be private: ${dir} has mode ${mode.toString(8)}`);
  }
}

function osc(sev: string, title: string, msg: string): string {
  const params = new URLSearchParams();
  params.set("sev", sev || "info");
  if (title) params.set("title", title);
  params.set("msg", msg || "");
  return `\x1b]1337;snug;${params.toString().replace(/&/g, ";")}\x07`;
}

function parseNotifyArgs(argv: string[]): {
  severity: NotificationSeverityName;
  title: string;
  message: string;
} {
  let severity = "info";
  let title = "";
  const message: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--severity") {
      severity = argv[i + 1] || "info";
      i += 1;
    } else if (argv[i] === "--title") {
      title = argv[i + 1] || "";
      i += 1;
    } else {
      message.push(argv[i]!);
    }
  }
  if (!isNotificationSeverityName(severity)) {
    throw new Error(`invalid snug notify severity: ${severity}`);
  }
  return { severity, title, message: message.join(" ") };
}

type NotificationSeverityName = "info" | "done" | "waiting" | "approval" | "failure";

function isNotificationSeverityName(value: string): value is NotificationSeverityName {
  return (
    value === "info" ||
    value === "done" ||
    value === "waiting" ||
    value === "approval" ||
    value === "failure"
  );
}

function parseValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseBadgeArgs(argv: string[]): { text: string; color?: string } {
  let color: string | undefined;
  const text: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--color") {
      color = argv[i + 1];
      i += 1;
    } else {
      text.push(argv[i]!);
    }
  }
  const badgeText = text.join(" ");
  if (color && badgeText && badgeText !== "clear" && !isBadgeColorName(color)) {
    throw new Error(`invalid snug badge color: ${color}`);
  }
  return color ? { text: badgeText, color } : { text: badgeText };
}

const badgeColorNames = new Set([
  "gray",
  "gold",
  "bronze",
  "brown",
  "yellow",
  "amber",
  "orange",
  "tomato",
  "red",
  "ruby",
  "crimson",
  "pink",
  "plum",
  "purple",
  "violet",
  "iris",
  "indigo",
  "blue",
  "cyan",
  "teal",
  "jade",
  "green",
  "grass",
  "lime",
  "mint",
  "sky",
]);

function isBadgeColorName(value: string): boolean {
  return badgeColorNames.has(value);
}

function isReservedMetaKey(key: string): boolean {
  return key === "snugOpenUrl" || key === "snugSpawn";
}

function closeAndUnlink(server: Server, socketPath: string): void {
  server.close(() => {
    void unlink(socketPath).catch(() => {});
  });
}
