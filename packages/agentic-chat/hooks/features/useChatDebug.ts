import { useState } from "react";

export interface ChatDebugState {
  debugConsoleAgent: string | null;
  setDebugConsoleAgent: (agentHandle: string | null) => void;
}

/**
 * UI-only state for the chat debug console.
 *
 * Owns which agent the debug console is currently focused on — a pure
 * React/UI concern. The actual debug events stream lives on `useChatCore`.
 */
export function useChatDebug(): ChatDebugState {
  const [debugConsoleAgent, setDebugConsoleAgent] = useState<string | null>(null);
  return { debugConsoleAgent, setDebugConsoleAgent };
}
