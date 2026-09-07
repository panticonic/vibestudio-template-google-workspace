/**
 * Hook for managing tool approval workflow.
 *
 * Approval level is channel-global: it lives in channel config and applies
 * to all agents on the channel. The panel reads/writes it via
 * `updateChannelConfig({ approvalLevel })`.
 *
 * The DO receives config updates and caches the level, then applies it in
 * the harness approval gate for built-in tools.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import type { ChannelConfig } from "@workspace/pubsub";
import type { ApprovalLevel, ToolApprovalSettings, UseToolApprovalResult } from "../types";

/**
 * Approval level definitions with labels and descriptions.
 * Shared between ToolApprovalPrompt and ToolPermissionsDropdown.
 */
export const APPROVAL_LEVELS: Record<
  ApprovalLevel,
  {
    label: string;
    shortDesc: string;
    details: string[];
  }
> = {
  0: {
    label: "Ask All",
    shortDesc: "Ask before every tool call",
    details: ["Request approval for all tool calls"],
  },
  1: {
    label: "Auto-Safe",
    shortDesc: "Auto-approve read-only tools",
    details: ["Read files automatically", "Request approval for write operations"],
  },
  2: {
    label: "Full Auto",
    shortDesc: "Auto-approve all tools",
    details: ["Execute all tools automatically"],
  },
};

const DEFAULT_SETTINGS: ToolApprovalSettings = {
  globalFloor: 2, // Default: Full Auto
};

/**
 * Minimal client interface for channel config access.
 * Accepts PubSubClient.
 */
interface ConfigClient {
  channelConfig?: ChannelConfig;
  updateChannelConfig?(config: Partial<ChannelConfig>): Promise<ChannelConfig>;
  onConfigChange?(handler: (config: ChannelConfig) => void): () => void;
}

export function useToolApproval(client: ConfigClient | null): UseToolApprovalResult {
  const [settings, setSettings] = useState<ToolApprovalSettings>(DEFAULT_SETTINGS);

  // Use ref so synchronous readers see the selected level before React re-renders.
  const settingsRef = useRef<ToolApprovalSettings>(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Sync approval level from channel config
  useEffect(() => {
    if (!client?.onConfigChange) return;

    // onConfigChange fires immediately with current config if available,
    // so no separate initial read is needed.
    const unsub = client.onConfigChange((config: ChannelConfig) => {
      const level = config.approvalLevel ?? 2;
      setSettings({ globalFloor: level as ApprovalLevel });
    });

    return unsub;
  }, [client]);

  const setGlobalFloor = useCallback(
    async (level: ApprovalLevel): Promise<void> => {
      // This is a consent control, so never display a level that the channel did
      // not actually persist. An optimistic update could claim "Ask All" while
      // agents still enforce Full Auto if the write failed.
      if (!client?.updateChannelConfig) {
        throw new Error("Tool permission settings are unavailable while the channel is offline.");
      }
      const config = await client.updateChannelConfig({ approvalLevel: level });
      const persisted = config.approvalLevel;
      const nextLevel = persisted === 0 || persisted === 1 || persisted === 2 ? persisted : level;
      const nextSettings = { globalFloor: nextLevel as ApprovalLevel };
      settingsRef.current = nextSettings;
      setSettings(nextSettings);
    },
    [client]
  );

  return {
    settings,
    setGlobalFloor,
  };
}
