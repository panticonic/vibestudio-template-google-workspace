import { describe, expect, it } from "vitest";
import {
  formatCommandDuration,
  liveSessionCommandLine,
  liveSessionCommandState,
  liveSessionCwd,
  reduceVscodeShellIntegrationMeta,
  VSCODE_SHELL_INTEGRATION_META_KEY,
} from "./vscodeShellIntegrationMeta.js";

describe("reduceVscodeShellIntegrationMeta", () => {
  it("tracks cwd, command line, running state, and exit code", () => {
    const cwd = reduceVscodeShellIntegrationMeta(undefined, {
      type: "cwd",
      source: "vscode",
      cwd: "/repo",
    }, 1);
    const commandLine = reduceVscodeShellIntegrationMeta(cwd, {
      type: "command-line",
      source: "vscode",
      commandLine: "pnpm test",
    }, 2);
    const running = reduceVscodeShellIntegrationMeta(commandLine, {
      type: "command-start",
      source: "vscode",
    }, 3);
    const finished = reduceVscodeShellIntegrationMeta(running, {
      type: "command-finished",
      source: "vscode",
      exitCode: 1,
    }, 4);

    expect(finished).toEqual({
      status: "vscode",
      cwd: "/repo",
      commandLine: "pnpm test",
      commandRunning: false,
      commandStartedAt: 3,
      commandFinishedAt: 4,
      commandDurationMs: 1,
      lastExitCode: 1,
      updatedAt: 4,
    });
  });

  it("keeps VS Code shell integration as the strongest observed status", () => {
    const vscode = reduceVscodeShellIntegrationMeta(undefined, {
      type: "prompt-start",
      source: "vscode",
    }, 1);
    const iterm = reduceVscodeShellIntegrationMeta(vscode, {
      type: "cwd",
      source: "iterm",
      cwd: "/tmp",
    }, 2);

    expect(iterm.status).toBe("vscode");
    expect(iterm.cwd).toBe("/tmp");
  });

  it("reads live cwd and command line from session metadata before launch values", () => {
    const session = {
      command: { argv: ["/bin/sh"], cwd: "/launch" },
      meta: {
        [VSCODE_SHELL_INTEGRATION_META_KEY]: {
          status: "vscode",
          cwd: "/live",
          commandLine: "pnpm dev",
          commandRunning: true,
          updatedAt: 1,
        },
      },
    };

    expect(liveSessionCwd(session)).toBe("/live");
    expect(liveSessionCommandLine(session)).toBe("pnpm dev");
  });

  it("derives live command running and failed states", () => {
    expect(liveSessionCommandState({
      command: { argv: ["/bin/sh"], cwd: "/repo" },
      meta: {
        [VSCODE_SHELL_INTEGRATION_META_KEY]: {
          status: "vscode",
          commandLine: "pnpm test",
          commandRunning: true,
          updatedAt: 1,
        },
      },
    })).toEqual({ state: "running", commandLine: "pnpm test", startedAt: undefined });

    expect(liveSessionCommandState({
      command: { argv: ["/bin/sh"], cwd: "/repo" },
      meta: {
        [VSCODE_SHELL_INTEGRATION_META_KEY]: {
          status: "vscode",
          commandLine: "pnpm test",
          commandRunning: false,
          commandDurationMs: 1234,
          lastExitCode: 2,
          updatedAt: 2,
        },
      },
    })).toEqual({ state: "failed", commandLine: "pnpm test", exitCode: 2, durationMs: 1234 });
  });

  it("formats command durations compactly", () => {
    expect(formatCommandDuration(undefined)).toBeUndefined();
    expect(formatCommandDuration(250)).toBe("250ms");
    expect(formatCommandDuration(1234)).toBe("1.2s");
    expect(formatCommandDuration(12_100)).toBe("12s");
    expect(formatCommandDuration(65_000)).toBe("1m 5s");
  });

  it("tracks compact shell environment reports from VS Code sequences", () => {
    const fromJson = reduceVscodeShellIntegrationMeta(undefined, {
      type: "env-json",
      source: "vscode",
      env: { PATH: "/bin", NODE_ENV: "test" },
    }, 1);
    const cleared = reduceVscodeShellIntegrationMeta(fromJson, {
      type: "env-single-start",
      source: "vscode",
      clear: true,
    }, 2);
    const withEntry = reduceVscodeShellIntegrationMeta(cleared, {
      type: "env-single-entry",
      source: "vscode",
      key: "VIRTUAL_ENV",
      value: "/repo/.venv",
    }, 3);
    const deleted = reduceVscodeShellIntegrationMeta(withEntry, {
      type: "env-single-delete",
      source: "vscode",
      key: "VIRTUAL_ENV",
    }, 4);

    expect(fromJson.shellEnv).toEqual({ PATH: "/bin", NODE_ENV: "test" });
    expect(cleared.shellEnv).toEqual({});
    expect(withEntry.shellEnv).toEqual({ VIRTUAL_ENV: "/repo/.venv" });
    expect(deleted.shellEnv).toEqual({});
    expect(deleted.shellEnvUpdatedAt).toBe(4);
  });
});
