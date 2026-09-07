import * as path from "node:path";

export interface DetectedAgent {
  kind: string;
  title?: string;
}

function executableName(value: string | undefined): string {
  return value ? path.basename(value).toLowerCase() : "";
}

/**
 * Identify well-known tools from the executable and its structured arguments.
 *
 * This is display metadata only. It never rewrites a launch or activates a
 * provider. An argument or script body mentioning an agent must not turn the
 * enclosing process into that agent.
 */
export function detectAgent(argv: readonly string[]): DetectedAgent | undefined {
  const executable = executableName(argv[0]);
  switch (executable) {
    case "claude":
    case "claude-code":
      return { kind: "claude-code", title: "Claude Code" };
    case "codex":
      return { kind: "codex", title: "Codex" };
    case "aider":
      return { kind: "aider", title: "Aider" };
    case "opencode":
      return { kind: "opencode", title: "OpenCode" };
    case "vitest":
    case "jest":
      return { kind: "test-runner", title: "Tests" };
    case "vite":
      return { kind: "dev-server", title: "Dev server" };
    case "vibestudio":
      return argv[1] === "claude" ? { kind: "claude-code", title: "Claude Code" } : undefined;
    case "pnpm":
      return argv[1] === "test" ? { kind: "test-runner", title: "Tests" } : undefined;
    case "next":
      return argv[1] === "dev" ? { kind: "dev-server", title: "Dev server" } : undefined;
    case "tsx":
      return argv[1] === "watch" ? { kind: "dev-server", title: "Dev server" } : undefined;
    default:
      return undefined;
  }
}
