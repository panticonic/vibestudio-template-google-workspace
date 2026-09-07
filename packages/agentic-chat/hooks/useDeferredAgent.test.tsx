// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Participant } from "@workspace/pubsub";
import type { AvailableAgent, ModelCatalog } from "@workspace/agentic-core";
import { makeTestCatalogEntry } from "@workspace/model-catalog/testing";
import { AGENT_LAUNCH_WATCHDOG_MS, useDeferredAgent } from "./useDeferredAgent";
import type { ChatParticipantMetadata } from "../types";

const WORKSPACE_MODEL = "openai-codex:gpt-5.6-sol";
const PANEL_MODEL = "openai-codex:gpt-5.3-codex-spark";
const USER_MODEL = "anthropic:claude-sonnet-4-6";

const AGENT: AvailableAgent = {
  id: "workers/agent-worker",
  className: "AiChatWorker",
  name: "AI Chat",
  proposedHandle: "ai-chat",
};

const MODEL_CATALOG: ModelCatalog = {
  providers: [],
  models: [
    makeTestCatalogEntry({
      ref: WORKSPACE_MODEL,
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
    }),
    makeTestCatalogEntry({
      ref: PANEL_MODEL,
      id: "gpt-5.3-codex-spark",
      name: "GPT-5.3 Codex Spark",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
    }),
  ],
};

const agentRoster = {
  "do:workers/agent-worker:AiChatWorker:ai-chat-1": {
    id: "do:workers/agent-worker:AiChatWorker:ai-chat-1",
    metadata: { name: "AI Chat", type: "agent", handle: "ai-chat" },
  },
} as unknown as Record<string, Participant<ChatParticipantMetadata>>;

interface Mocks {
  clearComposer: ReturnType<typeof vi.fn>;
  publishText: ReturnType<typeof vi.fn>;
  maybeSetDefaultTitle: ReturnType<typeof vi.fn>;
  coreSendMessage: ReturnType<typeof vi.fn>;
  onAddAgent?: ReturnType<typeof vi.fn>;
}

function freshMocks(withAdd = true): Mocks {
  return {
    clearComposer: vi.fn(),
    publishText: vi.fn().mockResolvedValue(undefined),
    maybeSetDefaultTitle: vi.fn(),
    coreSendMessage: vi.fn().mockResolvedValue(undefined),
    onAddAgent: withAdd ? vi.fn() : undefined,
  };
}

type Params = Parameters<typeof useDeferredAgent>[0];

function makeParams(m: Mocks, over: Partial<Params> = {}): Params {
  return {
    participants: {},
    pendingAgents: new Map(),
    input: "",
    clearComposer: m.clearComposer,
    publishText: m.publishText,
    maybeSetDefaultTitle: m.maybeSetDefaultTitle,
    coreSendMessage: m.coreSendMessage,
    onAddAgent: m.onAddAgent,
    availableAgents: [AGENT],
    modelCatalog: null,
    defaultModelRef: null,
    firstAgentChannelIsNew: true,
    channelName: "chat-test",
    messages: [],
    replaySettled: true,
    ...over,
  };
}

describe("useDeferredAgent", () => {
  it("arms the inline setup when no agent is present and one can be created", () => {
    const m = freshMocks();
    const { result } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m),
    });
    expect(result.current.deferredAgent?.setupActive).toBe(true);
    expect(result.current.deferredAgent?.active).toBe(true);
    expect(result.current.deferredAgent?.launching).toBe(false);
  });

  it("prepares the default agent before send and updates the provisional intent with the draft", async () => {
    const m = freshMocks();
    const onPrepareAgent = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, {
        modelCatalog: MODEL_CATALOG,
        defaultModelRef: WORKSPACE_MODEL,
        defaultAgentConfig: { model: WORKSPACE_MODEL, approvalLevel: 2 },
        onPrepareAgent,
      }),
    });

    await waitFor(() =>
      expect(onPrepareAgent).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ model: WORKSPACE_MODEL, approvalLevel: 2 })
      )
    );
    expect(m.onAddAgent).not.toHaveBeenCalled();

    act(() => {
      result.current.deferredAgent?.setDraft({
        ...result.current.deferredAgent.draft,
        model: PANEL_MODEL,
      });
    });
    await waitFor(() =>
      expect(onPrepareAgent).toHaveBeenLastCalledWith(
        undefined,
        expect.objectContaining({ model: PANEL_MODEL })
      )
    );

    rerender(
      makeParams(m, {
        participants: agentRoster,
        modelCatalog: MODEL_CATALOG,
        defaultModelRef: WORKSPACE_MODEL,
        defaultAgentConfig: { model: WORKSPACE_MODEL, approvalLevel: 2 },
        onPrepareAgent,
      })
    );
    await waitFor(() => expect(onPrepareAgent).toHaveBeenLastCalledWith(undefined, null));
  });

  it("prepares a host-minted new channel without waiting for replay", async () => {
    const m = freshMocks();
    const onPrepareAgent = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, {
        replaySettled: false,
        firstAgentChannelIsNew: true,
        modelCatalog: MODEL_CATALOG,
        defaultModelRef: WORKSPACE_MODEL,
        defaultAgentConfig: { model: WORKSPACE_MODEL },
        onPrepareAgent,
      }),
    });

    await waitFor(() =>
      expect(onPrepareAgent).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ model: WORKSPACE_MODEL })
      )
    );
    expect(result.current.deferredAgent?.setupActive ?? false).toBe(false);
    expect(m.onAddAgent).not.toHaveBeenCalled();
  });

  it("queues the first message, spawns exactly one agent, and never double-spawns", async () => {
    const m = freshMocks();
    const { result } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, { input: "hello" }),
    });

    await act(async () => {
      await result.current.sendMessage();
    });
    expect(m.clearComposer).toHaveBeenCalledTimes(1);
    expect(m.onAddAgent).toHaveBeenCalledTimes(1);
    expect(m.coreSendMessage).not.toHaveBeenCalled();
    expect(result.current.deferredAgent?.queued.map((q) => q.text)).toEqual(["hello"]);
    expect(result.current.deferredAgent?.launching).toBe(true);

    // A second send before the agent joins enqueues but must not spawn again.
    await act(async () => {
      await result.current.sendMessage();
    });
    expect(m.onAddAgent).toHaveBeenCalledTimes(1);
    expect(result.current.deferredAgent?.queued.length).toBe(2);
  });

  it("turns an acknowledged-but-stuck launch into a retriable failure", async () => {
    vi.useFakeTimers();
    const m = freshMocks();
    const { result } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, { input: "hello" }),
    });
    await act(async () => result.current.sendMessage());
    await act(async () => vi.advanceTimersByTimeAsync(AGENT_LAUNCH_WATCHDOG_MS));
    expect(result.current.deferredAgent?.launchFailed).toBe(true);
    vi.useRealTimers();
  });

  it("flushes the queue live when an agent joins, then stands down", async () => {
    const m = freshMocks();
    const { result, rerender } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, { input: "hello" }),
    });
    await act(async () => {
      await result.current.sendMessage();
    });
    expect(result.current.deferredAgent?.queued.length).toBe(1);

    // Agent joins the roster → the held message flushes live via publishText.
    rerender(makeParams(m, { input: "", participants: agentRoster }));
    await waitFor(() => expect(m.publishText).toHaveBeenCalledTimes(1));
    expect(m.publishText).toHaveBeenCalledWith("hello", expect.objectContaining({}));
    // Brand-new chat (empty transcript) → the first message titles the channel.
    expect(m.maybeSetDefaultTitle).toHaveBeenCalledWith("hello");
    await waitFor(() => expect(result.current.deferredAgent).toBeUndefined());
  });

  it("does not title the chat until the first queued message is successfully published", async () => {
    const m = freshMocks();
    let resolvePublish!: () => void;
    m.publishText = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePublish = resolve;
        })
    );
    const { result, rerender } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, { input: "hello" }),
    });
    await act(async () => {
      await result.current.sendMessage();
    });

    rerender(makeParams(m, { input: "", participants: agentRoster }));
    await waitFor(() => expect(m.publishText).toHaveBeenCalledTimes(1));
    expect(m.maybeSetDefaultTitle).not.toHaveBeenCalled();

    await act(async () => {
      resolvePublish();
    });
    await waitFor(() => expect(m.maybeSetDefaultTitle).toHaveBeenCalledWith("hello"));
  });

  it("skips queued messages canceled before their flush turn begins", async () => {
    const m = freshMocks();
    let resolveFirst!: () => void;
    m.publishText = vi.fn().mockImplementation((text: string) => {
      if (text === "first") {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve();
    });
    const { result, rerender } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, { input: "first" }),
    });

    await act(async () => {
      await result.current.sendMessage();
    });
    rerender(makeParams(m, { input: "second" }));
    await act(async () => {
      await result.current.sendMessage();
    });
    expect(result.current.deferredAgent?.queued.map((q) => q.text)).toEqual(["first", "second"]);

    rerender(makeParams(m, { input: "", participants: agentRoster }));
    await waitFor(() => expect(m.publishText).toHaveBeenCalledWith("first", expect.any(Object)));
    const second = result.current.deferredAgent?.queued.find((q) => q.text === "second");
    expect(second).toBeTruthy();
    act(() => {
      result.current.deferredAgent?.cancelQueued(second!.id);
    });

    await act(async () => {
      resolveFirst();
    });
    await waitFor(() => expect(result.current.deferredAgent).toBeUndefined());
    expect(m.publishText).toHaveBeenCalledTimes(1);
  });

  it("falls through to the normal send when the host cannot create agents", async () => {
    const m = freshMocks(false); // no onAddAgent
    const { result } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, { input: "hi" }),
    });
    expect(result.current.deferredAgent).toBeUndefined();
    await act(async () => {
      await result.current.sendMessage();
    });
    expect(m.coreSendMessage).toHaveBeenCalledTimes(1);
    expect(m.publishText).not.toHaveBeenCalled();
  });

  it("does not strand an initialPrompt in the deferred queue when the host cannot create agents", () => {
    const m = freshMocks(false); // no onAddAgent; useAgenticChat leaves initialPrompt to useChatCore
    const { result } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, { initialPrompt: "do the thing", replaySettled: true }),
    });
    expect(result.current.deferredAgent).toBeUndefined();
    expect(m.publishText).not.toHaveBeenCalled();
  });

  it("routes an initialPrompt through the same queue once connected", async () => {
    const m = freshMocks();
    const { result, rerender } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, {
        initialPrompt: "do the thing",
        replaySettled: false,
        firstAgentChannelIsNew: true,
      }),
    });
    // Replay not settled yet → nothing queued; setup card suppressed by the prompt.
    expect(result.current.deferredAgent?.queued.length ?? 0).toBe(0);
    expect(result.current.deferredAgent?.setupActive ?? false).toBe(false);

    // Replay settles → the prompt enqueues and spawns one agent.
    rerender(
      makeParams(m, {
        initialPrompt: "do the thing",
        replaySettled: true,
        firstAgentChannelIsNew: true,
      })
    );
    await waitFor(() => expect(m.onAddAgent).toHaveBeenCalledTimes(1));
    expect(result.current.deferredAgent?.queued.map((q) => q.text)).toEqual(["do the thing"]);
  });

  it("does not replay an opening prompt or launch an agent when an existing panel remounts", async () => {
    const m = freshMocks();
    const failedInstalledAgent = new Map([
      [
        "ai-chat",
        {
          agentId: AGENT.id,
          status: "error" as const,
          error: { message: "Existing agent is still rehydrating" },
        },
      ],
    ]);
    const { result } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, {
        initialPrompt: "help me get onboarded",
        replaySettled: true,
        messages: [],
        pendingAgents: failedInstalledAgent,
        firstAgentChannelIsNew: false,
      }),
    });

    await act(async () => Promise.resolve());

    expect(result.current.deferredAgent).toBeUndefined();
    expect(m.onAddAgent).not.toHaveBeenCalled();
    expect(m.publishText).not.toHaveBeenCalled();
  });

  it("delivers a forced prompt to an existing agent without launching another one", async () => {
    const m = freshMocks();
    const recoveringAgent = new Map([
      ["ai-chat", { agentId: AGENT.id, status: "starting" as const }],
    ]);
    const existingChannel = {
      initialPrompt: "continue on the fork",
      forceInitialPrompt: true,
      firstAgentChannelIsNew: false,
    };
    const { result, rerender } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, {
        ...existingChannel,
        pendingAgents: recoveringAgent,
      }),
    });

    await waitFor(() => expect(result.current.deferredAgent?.queued).toHaveLength(1));
    expect(m.onAddAgent).not.toHaveBeenCalled();

    rerender(
      makeParams(m, {
        ...existingChannel,
        participants: agentRoster,
        messages: [{ id: "prior", senderId: "u", content: "prior turn" } as never],
      })
    );

    await waitFor(() => expect(m.publishText).toHaveBeenCalledTimes(1));
    expect(m.publishText).toHaveBeenCalledWith(
      "continue on the fork",
      expect.objectContaining({ idempotencyKey: "initial-prompt:chat-test" })
    );
    expect(m.onAddAgent).not.toHaveBeenCalled();
  });

  it("holds an initialPrompt for explicit model selection before launching", async () => {
    const m = freshMocks();
    const { result } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, {
        initialPrompt: "help me get onboarded",
        modelCatalog: MODEL_CATALOG,
        defaultModelRef: WORKSPACE_MODEL,
        defaultAgentConfig: { model: WORKSPACE_MODEL },
        firstAgentModelPreflight: "selection-required",
      }),
    });

    await waitFor(() =>
      expect(result.current.deferredAgent?.queued.map((q) => q.text)).toEqual([
        "help me get onboarded",
      ])
    );
    expect(result.current.deferredAgent?.setupActive).toBe(true);
    expect(result.current.deferredAgent?.modelSelectionRequired).toBe(true);
    expect(m.onAddAgent).not.toHaveBeenCalled();

    act(() => result.current.deferredAgent?.startQueued());

    await waitFor(() => expect(m.onAddAgent).toHaveBeenCalledTimes(1));
    expect(m.onAddAgent).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ model: WORKSPACE_MODEL })
    );
  });

  it("cannot start a queued conversation with a model that still needs setup", async () => {
    const m = freshMocks();
    const unavailableCatalog: ModelCatalog = {
      providers: [],
      models: [
        makeTestCatalogEntry({
          ref: "local:lfm2.5-2.6b",
          id: "lfm2.5-2.6b",
          name: "LFM2.5 2.6B",
          provider: "local",
          baseUrl: "http://127.0.0.1:0/v1",
          availability: { state: "needs-setup", detail: "not-installed" },
        }),
      ],
    };
    const { result } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, {
        initialPrompt: "help me get onboarded",
        modelCatalog: unavailableCatalog,
        defaultModelRef: "local:lfm2.5-2.6b",
        defaultAgentConfig: { model: "local:lfm2.5-2.6b" },
        firstAgentModelPreflight: "selection-required",
      }),
    });

    await waitFor(() => expect(result.current.deferredAgent?.queued).toHaveLength(1));
    act(() => result.current.deferredAgent?.startQueued());

    expect(m.onAddAgent).not.toHaveBeenCalled();
    expect(result.current.deferredAgent?.launching).toBe(false);
  });

  it("launches a connectable cloud agent before its credential is configured", async () => {
    const m = freshMocks();
    const needsSetupCatalog: ModelCatalog = {
      providers: [],
      models: [
        makeTestCatalogEntry({
          ref: WORKSPACE_MODEL,
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai-codex",
          baseUrl: "https://chatgpt.com/backend-api",
          availability: { state: "needs-setup", detail: "no-credential" },
        }),
      ],
    };
    const configured = {
      initialPrompt: "help me get onboarded",
      defaultModelRef: WORKSPACE_MODEL,
      defaultAgentConfig: { model: WORKSPACE_MODEL },
    };
    const { result } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, {
        ...configured,
        modelCatalog: needsSetupCatalog,
        firstAgentModelPreflight: "selection-required",
      }),
    });

    await waitFor(() => expect(result.current.deferredAgent?.queued).toHaveLength(1));
    expect(result.current.deferredAgent?.setupActive).toBe(true);
    expect(m.onAddAgent).not.toHaveBeenCalled();

    act(() => result.current.deferredAgent?.startQueued());

    await waitFor(() => expect(m.onAddAgent).toHaveBeenCalledTimes(1));
    expect(m.onAddAgent).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ model: WORKSPACE_MODEL })
    );
  });

  it("waits for model discovery before auto-launching an initialPrompt", async () => {
    const m = freshMocks();
    const configured = {
      initialPrompt: "help me get onboarded",
      modelCatalog: MODEL_CATALOG,
      defaultModelRef: WORKSPACE_MODEL,
      defaultAgentConfig: { model: WORKSPACE_MODEL },
    };
    const { result, rerender } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, {
        ...configured,
        firstAgentModelPreflight: "checking",
      }),
    });

    await waitFor(() => expect(result.current.deferredAgent?.queued).toHaveLength(1));
    expect(m.onAddAgent).not.toHaveBeenCalled();
    expect(result.current.deferredAgent?.modelDiscoveryPending).toBe(true);

    rerender(
      makeParams(m, {
        ...configured,
        firstAgentModelPreflight: "ready",
      })
    );
    await waitFor(() => expect(m.onAddAgent).toHaveBeenCalledTimes(1));
    expect(result.current.deferredAgent?.modelDiscoveryPending).toBe(false);
  });

  it("launches an initialPrompt with the effective panel model when the catalog loads first", async () => {
    const m = freshMocks();
    const configured = {
      initialPrompt: "run system tests",
      modelCatalog: MODEL_CATALOG,
      defaultModelRef: WORKSPACE_MODEL,
      defaultAgentConfig: { model: PANEL_MODEL },
    };
    const { rerender } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, {
        ...configured,
        availableAgents: [],
        replaySettled: false,
      }),
    });

    // Model settings arrive before the agent gallery. Once the gallery and
    // replay are ready, the deferred auto-spawn must retain the panel override.
    rerender(
      makeParams(m, {
        ...configured,
        availableAgents: [AGENT],
        replaySettled: true,
      })
    );

    await waitFor(() => expect(m.onAddAgent).toHaveBeenCalledTimes(1));
    expect(m.onAddAgent).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ model: PANEL_MODEL })
    );
  });

  it("launches an initialPrompt with the panel model before the catalog loads", async () => {
    const m = freshMocks();
    const { rerender } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, {
        initialPrompt: "run system tests",
        availableAgents: [AGENT],
        modelCatalog: null,
        defaultModelRef: null,
        defaultAgentConfig: { model: PANEL_MODEL },
        replaySettled: true,
      }),
    });

    await waitFor(() => expect(m.onAddAgent).toHaveBeenCalledTimes(1));
    expect(m.onAddAgent).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ model: PANEL_MODEL })
    );

    // A later catalog refresh must neither replace the snapshotted intent nor
    // issue a second launch.
    rerender(
      makeParams(m, {
        initialPrompt: "run system tests",
        availableAgents: [AGENT],
        modelCatalog: MODEL_CATALOG,
        defaultModelRef: WORKSPACE_MODEL,
        defaultAgentConfig: { model: PANEL_MODEL },
        replaySettled: true,
      })
    );
    await act(async () => Promise.resolve());
    expect(m.onAddAgent).toHaveBeenCalledTimes(1);
  });

  it("updates an untouched draft when the effective model arrives after the catalog", async () => {
    const m = freshMocks();
    const { rerender } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, {
        initialPrompt: "run system tests",
        availableAgents: [],
        modelCatalog: MODEL_CATALOG,
        defaultModelRef: WORKSPACE_MODEL,
        defaultAgentConfig: null,
        replaySettled: true,
      }),
    });

    // The prompt is already armed while the gallery is unavailable. The panel
    // override and gallery then arrive together, which used to launch the stale
    // catalog default because a non-empty draft was never reseeded.
    rerender(
      makeParams(m, {
        initialPrompt: "run system tests",
        availableAgents: [AGENT],
        modelCatalog: MODEL_CATALOG,
        defaultModelRef: WORKSPACE_MODEL,
        defaultAgentConfig: { model: PANEL_MODEL },
        replaySettled: true,
      })
    );

    await waitFor(() => expect(m.onAddAgent).toHaveBeenCalledTimes(1));
    expect(m.onAddAgent).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ model: PANEL_MODEL })
    );
  });

  it("preserves a user-selected model when effective defaults arrive late", async () => {
    const m = freshMocks();
    const { result, rerender } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, {
        input: "run system tests",
        modelCatalog: MODEL_CATALOG,
        defaultModelRef: WORKSPACE_MODEL,
        defaultAgentConfig: null,
      }),
    });
    await waitFor(() => expect(result.current.deferredAgent?.draft.model).toBe(WORKSPACE_MODEL));

    act(() => {
      const current = result.current.deferredAgent!.draft;
      result.current.deferredAgent!.setDraft({ ...current, model: USER_MODEL });
    });
    rerender(
      makeParams(m, {
        input: "run system tests",
        modelCatalog: MODEL_CATALOG,
        defaultModelRef: WORKSPACE_MODEL,
        defaultAgentConfig: { model: PANEL_MODEL },
      })
    );

    await act(async () => {
      await result.current.sendMessage();
    });
    expect(m.onAddAgent).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ model: USER_MODEL })
    );
  });

  it("applies a late effective model when the user only touched another field", async () => {
    const m = freshMocks();
    const { result, rerender } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, {
        input: "run system tests",
        modelCatalog: MODEL_CATALOG,
        defaultModelRef: WORKSPACE_MODEL,
        defaultAgentConfig: null,
      }),
    });
    await waitFor(() => expect(result.current.deferredAgent?.draft.model).toBe(WORKSPACE_MODEL));

    act(() => {
      const current = result.current.deferredAgent!.draft;
      result.current.deferredAgent!.setDraft({ ...current, approvalLevel: 1 });
    });
    rerender(
      makeParams(m, {
        input: "run system tests",
        modelCatalog: MODEL_CATALOG,
        defaultModelRef: WORKSPACE_MODEL,
        defaultAgentConfig: { model: PANEL_MODEL },
      })
    );
    await waitFor(() => expect(result.current.deferredAgent?.draft.model).toBe(PANEL_MODEL));

    await act(async () => {
      await result.current.sendMessage();
    });
    expect(m.onAddAgent).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ model: PANEL_MODEL, approvalLevel: 1 })
    );
  });

  it("retries an initialPrompt with the exact model used by its first launch attempt", async () => {
    const m = freshMocks();
    m.onAddAgent = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("launch failed");
      })
      .mockResolvedValueOnce(undefined);
    const { result, rerender } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, {
        initialPrompt: "run system tests",
        modelCatalog: MODEL_CATALOG,
        defaultModelRef: WORKSPACE_MODEL,
        defaultAgentConfig: { model: PANEL_MODEL },
      }),
    });
    await waitFor(() => expect(result.current.deferredAgent?.launchFailed).toBe(true));
    expect(m.onAddAgent).toHaveBeenNthCalledWith(
      1,
      undefined,
      expect.objectContaining({ model: PANEL_MODEL })
    );

    // Changing defaults after the failed attempt must not mutate the committed
    // launch intent used for a retry.
    rerender(
      makeParams(m, {
        initialPrompt: "run system tests",
        modelCatalog: MODEL_CATALOG,
        defaultModelRef: WORKSPACE_MODEL,
        defaultAgentConfig: { model: WORKSPACE_MODEL },
      })
    );
    act(() => result.current.deferredAgent?.retryLaunch());

    await waitFor(() => expect(m.onAddAgent).toHaveBeenCalledTimes(2));
    expect(m.onAddAgent).toHaveBeenNthCalledWith(
      2,
      undefined,
      expect.objectContaining({ model: PANEL_MODEL })
    );
  });

  it("never shows the setup card over an existing transcript (has-history guard)", () => {
    const m = freshMocks();
    const { result } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, {
        messages: [{ id: "m1", senderId: "u", content: "hi" } as never],
      }),
    });
    // No agent present, but the chat has history → don't replace it with setup.
    expect(result.current.deferredAgent).toBeUndefined();
  });

  it("keeps the setup card hidden after an agent leaves (ever-had-agent latch)", () => {
    const m = freshMocks();
    const { result, rerender } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, { participants: agentRoster }),
    });
    expect(result.current.deferredAgent).toBeUndefined(); // agent present
    // Agent idle-stops → roster empties, nothing pending. Even with no messages,
    // the setup card must not take over the conversation.
    rerender(makeParams(m, { participants: {} }));
    expect(result.current.deferredAgent?.setupActive ?? false).toBe(false);
  });

  it("surfaces a launch failure and retries on demand", async () => {
    const m = freshMocks();
    m.onAddAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, { input: "hello" }),
    });
    await act(async () => {
      await result.current.sendMessage();
    });
    await waitFor(() => expect(result.current.deferredAgent?.launchFailed).toBe(true));
    expect(m.onAddAgent).toHaveBeenCalledTimes(1);
    // Retry re-issues the spawn (this attempt resolves) and clears the error.
    await act(async () => {
      result.current.deferredAgent?.retryLaunch();
    });
    await waitFor(() => expect(m.onAddAgent).toHaveBeenCalledTimes(2));
    expect(result.current.deferredAgent?.launchFailed).toBe(false);
  });

  it("spawns once the agent gallery loads, even if the user sent first", async () => {
    const m = freshMocks();
    const { result, rerender } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, { input: "hello", availableAgents: [] }),
    });
    await act(async () => {
      await result.current.sendMessage();
    });
    // No agent types yet → the message is held, but nothing is spawned.
    expect(m.onAddAgent).not.toHaveBeenCalled();
    expect(result.current.deferredAgent?.queued.length).toBe(1);
    // Gallery loads → the spawn-driver fires.
    rerender(makeParams(m, { input: "", availableAgents: [AGENT] }));
    await waitFor(() => expect(m.onAddAgent).toHaveBeenCalledTimes(1));
  });

  it("spawns with the host default (undefined id) when no type was picked", async () => {
    const m = freshMocks();
    const { result } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, { input: "hello" }),
    });
    await act(async () => {
      await result.current.sendMessage();
    });
    await waitFor(() => expect(m.onAddAgent).toHaveBeenCalledTimes(1));
    // undefined id lets the panel honor a caller-pinned agentSource/agentClass.
    expect(m.onAddAgent).toHaveBeenCalledWith(undefined, expect.any(Object));
    // The seeded draft handle must NOT leak onto the spawn — the host derives a
    // valid handle for the resolved agent (the inline setup has no handle field).
    expect(m.onAddAgent!.mock.calls[0]?.[1]).not.toHaveProperty("handle");
    // Untouched UI fallbacks must not mask workspace defaults that may resolve in
    // the host at spawn time.
    expect(m.onAddAgent!.mock.calls[0]?.[1]).not.toHaveProperty("approvalLevel");
  });

  it("locks the spawn type at send time even if the selection changes before launch", async () => {
    const m = freshMocks();
    // Gallery not loaded yet → the send is held (canSpawn false), not spawned.
    const { result, rerender } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, { input: "hello", availableAgents: [] }),
    });
    act(() => result.current.deferredAgent?.setAgentId("workers/agent-worker"));
    await act(async () => {
      await result.current.sendMessage();
    });
    expect(m.onAddAgent).not.toHaveBeenCalled();
    // A stray later selection change must NOT alter what this message committed to.
    act(() => result.current.deferredAgent?.setAgentId("workers/other"));
    rerender(makeParams(m, { input: "", availableAgents: [AGENT] }));
    await waitFor(() => expect(m.onAddAgent).toHaveBeenCalledTimes(1));
    expect(m.onAddAgent).toHaveBeenCalledWith("workers/agent-worker", expect.any(Object));
  });

  it("shows the setup card only once replay has settled (brand-new chat)", () => {
    const m = freshMocks();
    const { result, rerender } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, { replaySettled: false }),
    });
    // Replay not settled → empty `messages` isn't yet a trustworthy "new chat".
    expect(result.current.deferredAgent?.setupActive ?? false).toBe(false);
    rerender(makeParams(m, { replaySettled: true }));
    expect(result.current.deferredAgent?.setupActive).toBe(true);
  });

  it("never flashes the setup card over an agentless channel that has history", () => {
    const m = freshMocks();
    // Reopened agentless channel: history is mid-replay (not settled, empty yet).
    const { result, rerender } = renderHook((p: Params) => useDeferredAgent(p), {
      initialProps: makeParams(m, { replaySettled: false, messages: [] }),
    });
    expect(result.current.deferredAgent?.setupActive ?? false).toBe(false);
    // Replay settles and reveals the history → still no setup card.
    rerender(
      makeParams(m, {
        replaySettled: true,
        messages: [{ id: "m1", senderId: "u", content: "hi" } as never],
      })
    );
    expect(result.current.deferredAgent?.setupActive ?? false).toBe(false);
  });
});
