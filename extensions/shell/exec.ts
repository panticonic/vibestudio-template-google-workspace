import { spawn, type ChildProcess } from "node:child_process";
import { nodeSetTimeout } from "./nodeTimers.js";
import type { ExecIntent, ExecRequest, ExecResult } from "./types.js";

const TERM_GRACE_MS = 2_000;
const KILL_GRACE_MS = 2_000;
const CLOSE_GRACE_MS = 500;
const TREE_POLL_MS = 25;

interface ExecLifecycleOptions {
  platform?: NodeJS.Platform;
  termGraceMs?: number;
  killGraceMs?: number;
  closeGraceMs?: number;
}

interface ExitOutcome {
  exitCode: number | null;
}

function appendCapped(current: Buffer[], chunk: Buffer, maxBytes: number): { truncated: boolean } {
  const used = current.reduce((sum, item) => sum + item.byteLength, 0);
  const remaining = maxBytes - used;
  if (remaining <= 0) return { truncated: true };
  if (chunk.byteLength <= remaining) {
    current.push(chunk);
    return { truncated: false };
  }
  current.push(chunk.subarray(0, remaining));
  return { truncated: true };
}

function launchForIntent(intent: ExecIntent): { command: string; args: string[] } {
  return intent.kind === "argv"
    ? { command: intent.executable, args: intent.args }
    : { command: "/bin/sh", args: ["-c", intent.script] };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = nodeSetTimeout(() => resolve(), ms);
    timer.unref();
  });
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupAlive(pid)) return true;
    await delay(Math.min(TREE_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return !processGroupAlive(pid);
}

async function taskkillTree(
  pid: number,
  timeoutMs: number
): Promise<{ ok: boolean; detail: string }> {
  const taskkill = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  taskkill.stdout?.on("data", (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-4_096);
  });
  taskkill.stderr?.on("data", (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-4_096);
  });
  const completion = new Promise<{ ok: boolean; detail: string }>((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; detail: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    taskkill.once("error", (error) => finish({ ok: false, detail: error.message }));
    taskkill.once("close", (code) => {
      const missing = /not found|no running instance|cannot find/iu.test(output);
      finish({ ok: code === 0 || missing, detail: output.trim() });
    });
  });
  const result = await Promise.race([
    completion,
    delay(timeoutMs).then(() => ({ ok: false, detail: "taskkill timed out" })),
  ]);
  if (!result.ok && taskkill.exitCode === null) taskkill.kill("SIGKILL");
  return result;
}

async function terminateOwnedTree(
  child: ChildProcess,
  options: Required<ExecLifecycleOptions>
): Promise<void> {
  const pid = child.pid;
  if (!pid) throw Object.assign(new Error("Timed command has no process id"), { code: "EIO" });

  if (options.platform === "win32") {
    const result = await taskkillTree(pid, options.killGraceMs);
    if (!result.ok && child.exitCode === null && child.signalCode === null) {
      throw Object.assign(
        new Error(`Timed command process tree could not be stopped: ${result.detail}`),
        { code: "EPROCESSLEAK" }
      );
    }
    return;
  }

  signalProcessGroup(pid, "SIGTERM");
  if (await waitForProcessGroupExit(pid, options.termGraceMs)) return;
  signalProcessGroup(pid, "SIGKILL");
  if (await waitForProcessGroupExit(pid, options.killGraceMs)) return;
  throw Object.assign(new Error(`Timed command process group ${pid} survived SIGKILL`), {
    code: "EPROCESSLEAK",
  });
}

async function waitForClose(
  completion: Promise<ExitOutcome>,
  timeoutMs: number
): Promise<ExitOutcome | null> {
  return Promise.race([completion, delay(timeoutMs).then(() => null)]);
}

export async function runExec(
  req: Omit<ExecRequest, "cwd" | "env"> & { cwd: string; env: NodeJS.ProcessEnv },
  lifecycle: ExecLifecycleOptions = {}
): Promise<ExecResult> {
  const started = Date.now();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let truncated = false;
  const options: Required<ExecLifecycleOptions> = {
    platform: lifecycle.platform ?? process.platform,
    termGraceMs: lifecycle.termGraceMs ?? TERM_GRACE_MS,
    killGraceMs: lifecycle.killGraceMs ?? KILL_GRACE_MS,
    closeGraceMs: lifecycle.closeGraceMs ?? CLOSE_GRACE_MS,
  };
  const launch = launchForIntent(req.intent);
  const child = spawn(launch.command, launch.args, {
    cwd: req.cwd,
    env: req.env,
    stdio: ["pipe", "pipe", "pipe"],
    // A POSIX session/process-group is the ownership boundary used for timeout
    // teardown. Windows uses taskkill's explicit /T process-tree backend.
    detached: options.platform !== "win32",
  });

  const completion = new Promise<ExitOutcome>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode }));
  });
  // A timeout teardown can finish before a delayed stream/close error. Keep the
  // process promise observed even when the bounded close grace expires.
  void completion.catch(() => undefined);

  child.stdout?.on("data", (chunk: Buffer) => {
    truncated = appendCapped(stdout, chunk, req.maxOutputBytes).truncated || truncated;
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    truncated = appendCapped(stderr, chunk, req.maxOutputBytes).truncated || truncated;
  });
  if (req.stdin) child.stdin?.end(req.stdin);
  else child.stdin?.end();

  let timeout: NodeJS.Timeout | null = null;
  const deadline = new Promise<"timeout">((resolve) => {
    timeout = nodeSetTimeout(() => resolve("timeout"), req.timeoutMs);
    timeout.unref();
  });

  const first = await Promise.race([
    completion.then((outcome) => ({ kind: "exit" as const, outcome })),
    deadline.then(() => ({ kind: "timeout" as const })),
  ]);
  if (timeout) clearTimeout(timeout);

  let outcome: ExitOutcome | null;
  let timedOut = false;
  if (first.kind === "exit") {
    outcome = first.outcome;
  } else {
    timedOut = true;
    try {
      await terminateOwnedTree(child, options);
    } catch (error) {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      throw error;
    }
    outcome = await waitForClose(completion, options.closeGraceMs);
    if (!outcome) {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  }

  return {
    exitCode: outcome?.exitCode ?? null,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    durationMs: Date.now() - started,
    ...(timedOut ? { timedOut } : {}),
    ...(truncated ? { truncated } : {}),
  };
}
