import { extensions } from "@workspace/runtime";
import type {} from "@workspace-extensions/shell";
import { useEffect, useMemo } from "react";
import { SessionStore, sessionIdsConnectKey, useAllSessions } from "./SessionStore.js";
import type { SessionInfo, ShellApi } from "./types.js";

const SHELL_EXTENSION = "@workspace-extensions/shell";

export function useShellExtension(): ShellApi {
  // Streaming methods are declared by the shell extension's manifest and
  // resolved by the client; no call-site declaration needed.
  return useMemo(() => extensions.use(SHELL_EXTENSION), []);
}

export function useAllSessionInfo(shell: ShellApi, sessionIds: string[] = []): Record<string, SessionInfo> {
  const store = useMemo(() => new SessionStore(), []);
  const connectKey = sessionIdsConnectKey(sessionIds);
  useEffect(() => store.connect(shell, connectKey ? connectKey.split("\0") : []), [connectKey, shell, store]);
  return useAllSessions(store);
}
