import type { ShellApi, SplitNode, TerminalState } from "./types.js";

export function collectPanelSessionIds(state: Pick<TerminalState, "tree">): string[] {
  const ids = new Set<string>();
  if (state.tree) collectSessionIds(state.tree, ids);
  return [...ids];
}

export function disposePanelSessions(shell: ShellApi, state: Pick<TerminalState, "tree">): void {
  for (const sessionId of collectPanelSessionIds(state)) {
    void shell.dispose?.(sessionId).catch(() => {});
  }
}

function collectSessionIds(node: SplitNode, out: Set<string>): void {
  if (node.kind === "leaf") {
    out.add(node.sessionId);
    return;
  }
  collectSessionIds(node.a, out);
  collectSessionIds(node.b, out);
}
