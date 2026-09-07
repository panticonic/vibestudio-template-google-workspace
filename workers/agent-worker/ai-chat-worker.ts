import { AgentWorkerBase } from "@workspace/agentic-do/agent-worker-base";
import type { AgentToolExecutionContext } from "@workspace/agentic-do";
import type { ParticipantDescriptor } from "@workspace/harness";
import type { AgentTool } from "@workspace/pi-core";
import type {
  AgentChannelFeatures,
  AgentResourceBinding,
  AgentToolBinding,
} from "@workspace/agentic-core";
import { createPanelDescribeTool } from "./panel-describe-tool.js";
import {
  createPanelCdpEndpointTool,
  createPanelConsoleTool,
  createPanelEvalTool,
  createPanelScreenshotTool,
} from "./panel-debug-tools.js";

type ChatAgentConfig = {
  handle?: string;
  name?: string;
  systemPrompt?: string;
  systemPromptMode?: "replace" | "append";
  respondPolicy?: "all" | "mentioned" | "mentioned-strict" | "from-participants";
  respondFrom?: string[];
};

function asChatAgentConfig(config: unknown): ChatAgentConfig {
  return config && typeof config === "object" ? (config as ChatAgentConfig) : {};
}

/**
 * AiChatWorker — The default AI chat Durable Object.
 *
 * Pi-native: embeds `@workspace/pi-core`'s `Agent` in-process via
 * the `PiRunner` harness (see `AgentWorkerBase`). The system prompt is
 * loaded from `meta/AGENTS.md` via the workspace.* RPC service;
 * skill metadata is merged in from each skill's SKILL.md.
 *
 * The model, thinking level, and approval level can be customized via the
 * `getModel`/`getThinkingLevel`/`getApprovalLevel` overridable hooks. The
 * default is `openai-codex:gpt-5.6-sol` at "medium" thinking. Provider-tool
 * review settings are independent from the host capability system: protected
 * effects are always admitted by host authority and surfaced out of band when
 * a grant is required. Model credentials are URL-bound and injected by the
 * host egress path after capability admission.
 */
export class AiChatWorker extends AgentWorkerBase {
  static override schemaVersion = AgentWorkerBase.schemaVersion;

  private channelFeatures(channelId: string): AgentChannelFeatures | null {
    const value = this.subscriptions.getConfig(channelId)?.features;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as AgentChannelFeatures)
      : null;
  }

  private resource(
    channelId: string,
    resourceKey: string | undefined,
    expectedKind: string
  ): AgentResourceBinding {
    if (!resourceKey) throw new Error(`${expectedKind} requires a resource binding`);
    const value = this.channelFeatures(channelId)?.resources?.[resourceKey];
    if (!value || value.kind !== expectedKind || typeof value.id !== "string" || !value.id) {
      throw new Error(
        `Agent resource ${JSON.stringify(resourceKey)} is not a valid ${expectedKind} binding`
      );
    }
    return value;
  }

  protected override getParticipantInfo(
    _channelId: string,
    config?: unknown
  ): ParticipantDescriptor {
    const cfg = asChatAgentConfig(config);
    return {
      handle: cfg.handle ?? "ai-chat",
      name: cfg.name ?? "AI Chat",
      type: "agent",
      metadata: {},
      methods: this.getStandardAgentMethods(),
    };
  }

  protected override async loadPromptResources(channelId: string) {
    // A replacement prompt is complete by definition. Avoid loading workspace
    // prompt resources that composeSystemPrompt will intentionally discard.
    return this.subscriptions.getConfig(channelId)?.systemPromptMode === "replace"
      ? {}
      : super.loadPromptResources(channelId);
  }

  protected override async getLoopTools(
    channelId: string,
    execution?: AgentToolExecutionContext
  ): Promise<AgentTool[]> {
    const configured = this.channelFeatures(channelId)?.tools;
    if (configured === undefined) return super.getLoopTools(channelId, execution);
    if (!Array.isArray(configured)) throw new Error("Agent tools must be an array");
    for (const binding of configured) {
      if (!binding || typeof binding.kind !== "string") {
        throw new Error("Agent tool binding requires a kind");
      }
    }

    const toolRpc = execution?.rpc ?? this.rpc;
    const callMain = <T>(method: string, args: unknown[]) =>
      toolRpc.call<T>("main", method, args);
    const panelSlot = (binding: AgentToolBinding) =>
      this.resource(channelId, binding.resource, "panel-slot").id;
    const needsStandardTools = configured.some(
      (binding) =>
        binding?.kind === "standard" || binding?.kind.startsWith("standard.")
    );
    const standardTools = needsStandardTools
      ? await super.getLoopTools(channelId, execution)
      : [];
    const standardByName = new Map(standardTools.map((tool) => [tool.name, tool]));
    const selected: AgentTool[] = [];
    const selectedNames = new Set<string>();
    for (const binding of configured) {
      let tools: AgentTool[];
      switch (binding.kind) {
        case "standard":
          tools = standardTools;
          break;
        case "panel.describe":
          tools = [createPanelDescribeTool(callMain, panelSlot(binding))];
          break;
        case "panel.screenshot":
          tools = [createPanelScreenshotTool(callMain, panelSlot(binding))];
          break;
        case "panel.console":
          tools = [createPanelConsoleTool(callMain, panelSlot(binding))];
          break;
        case "panel.evaluate":
          tools = [createPanelEvalTool(callMain, panelSlot(binding))];
          break;
        case "panel.cdp":
          tools = [createPanelCdpEndpointTool(callMain, panelSlot(binding))];
          break;
        default:
          if (binding.kind.startsWith("standard.")) {
            const name = binding.kind.slice("standard.".length);
            const tool = standardByName.get(name);
            if (!name || !tool) {
              throw new Error(`Unknown standard agent tool: ${JSON.stringify(name)}`);
            }
            tools = [tool];
            break;
          }
          throw new Error(`Unsupported agent tool kind: ${binding.kind}`);
      }
      for (const tool of tools) {
        if (selectedNames.has(tool.name)) {
          throw new Error(`Agent tool selected more than once: ${tool.name}`);
        }
        selectedNames.add(tool.name);
        selected.push(tool);
      }
    }
    return selected;
  }
}
