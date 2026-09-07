/**
 * useChatTools — Tool provider and approval settings builder.
 *
 * Provides raw tool method definitions (no approval middleware wrapping —
 * the DO handles approval based on channel config) and exposes the channel
 * approval level for the header control.
 */

import { useCallback, useMemo } from "react";
import type { MethodDefinition } from "@workspace/pubsub";
import { useToolApproval } from "@workspace/tool-ui";
import type { ToolApprovalProps } from "@workspace/tool-ui";
import type { SandboxOptions, SandboxResult } from "@workspace/eval";
import type { ScopeManager } from "@workspace/eval";
import type { PubSubClient } from "@workspace/pubsub";
import type { ToolProvider, ChatSandboxValue } from "../../types";
import type { ChatParticipantMetadata } from "@workspace/agentic-core";

interface UseChatToolsOptions {
  clientRef: React.RefObject<PubSubClient<ChatParticipantMetadata> | null>;
  tools?: ToolProvider;
  contextId: string;
  executeSandbox: (code: string, options?: SandboxOptions) => Promise<SandboxResult>;
  chat: ChatSandboxValue;
  scopeManager: ScopeManager;
}

export interface ChatToolsState {
  /** Build tool method definitions (raw, no approval wrapping) */
  buildToolMethods: () => Record<string, MethodDefinition>;
  /** Memoized tool approval props for UI */
  toolApprovalValue: ToolApprovalProps;
}

export function useChatTools({
  clientRef,
  tools,
  contextId,
  executeSandbox,
  chat,
  scopeManager,
}: UseChatToolsOptions): ChatToolsState {
  const approval = useToolApproval(clientRef.current as Parameters<typeof useToolApproval>[0]);

  const buildToolMethods = useCallback((): Record<string, MethodDefinition> => {
    const provided =
      tools?.({
        clientRef,
        contextId,
        executeSandbox,
        chat,
        scope: scopeManager.current,
        scopes: scopeManager.api,
      }) ?? {};
    return provided;
  }, [tools, clientRef, contextId, executeSandbox, chat, scopeManager]);

  const toolApprovalValue: ToolApprovalProps = useMemo(
    () => ({
      settings: approval.settings,
      onSetFloor: approval.setGlobalFloor,
    }),
    [approval.settings, approval.setGlobalFloor]
  );

  return {
    buildToolMethods,
    toolApprovalValue,
  };
}
