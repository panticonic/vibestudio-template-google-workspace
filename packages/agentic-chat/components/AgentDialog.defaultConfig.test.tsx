// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Theme } from "@radix-ui/themes";
import type { ReactNode } from "react";
import type { AvailableAgent, ModelCatalog } from "@workspace/agentic-core";
import { makeTestCatalogEntry } from "@workspace/model-catalog/testing";
import { ChatContext } from "../context/ChatContext";
import type { ChatContextValue } from "../types";
import { AgentDialog } from "./AgentDialog";

vi.mock("@radix-ui/themes", async (importOriginal) => {
  const React = await import("react");
  const actual = await importOriginal<typeof import("@radix-ui/themes")>();
  return {
    ...actual,
    Dialog: {
      Root: ({ open, children }: { open?: boolean; children: ReactNode }) =>
        open ? React.createElement(React.Fragment, null, children) : null,
      Content: ({ children }: { children: ReactNode }) =>
        React.createElement("div", null, children),
      Title: ({ children }: { children: ReactNode }) =>
        React.createElement("h2", null, children),
      Description: ({ children }: { children: ReactNode }) =>
        React.createElement("p", null, children),
      Close: ({ children }: { children: ReactNode }) =>
        React.createElement(React.Fragment, null, children),
    },
  };
});

const AGENT: AvailableAgent = {
  id: "workers/agent-worker",
  className: "AiChatWorker",
  name: "AI Chat",
  proposedHandle: "ai-chat",
};

const CATALOG: ModelCatalog = {
  providers: [
    {
      id: "prov",
      label: "Provider",
      baseUrls: ["https://example.test"],
      recommendedModelRef: "prov:model-a",
      connectable: true,
    },
  ],
  models: [
    makeTestCatalogEntry({
      ref: "prov:model-a",
      id: "model-a",
      name: "Model A",
      provider: "prov",
      baseUrl: "https://example.test",
      reasoning: true,
      contextWindow: 1000,
      maxTokens: 100,
      thinkingLevels: ["low", "medium", "high"],
      recommended: true,
    }),
    makeTestCatalogEntry({
      ref: "prov:model-b",
      id: "model-b",
      name: "Model B",
      provider: "prov",
      baseUrl: "https://example.test",
      reasoning: true,
      contextWindow: 1000,
      maxTokens: 100,
      thinkingLevels: ["low", "medium", "high"],
    }),
  ],
};

function context(overrides: Partial<ChatContextValue> = {}): ChatContextValue {
  return {
    messages: [],
    participants: {},
    availableAgents: [AGENT],
    modelCatalog: CATALOG,
    defaultModelRef: "prov:model-a",
    onAddAgent: vi.fn(),
    onReplaceAgent: vi.fn(),
    onCallMethodResult: vi.fn(),
    ...overrides,
  } as unknown as ChatContextValue;
}

describe("AgentDialog default config", () => {
  it("applies late-arriving workspace behavior defaults before untouched add submit", async () => {
    const onAddAgent = vi.fn();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <Theme>
        <ChatContext.Provider value={context({ onAddAgent, defaultAgentConfig: null })}>
          <AgentDialog open onOpenChange={onOpenChange} />
        </ChatContext.Provider>
      </Theme>
    );

    rerender(
      <Theme>
        <ChatContext.Provider
          value={context({
            onAddAgent,
            defaultAgentConfig: {
              model: "prov:model-b",
              thinkingLevel: "high",
              approvalLevel: 1,
            },
          })}
        >
          <AgentDialog open onOpenChange={onOpenChange} />
        </ChatContext.Provider>
      </Theme>
    );

    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(onAddAgent).toHaveBeenCalledWith(
        "workers/agent-worker",
        expect.objectContaining({
          model: "prov:model-b",
          thinkingLevel: "high",
          approvalLevel: 1,
        })
      )
    );
  });
});
