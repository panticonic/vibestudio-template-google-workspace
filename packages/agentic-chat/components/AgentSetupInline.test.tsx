// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalog } from "@workspace/agentic-core";
import { makeTestCatalogEntry } from "@workspace/model-catalog/testing";
import { AgentSetupInline } from "./AgentSetupInline";

const model = makeTestCatalogEntry({
  ref: "openai-codex:gpt-5.6-sol",
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: false,
  availability: { state: "needs-setup", detail: "no-credential" },
});

const chatContext = {
  deferredAgent: {
    draft: { model: model.ref, approvalLevel: 2 },
    setDraft: vi.fn(),
    modelSelectionRequired: true,
    startQueued: vi.fn(),
    queued: [{ id: "opening", text: "Help me get onboarded", tier: "secondary" }],
  },
  modelCatalog: {
    providers: [
      {
        id: "openai-codex",
        label: "GPT Codex",
        recommendedModelRef: model.ref,
      },
    ],
    models: [model],
  } as ModelCatalog,
  defaultAgentConfig: { model: model.ref, approvalLevel: 2 },
  onSaveDefaults: vi.fn(),
  onInstallLocalModel: undefined,
  onOpenLocalModels: undefined,
  onOpenLocalModelsLog: undefined,
};

vi.mock("../context/ChatContext", () => ({
  useChatContext: () => chatContext,
}));

describe("AgentSetupInline", () => {
  it("starts a connectable agent and leaves credential setup to that agent", () => {
    render(
      <Theme>
        <AgentSetupInline />
      </Theme>
    );

    expect(screen.getByRole("heading", { name: "Choose how to run your agent" })).toBeTruthy();
    expect(screen.getAllByText("GPT-5.6 Sol").length).toBeGreaterThan(0);
    expect(screen.getByRole("combobox", { name: "Provider" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Model" })).toBeTruthy();
    expect(screen.getByText("Recommended for this workspace")).toBeTruthy();
    expect(screen.queryByText(/show|hide/i)).toBeNull();
    expect(screen.queryByText(/connect gpt codex/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Use system browser" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start agent" })).toBeTruthy();
    expect(screen.queryByText("Autonomy")).toBeNull();

    fireEvent.click(screen.getByText("▸ Advanced"));
    expect(screen.getByText("Autonomy")).toBeTruthy();
  });
});
