import { describe, expect, it } from "vitest";
import { sessionExitText, sessionFooterText } from "./sessionStatus.js";
import type { SessionInfo } from "./types.js";
import { VSCODE_SHELL_INTEGRATION_META_KEY } from "./vscodeShellIntegrationMeta.js";

describe("session status presentation", () => {
  it("does not show exit text for live sessions", () => {
    expect(sessionExitText(session({ alive: true }))).toBeUndefined();
  });

  it("shows exit code or signal for exited sessions", () => {
    expect(sessionExitText(session({ alive: false, exit: { code: 0, at: 1 } }))).toBe("exited 0");
    expect(sessionExitText(session({ alive: false, exit: { code: 127, at: 1 } }))).toBe("exited 127");
    expect(sessionExitText(session({ alive: false, exit: { code: null, signal: "SIGTERM", at: 1 } }))).toBe("exited by SIGTERM");
  });

  it("adds exit status to the footer text", () => {
    expect(sessionFooterText(session({ alive: false, exit: { code: 2, at: 1 } }))).toBe("/repo · 80x24 · exited 2");
  });

  it("uses live shell integration cwd in the footer", () => {
    expect(sessionFooterText(session({
      meta: {
        [VSCODE_SHELL_INTEGRATION_META_KEY]: {
          status: "vscode",
          cwd: "/repo/packages/app",
          commandRunning: false,
          updatedAt: 1,
        },
      },
    }))).toBe("/repo/packages/app · 80x24");
  });
});

function session(patch: Partial<SessionInfo>): SessionInfo {
  return {
    sessionId: "s1",
    label: "Shell",
    command: { argv: ["/bin/sh"], cwd: "/repo" },
    cols: 80,
    rows: 24,
    alive: true,
    detectedPorts: [],
    detectedUrls: [],
    lastActivityAt: 1,
    bytesOut: 0,
    meta: {},
    ...patch,
  };
}
