export function agentLabel(kind?: string): string {
  switch (kind) {
    case "claude-code": return "Claude Code";
    case "codex": return "Codex";
    case "aider": return "Aider";
    case "opencode": return "OpenCode";
    case "test-runner": return "Tests";
    case "dev-server": return "Dev server";
    // Launch adapters register arbitrary kinds (§4.3): fall back to the kind
    // string itself rather than a generic "Shell" so new agents still read
    // sensibly. Only a truly absent kind is a plain shell.
    default: return kind && kind.length > 0 ? kind : "Shell";
  }
}
