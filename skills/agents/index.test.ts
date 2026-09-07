import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launchAgentIntoChannel: vi.fn(),
  withWorkspaceReviewRetry: vi.fn(),
}));

vi.mock("@workspace/runtime", () => ({
  contextId: "context-default",
  rpc: { call: vi.fn() },
}));

vi.mock("@workspace/agentic-core", () => ({
  launchAgentIntoChannel: mocks.launchAgentIntoChannel,
  unsubscribeAgentFromChannel: vi.fn(),
  withWorkspaceReviewRetry: mocks.withWorkspaceReviewRetry,
}));

import { addAgentToChannel, agentObjectKey } from "./index.js";

describe("addAgentToChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withWorkspaceReviewRetry.mockImplementation(async (operation: () => Promise<unknown>) =>
      operation()
    );
    mocks.launchAgentIntoChannel.mockResolvedValue({
      handle: { targetId: "do:explorer" },
      subscription: { ok: true, participantId: "participant-explorer" },
      contextId: "context-default",
    });
  });

  it("derives one stable agent entity per handle and channel", () => {
    expect(agentObjectKey(" explorer ", " channel-1 ")).toBe("explorer-channel-1");
  });

  it("delegates creation, subscription, and approval retry to the canonical lifecycle", async () => {
    await expect(
      addAgentToChannel({
        source: "workers/explorer-agent",
        className: "ExplorerAgentWorker",
        handle: "explorer",
        name: "Explorer",
        channelId: "channel-1",
        config: {
          handle: "wrong-handle",
          name: "Wrong name",
          respondPolicy: "mentioned-strict",
        },
        waitForReview: async () => undefined,
      })
    ).resolves.toEqual({
      ok: true,
      channelId: "channel-1",
      contextId: "context-default",
      targetId: "do:explorer",
      participantId: "participant-explorer",
      key: "explorer-channel-1",
    });

    expect(mocks.launchAgentIntoChannel).toHaveBeenCalledWith(
      expect.objectContaining({ call: expect.any(Function) }),
      {
        source: "workers/explorer-agent",
        className: "ExplorerAgentWorker",
        key: "explorer-channel-1",
        channelId: "channel-1",
        contextId: "context-default",
        config: {
          handle: "explorer",
          name: "Explorer",
          respondPolicy: "mentioned-strict",
        },
      }
    );
    expect(mocks.withWorkspaceReviewRetry).toHaveBeenCalledOnce();
  });

  it("launches directly when the product has no review adapter", async () => {
    await addAgentToChannel({
      source: "workers/explorer-agent",
      className: "ExplorerAgentWorker",
      handle: "explorer",
      channelId: "channel-1",
    });

    expect(mocks.launchAgentIntoChannel).toHaveBeenCalledOnce();
    expect(mocks.withWorkspaceReviewRetry).not.toHaveBeenCalled();
  });
});
