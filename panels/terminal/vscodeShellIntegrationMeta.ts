import type {
  VscodeShellIntegrationEvent,
  VscodeShellIntegrationEventSource,
} from "./vscodeShellIntegration.js";
import type { SessionInfo } from "./types.js";

export const VSCODE_SHELL_INTEGRATION_META_KEY = "vscodeShellIntegration";

export type VscodeShellIntegrationMeta = {
  status: VscodeShellIntegrationEventSource;
  cwd?: string;
  commandLine?: string;
  commandRunning: boolean;
  commandStartedAt?: number;
  commandFinishedAt?: number;
  commandDurationMs?: number;
  lastExitCode?: number;
  shellEnv?: Record<string, string>;
  shellEnvUpdatedAt?: number;
  updatedAt: number;
};

export function reduceVscodeShellIntegrationMeta(
  previous: VscodeShellIntegrationMeta | undefined,
  event: VscodeShellIntegrationEvent,
  updatedAt: number
): VscodeShellIntegrationMeta {
  const next: VscodeShellIntegrationMeta = {
    status: preferStatus(previous?.status, event.source),
    cwd: previous?.cwd,
    commandLine: previous?.commandLine,
    commandRunning: previous?.commandRunning ?? false,
    commandStartedAt: previous?.commandStartedAt,
    commandFinishedAt: previous?.commandFinishedAt,
    commandDurationMs: previous?.commandDurationMs,
    lastExitCode: previous?.lastExitCode,
    shellEnv: previous?.shellEnv,
    shellEnvUpdatedAt: previous?.shellEnvUpdatedAt,
    updatedAt,
  };

  switch (event.type) {
    case "cwd":
      next.cwd = event.cwd;
      break;
    case "command-line":
      next.commandLine = event.commandLine;
      break;
    case "command-start":
    case "command-executed":
      if (!next.commandRunning) next.commandStartedAt = updatedAt;
      next.commandRunning = true;
      next.commandFinishedAt = undefined;
      next.commandDurationMs = undefined;
      next.lastExitCode = undefined;
      break;
    case "command-finished":
      next.commandRunning = false;
      next.commandFinishedAt = updatedAt;
      next.commandDurationMs = typeof next.commandStartedAt === "number"
        ? Math.max(0, updatedAt - next.commandStartedAt)
        : undefined;
      next.lastExitCode = event.exitCode;
      break;
    case "prompt-start":
      next.commandRunning = false;
      break;
    case "property":
    case "continuation-start":
    case "continuation-end":
      break;
    case "env-json":
      next.shellEnv = trimShellEnv(event.env);
      next.shellEnvUpdatedAt = updatedAt;
      break;
    case "env-single-start":
      if (event.clear) next.shellEnv = {};
      next.shellEnvUpdatedAt = updatedAt;
      break;
    case "env-single-entry":
      next.shellEnv = trimShellEnv({ ...(next.shellEnv ?? {}), [event.key]: event.value });
      next.shellEnvUpdatedAt = updatedAt;
      break;
    case "env-single-delete": {
      const { [event.key]: _removed, ...rest } = next.shellEnv ?? {};
      next.shellEnv = trimShellEnv(rest);
      next.shellEnvUpdatedAt = updatedAt;
      break;
    }
    case "env-single-end":
      next.shellEnvUpdatedAt = updatedAt;
      break;
  }

  return next;
}

export function isVscodeShellIntegrationMeta(
  value: unknown
): value is VscodeShellIntegrationMeta {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<VscodeShellIntegrationMeta>;
  return typeof candidate.status === "string"
    && typeof candidate.commandRunning === "boolean"
    && typeof candidate.updatedAt === "number";
}

export function vscodeShellIntegrationMeta(
  session: Pick<SessionInfo, "meta"> | undefined
): VscodeShellIntegrationMeta | undefined {
  if (!session) return undefined;
  const value = session.meta[VSCODE_SHELL_INTEGRATION_META_KEY];
  return isVscodeShellIntegrationMeta(value) ? value : undefined;
}

export function liveSessionCwd(
  session: Pick<SessionInfo, "command" | "meta"> | undefined
): string | undefined {
  if (!session) return undefined;
  return vscodeShellIntegrationMeta(session)?.cwd || session.command.cwd;
}

export function liveSessionCommandLine(
  session: Pick<SessionInfo, "command" | "meta"> | undefined
): string | undefined {
  if (!session) return undefined;
  return vscodeShellIntegrationMeta(session)?.commandLine || session.command.argv.join(" ");
}

export type LiveSessionCommandState =
  | { state: "running"; commandLine?: string; startedAt?: number }
  | { state: "failed"; commandLine?: string; exitCode: number; durationMs?: number }
  | { state: "idle"; commandLine?: string; exitCode?: number; durationMs?: number };

export function liveSessionCommandState(
  session: Pick<SessionInfo, "command" | "meta"> | undefined
): LiveSessionCommandState {
  const meta = vscodeShellIntegrationMeta(session);
  const commandLine = meta?.commandLine;
  if (meta?.commandRunning) return { state: "running", commandLine, startedAt: meta.commandStartedAt };
  if (typeof meta?.lastExitCode === "number" && meta.lastExitCode !== 0) {
    return {
      state: "failed",
      commandLine,
      exitCode: meta.lastExitCode,
      durationMs: meta.commandDurationMs,
    };
  }
  return {
    state: "idle",
    commandLine,
    exitCode: meta?.lastExitCode,
    durationMs: meta?.commandDurationMs,
  };
}

export function formatCommandDuration(durationMs: number | undefined): string | undefined {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) return undefined;
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function preferStatus(
  previous: VscodeShellIntegrationEventSource | undefined,
  next: VscodeShellIntegrationEventSource
): VscodeShellIntegrationEventSource {
  if (previous === "vscode" || next === "generic") return previous ?? next;
  if (next === "vscode") return next;
  if (previous === "finalTerm" && next === "iterm") return previous;
  return next;
}

function trimShellEnv(env: Record<string, string>): Record<string, string> {
  const entries = Object.entries(env)
    .filter(([key, value]) => key.length <= 80 && value.length <= 4096)
    .slice(0, 16);
  return Object.fromEntries(entries);
}
