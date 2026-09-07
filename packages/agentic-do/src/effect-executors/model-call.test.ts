import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initialAgentState as createInitialAgentState,
  type AgentLoopConfig,
  type AgentState,
  type InitialStateInput,
  type ModelCallEffect,
} from "@workspace/agent-loop";
import { transformMessages } from "@workspace/pi-ai/api/transform-messages";
import {
  CredentialApprovalDeferredError,
  type ExecutorDeps,
  type ModelExecutionAttemptEvent,
} from "./types.js";

const mocks = vi.hoisted(() => ({
  clampThinkingLevel: vi.fn((_model: unknown, level: unknown) => level),
  closeOpenAICodexWebSocketSessions: vi.fn(),
  releaseOpenAICodexWebSocketSession: vi.fn(),
  getModel: vi.fn(),
  stream: vi.fn(),
}));

vi.mock("@workspace/pi-ai", () => ({
  clampThinkingLevel: mocks.clampThinkingLevel,
  getModel: mocks.getModel,
}));

vi.mock("@workspace/pi-ai/compat", () => ({
  stream: mocks.stream,
}));

vi.mock("@workspace/pi-ai/api/openai-codex-responses", () => ({
  closeOpenAICodexWebSocketSessions: mocks.closeOpenAICodexWebSocketSessions,
  releaseOpenAICodexWebSocketSession: mocks.releaseOpenAICodexWebSocketSession,
}));

const {
  modelCallExecutor,
  modelFacingToolResultContent,
  toPiAssistantBlocks,
  toPiMessages,
  toProtocolBlocks,
} = await import("./model-call.js");

describe("model-facing tool results", () => {
  it("preserves screenshots as native image blocks and excludes diagnostic details", () => {
    const content = modelFacingToolResultContent({
      protocolContent: [
        { type: "text", text: "captured" },
        { type: "image", mimeType: "image/png", data: "base64-pixels" },
      ],
      details: { internal: "must not enter model context" },
    });

    expect(content).toEqual([
      { type: "text", text: "captured" },
      { type: "image", mimeType: "image/png", data: "base64-pixels" },
    ]);
    expect(
      toPiMessages([
        {
          role: "assistant",
          blocks: [
            { type: "toolCall", id: "capture-1", name: "read", arguments: {} },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "capture-1",
          toolName: "read",
          content: {
            protocolContent: content,
            details: { internal: "hidden" },
          },
        },
      ])[1],
    ).toMatchObject({ role: "toolResult", content });
  });
});

describe("historical assistant model identity", () => {
  const thinking = {
    type: "thinking",
    content: "reasoning that belongs to its producing model",
    metadata: { pi: { thinkingSignature: "signed-reasoning" } },
  };
  const identity = {
    provider: "anthropic",
    api: "anthropic-messages",
    model: "claude-sonnet-4-6",
  };
  const currentModel = {
    id: identity.model,
    provider: identity.provider,
    api: identity.api,
    input: ["text"],
  } as never;

  it("preserves reasoning for the same model and downgrades it for a real cross-model handoff", () => {
    const [historical] = toPiMessages([
      { role: "assistant", blocks: [thinking], model: identity },
    ]);

    expect(historical).toMatchObject(identity);
    expect(transformMessages([historical!], currentModel)[0]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "reasoning that belongs to its producing model",
          thinkingSignature: "signed-reasoning",
        },
      ],
    });

    expect(
      transformMessages([historical!], {
        id: "gpt-5.6-sol",
        provider: "openai-codex",
        api: "openai-codex-responses",
        input: ["text"],
      } as never)[0],
    ).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "reasoning that belongs to its producing model" },
      ],
    });
  });
});

const modelSpec: AgentLoopConfig["modelSpec"] = {
  id: "model",
  name: "Test Model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://api.test.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 4096,
};

const config: AgentLoopConfig = {
  model: "test:model",
  modelSpec,
  thinkingLevel: "medium",
  fastMode: false,
  approvalLevel: 2,
  respondPolicy: "all",
  systemPromptHash: "sys",
  activeToolNames: [],
  roster: { participants: [] },
};

function initialAgentState(
  input: Omit<InitialStateInput, "selfId">,
): AgentState {
  return createInitialAgentState({ ...input, selfId: "agent:self" });
}

function descriptor(
  requestOverrides: Partial<ModelCallEffect["request"]> = {},
): ModelCallEffect {
  return {
    effectId: "model:msg-1",
    kind: "model_call",
    channelId: "channel-1",
    idempotencyKey: "attempt-1",
    messageId: "msg-1",
    turnId: "turn-1",
    request: {
      provider: "test",
      model: "model",
      // Journal-materialized spec (design §6.2) — the executor's only
      // resolution path.
      modelSpec,
      auth: "url-bound",
      thinkingLevel: "medium",
      systemPromptHash: "sys",
      activeToolNames: [],
      contextThroughSeq: 0,
      attemptId: "attempt-1",
      ...requestOverrides,
    },
  };
}

function deps(): ExecutorDeps {
  return {
    selfRef: { kind: "agent", id: "agent:self", participantId: "agent:self" },
    blobstore: {
      getText: async () => "",
      putText: async (value) => ({
        digest: `digest:${value.length}`,
        size: value.length,
      }),
    },
    credentials: {
      getApiKey: async () => ({ apiKey: "test-key" }),
      registerCredentialInterest: async () => {},
    },
    channel: {
      cancelMethodCall: async () => {},
      callMethod: async () => {},
      publish: async () => {},
      recordReadReceipt: async () => {},
      sendSignalEvent: async () => {},
    },
    localTools: {
      run: async () => ({ result: null, isError: false }),
      alreadyApplied: async () => null,
    },
    http: {
      post: async () => ({ deferred: false, result: null, isError: false }),
    },
    callbackAddress: { source: "test", className: "Test", objectKey: "obj" },
  };
}

describe("modelCallExecutor", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("fails an unprepared system prompt before calling blobstore or a provider", async () => {
    const inputDeps = deps();
    const getText = vi.fn(inputDeps.blobstore.getText);
    inputDeps.blobstore.getText = getText;

    await expect(
      modelCallExecutor.execute({
        descriptor: descriptor({ systemPromptHash: "" }),
        state: initialAgentState({ channelId: "channel-1", config }),
        signal: new AbortController().signal,
        deps: inputDeps,
        onEphemeral: () => {},
      }),
    ).rejects.toMatchObject({
      name: "PromptArtifactInvariantError",
      message: expect.stringContaining("system prompt artifact is not ready"),
    });
    expect(getText).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("defers the model call when credential approval parks server-side", async () => {
    mocks.getModel.mockReturnValue({ baseUrl: "https://model.test" });
    const getApiKey = vi.fn(async () => {
      throw new CredentialApprovalDeferredError("test", "https://model.test");
    });
    const inputDeps = deps();
    inputDeps.credentials.getApiKey = getApiKey;
    const signal = new AbortController().signal;

    await expect(
      modelCallExecutor.execute({
        descriptor: descriptor(),
        state: initialAgentState({ channelId: "channel-1", config }),
        signal,
        deps: inputDeps,
        onEphemeral: () => {},
      }),
    ).resolves.toEqual({ deferred: true, reason: "authority" });

    expect(getApiKey).toHaveBeenCalledWith({
      providerId: "test",
      // Credential lookup keys off the journaled modelSpec's baseUrl now —
      // the executor no longer consults the registry (design §6.2).
      modelBaseUrl: "https://api.test.example/v1",
      requestId: "model:msg-1",
      idempotencyKey: "attempt-1",
      signal,
    });
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("routes loopback auth through the local-models port, never the credential system", async () => {
    const getApiKey = vi.fn(async () => ({ apiKey: "cloud-key" }));
    const ensureLoaded = vi.fn(async () => ({
      baseUrl: "http://127.0.0.1:43117/v1",
    }));
    const getLoopbackAuth = vi.fn(async () => ({ apiKey: "loopback-key" }));
    const inputDeps = deps();
    inputDeps.credentials.getApiKey = getApiKey;
    inputDeps.localModels = { ensureLoaded, getLoopbackAuth };
    let streamedModel: Record<string, unknown> | undefined;
    let streamOptions: Record<string, unknown> | undefined;
    const ephemerals: unknown[] = [];
    const attempts: ModelExecutionAttemptEvent[] = [];
    mocks.stream.mockImplementation(
      (
        model: Record<string, unknown>,
        _context,
        options: Record<string, unknown>,
      ) => {
        streamedModel = model;
        streamOptions = options;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "text_delta", contentIndex: 0, delta: "hi" };
          },
          result: async () => ({
            content: [{ type: "text", text: "hi" }],
            stopReason: "stop",
          }),
        };
      },
    );

    const outcome = await modelCallExecutor.execute({
      descriptor: descriptor({
        provider: "local",
        model: "lfm2.5-2.6b",
        auth: "loopback",
        // Journaled placeholder port — the LIVE ensureLoaded endpoint must win.
        modelSpec: {
          id: "lfm2.5-2.6b",
          name: "LFM2.5 2.6B",
          api: "openai-completions",
          provider: "local",
          baseUrl: "http://127.0.0.1:0/v1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 4096,
        },
      }),
      state: initialAgentState({ channelId: "channel-1", config }),
      signal: new AbortController().signal,
      deps: inputDeps,
      onEphemeral: (event) => ephemerals.push(event),
      onModelExecutionAttempt: (event) => attempts.push(event),
    });

    expect(outcome).toMatchObject({ kind: "model", stopReason: "completed" });
    expect(getApiKey).not.toHaveBeenCalled();
    expect(ensureLoaded).toHaveBeenCalledWith(
      "lfm2.5-2.6b",
      expect.any(AbortSignal),
    );
    expect(attempts).toMatchObject([
      {
        phase: "started",
        channelId: "channel-1",
        messageId: "msg-1",
        provider: "local",
        model: "lfm2.5-2.6b",
        ref: "local:lfm2.5-2.6b",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:43117/v1",
        auth: "loopback",
      },
      { phase: "finished", outcome: "completed" },
    ]);
    expect(attempts[0]?.attemptId).toBe(attempts[1]?.attemptId);
    expect(
      ephemerals
        .filter(
          (event) => (event as { kind?: unknown }).kind === "signal-message",
        )
        .map((event) =>
          JSON.parse(String((event as { content?: unknown }).content)),
        ),
    ).toEqual([
      { message: "Starting local model…" },
      { message: "Loading LFM2.5 2.6B… (first use may download)" },
    ]);
    expect(streamOptions).toMatchObject({
      apiKey: "loopback-key",
      maxTokens: 4096,
    });
    // pi-ai constructs its client from model.baseUrl and IGNORES a baseUrl
    // option — the live endpoint must be baked into the model literal.
    expect(streamedModel).toMatchObject({
      baseUrl: "http://127.0.0.1:43117/v1",
    });
  });

  it("propagates activation cancellation while local model loading is pending", async () => {
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    const ensureLoaded = vi.fn(
      async (
        _modelId: string,
        signal: AbortSignal,
      ): Promise<{ baseUrl: string }> => {
        resolveEntered();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );
    const inputDeps = deps();
    inputDeps.localModels = {
      ensureLoaded,
      getLoopbackAuth: vi.fn(async () => ({ apiKey: "loopback-key" })),
    };
    const controller = new AbortController();
    const pending = modelCallExecutor.execute({
      descriptor: descriptor({
        provider: "local",
        model: "lfm2.5-2.6b",
        auth: "loopback",
        modelSpec: {
          ...descriptor().request.modelSpec,
          id: "lfm2.5-2.6b",
          name: "LFM2.5 2.6B",
          provider: "local",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:0/v1",
        },
      }),
      state: initialAgentState({ channelId: "channel-1", config }),
      signal: controller.signal,
      deps: inputDeps,
      onEphemeral: () => {},
    });
    await entered;

    controller.abort(new Error("durable-object activation released"));

    await expect(pending).rejects.toThrow("durable-object activation released");
    expect(ensureLoaded).toHaveBeenCalledWith("lfm2.5-2.6b", controller.signal);
  });

  it("does not start provider transport after cancellation during credential resolution", async () => {
    let resolveCredential!: (value: { apiKey: string }) => void;
    let credentialEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      credentialEntered = resolve;
    });
    const inputDeps = deps();
    inputDeps.credentials.getApiKey = vi.fn(
      () =>
        new Promise<{ apiKey: string }>((resolve) => {
          resolveCredential = resolve;
          credentialEntered();
        }),
    );
    const controller = new AbortController();
    const pending = modelCallExecutor.execute({
      descriptor: descriptor(),
      state: initialAgentState({ channelId: "channel-1", config }),
      signal: controller.signal,
      deps: inputDeps,
      onEphemeral: () => {},
    });
    await entered;

    controller.abort(new Error("channel retired"));
    resolveCredential({ apiKey: "too-late" });

    await expect(pending).rejects.toThrow("channel retired");
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("fails a loopback request with a model error when the local-models port is absent", async () => {
    const getApiKey = vi.fn(async () => ({ apiKey: "cloud-key" }));
    const inputDeps = deps();
    inputDeps.credentials.getApiKey = getApiKey;
    delete inputDeps.localModels;

    const outcome = await modelCallExecutor.execute({
      descriptor: descriptor({
        provider: "local",
        model: "lfm2.5-2.6b",
        auth: "loopback",
      }),
      state: initialAgentState({ channelId: "channel-1", config }),
      signal: new AbortController().signal,
      deps: inputDeps,
      onEphemeral: () => {},
    });

    expect(outcome).toMatchObject({ kind: "model", stopReason: "error" });
    expect(getApiKey).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("returns retry-later for retryable provider rate limits", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.getModel.mockReturnValue({ baseUrl: "https://api.openai.com/v1" });
    const rateLimit = Object.assign(
      new Error("Rate limit reached for requests."),
      {
        status: 429,
        headers: { "retry-after": "12" },
        body: {
          error: {
            type: "rate_limit_exceeded",
            message: "Rate limit reached for requests.",
          },
        },
      },
    );
    mocks.stream.mockImplementation(() => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw rateLimit;
          },
        };
      },
      result: async () => ({ content: [], stopReason: "stop" }),
    }));
    const inputDescriptor = descriptor();
    inputDescriptor.request.provider = "openai";
    inputDescriptor.request.model = "gpt-5.1";

    await expect(
      modelCallExecutor.execute({
        descriptor: inputDescriptor,
        state: initialAgentState({ channelId: "channel-1", config }),
        signal: new AbortController().signal,
        deps: deps(),
        onEphemeral: () => {},
      }),
    ).resolves.toMatchObject({
      kind: "retry",
      reason: "Rate limit reached for requests.",
      retryAfterMs: 12_000,
      code: "rate_limited_retryable",
    });
    expect(warn).toHaveBeenCalledWith(
      "[model-call] stream failed:",
      expect.stringContaining("Rate limit reached"),
    );
  });

  it("bounds an absent Codex transport and honors a tighter explicit idle deadline", async () => {
    const observedOptions: Array<Record<string, unknown>> = [];
    mocks.stream.mockImplementation((_model, _context, options) => {
      observedOptions.push(options as Record<string, unknown>);
      return {
        async *[Symbol.asyncIterator]() {},
        result: async () => ({
          content: [{ type: "text", text: "ok" }],
          stopReason: "stop",
        }),
      };
    });

    const codexSpec = {
      ...modelSpec,
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
    };
    await modelCallExecutor.execute({
      descriptor: descriptor({
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        modelSpec: codexSpec as never,
        serviceTier: "priority",
      }),
      state: initialAgentState({ channelId: "channel-1", config }),
      signal: new AbortController().signal,
      deps: deps(),
      onEphemeral: () => {},
    });
    await modelCallExecutor.execute({
      descriptor: descriptor({
        provider: "openai-codex",
        model: "gpt-5.3-codex-spark",
        modelSpec: { ...codexSpec, streamIdleTimeoutMs: 45_000 } as never,
      }),
      state: initialAgentState({ channelId: "channel-1", config }),
      signal: new AbortController().signal,
      deps: deps(),
      onEphemeral: () => {},
    });

    expect(observedOptions[0]).toMatchObject({
      timeoutMs: 60_000,
      streamIdleTimeoutMs: 60_000,
      serviceTier: "priority",
    });
    expect(observedOptions[1]).toMatchObject({
      timeoutMs: 45_000,
      streamIdleTimeoutMs: 45_000,
    });
  });

  it("closes and durably retries a Codex session whose explicit idle deadline expires", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let providerSessionId: string | undefined;
    mocks.stream.mockImplementation((_model, _context, options) => {
      providerSessionId = String(options.sessionId);
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              throw new Error("WebSocket idle timeout after 300000ms");
            },
          };
        },
        result: async () => ({ content: [], stopReason: "stop" }),
      };
    });
    const codexSpec = {
      ...modelSpec,
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      streamIdleTimeoutMs: 300_000,
    };

    await expect(
      modelCallExecutor.execute({
        descriptor: descriptor({
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          modelSpec: codexSpec as never,
        }),
        state: initialAgentState({ channelId: "channel-1", config }),
        signal: new AbortController().signal,
        deps: deps(),
        onEphemeral: () => {},
      }),
    ).resolves.toMatchObject({
      kind: "retry",
      code: "unknown_retryable",
      retryAfterMs: 1_000,
      reason: "WebSocket idle timeout after 300000ms",
    });
    expect(providerSessionId).toBeTruthy();
    expect(mocks.closeOpenAICodexWebSocketSessions).toHaveBeenCalledWith(
      providerSessionId,
    );
    expect(warn).toHaveBeenCalledWith(
      "[model-call] stream failed:",
      expect.stringContaining("WebSocket idle timeout"),
    );
  });

  it("honors a configured semantic-progress deadline for every model transport", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let returnCalled = false;
    mocks.stream.mockImplementation(() => ({
      [Symbol.asyncIterator]() {
        let emittedStart = false;
        return {
          next: async () => {
            if (!emittedStart) {
              emittedStart = true;
              return { done: false, value: { type: "start" } };
            }
            return await new Promise<IteratorResult<Record<string, unknown>>>(
              () => {},
            );
          },
          return: async () => {
            returnCalled = true;
            return { done: true, value: undefined };
          },
        };
      },
      result: async () => ({ content: [], stopReason: "stop" }),
    }));
    const boundedSpec = { ...modelSpec, streamIdleTimeoutMs: 15 };

    await expect(
      modelCallExecutor.execute({
        descriptor: descriptor({ modelSpec: boundedSpec }),
        state: initialAgentState({ channelId: "channel-1", config }),
        signal: new AbortController().signal,
        deps: deps(),
        onEphemeral: () => {},
      }),
    ).resolves.toMatchObject({
      kind: "retry",
      code: "model_stream_stalled_retryable",
      reason: "Model stream made no semantic progress for 15ms",
    });
    expect(returnCalled).toBe(true);
    expect(mocks.closeOpenAICodexWebSocketSessions).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[model-call] stream failed:",
      expect.stringContaining("ModelProgressIdleTimeoutError"),
    );
  });

  it("parks interactive URL-bound auth stream failures behind credential reconnect", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const authError = Object.assign(
      new Error(
        "Provided authentication token is expired. Please try signing in again.",
      ),
      { status: 401 },
    );
    mocks.stream.mockImplementation(() => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw authError;
          },
        };
      },
      result: async () => ({ content: [], stopReason: "stop" }),
    }));

    await expect(
      modelCallExecutor.execute({
        descriptor: descriptor(),
        state: initialAgentState({ channelId: "channel-1", config }),
        signal: new AbortController().signal,
        deps: deps(),
        onEphemeral: () => {},
      }),
    ).resolves.toMatchObject({
      kind: "model-suspended",
      reason: "credential",
      providerId: "test",
      modelBaseUrl: "https://api.test.example/v1",
      waitReason: "model_credential_reconnect_required",
      diagnosticReason: expect.stringContaining(
        "authentication token is expired",
      ),
      failureCode: "auth_or_credentials",
    });
  });

  it("returns unattended URL-bound auth stream failures as model errors", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const authError = Object.assign(
      new Error(
        "Provided authentication token is expired. Please try signing in again.",
      ),
      { status: 401 },
    );
    mocks.stream.mockImplementation(() => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw authError;
          },
        };
      },
      result: async () => ({ content: [], stopReason: "stop" }),
    }));

    await expect(
      modelCallExecutor.execute({
        descriptor: descriptor({ turnMetadata: { origin: "scheduled" } }),
        state: initialAgentState({ channelId: "channel-1", config }),
        signal: new AbortController().signal,
        deps: deps(),
        onEphemeral: () => {},
      }),
    ).resolves.toMatchObject({
      kind: "model",
      stopReason: "error",
      failure: {
        code: "auth_or_credentials",
        reason: expect.stringContaining("authentication token is expired"),
        recoverable: false,
      },
    });
  });

  it("returns a delayed recoverable model failure for open provider circuit breakers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.getModel.mockReturnValue({ baseUrl: "https://api.openai.com/v1" });
    mocks.stream.mockImplementation(() => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw new Error("Circuit breaker is open");
          },
        };
      },
      result: async () => ({ content: [], stopReason: "stop" }),
    }));

    await expect(
      modelCallExecutor.execute({
        descriptor: descriptor(),
        state: initialAgentState({ channelId: "channel-1", config }),
        signal: new AbortController().signal,
        deps: deps(),
        onEphemeral: () => {},
      }),
    ).resolves.toMatchObject({
      kind: "retry",
      code: "circuit_breaker_open_retryable",
      reason: "Circuit breaker is open",
      retryAfterMs: 30_000,
    });
  });

  it("streams thinking deltas and preserves provider replay metadata on completion", async () => {
    const providerModel = {
      id: "claude-sonnet-4-20250514",
      name: "Claude Sonnet 4",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://model.test",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    };
    mocks.stream.mockImplementation((_model, _context, options) => {
      expect(options).toMatchObject({
        apiKey: "test-key",
        sessionId: "channel-1:agent:self:turn-1:test:model",
        thinkingEnabled: true,
        thinkingBudgetTokens: 8192,
        maxTokens: 64_000,
      });
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "thinking_delta", contentIndex: 0, delta: "think " };
          yield { type: "text_delta", contentIndex: 1, delta: "done" };
        },
        result: async () => ({
          content: [
            {
              type: "thinking",
              thinking: "think ",
              thinkingSignature: "sig-thinking",
            },
            {
              type: "text",
              text: "done",
              textSignature: JSON.stringify({ v: 1, id: "resp-msg" }),
            },
          ],
          stopReason: "stop",
          usage: { input: 1, output: 2 },
        }),
      };
    });

    const ephemerals: unknown[] = [];
    const outcome = await modelCallExecutor.execute({
      descriptor: descriptor({ modelSpec: providerModel as never }),
      state: initialAgentState({ channelId: "channel-1", config }),
      signal: new AbortController().signal,
      deps: deps(),
      onEphemeral: (event) => ephemerals.push(event),
    });

    expect(
      ephemerals.map(
        (event) =>
          (event as { event: { payload: { type: string; text: string } } })
            .event.payload,
      ),
    ).toEqual([
      {
        protocol: "agentic.trajectory.v1",
        blockId: "msg-1:block:0",
        type: "thinking",
        text: "think ",
        replace: true,
      },
      {
        protocol: "agentic.trajectory.v1",
        blockId: "msg-1:block:1",
        type: "text",
        text: "done",
        replace: true,
      },
    ]);
    expect(outcome).toMatchObject({
      kind: "model",
      stopReason: "completed",
      blocks: [
        {
          type: "thinking",
          blockId: "msg-1:block:0",
          content: "think ",
          metadata: { pi: { thinkingSignature: "sig-thinking" } },
        },
        {
          type: "text",
          blockId: "msg-1:block:1",
          content: "done",
          metadata: {
            pi: { textSignature: JSON.stringify({ v: 1, id: "resp-msg" }) },
          },
        },
      ],
    });
    expect(mocks.releaseOpenAICodexWebSocketSession).toHaveBeenCalledWith(
      "channel-1:agent:self:turn-1:test:model",
    );
  });

  it("reuses a provider session only while tool calls keep the same turn active", async () => {
    mocks.stream.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {},
      result: async () => ({
        content: [
          { type: "toolCall", id: "call-1", name: "read", arguments: {} },
        ],
        stopReason: "toolUse",
      }),
    }));

    const outcome = await modelCallExecutor.execute({
      descriptor: descriptor(),
      state: initialAgentState({ channelId: "channel-1", config }),
      signal: new AbortController().signal,
      deps: deps(),
      onEphemeral: () => {},
    });

    expect(outcome).toMatchObject({
      kind: "model",
      stopReason: "completed",
      blocks: [expect.objectContaining({ type: "toolCall", name: "read" })],
    });
    expect(mocks.releaseOpenAICodexWebSocketSession).not.toHaveBeenCalled();
  });

  it("bounds long provider session IDs before streaming", async () => {
    mocks.getModel.mockReturnValue({
      baseUrl: "https://chatgpt.com/backend-api",
    });
    const longDescriptor = descriptor();
    longDescriptor.request.provider = "openai-codex";
    longDescriptor.request.model = "gpt-5.3-codex-spark";
    longDescriptor.channelId =
      "ctx-panel-tree-panels-chat-mqcwmvir-0fe8dd6c-extra-long";
    const inputDeps = deps();
    inputDeps.selfRef = {
      kind: "agent",
      id: "agent:self",
      participantId: "agent:system-testing-agent-with-long-id",
    };
    mocks.stream.mockImplementation((_model, _context, options) => {
      expect(options.sessionId).toHaveLength(64);
      expect(options.sessionId).toMatch(
        /^ctx-panel-tree-panels-chat-mqcwmvir-0fe8dd6c-.*-[0-9a-z]{14}$/,
      );
      return {
        async *[Symbol.asyncIterator]() {},
        result: async () => ({
          content: [{ type: "text", text: "ok" }],
          stopReason: "stop",
          usage: { input: 1, output: 1 },
        }),
      };
    });

    await expect(
      modelCallExecutor.execute({
        descriptor: longDescriptor,
        state: initialAgentState({
          channelId: longDescriptor.channelId,
          config,
        }),
        signal: new AbortController().signal,
        deps: inputDeps,
        onEphemeral: () => {},
      }),
    ).resolves.toMatchObject({
      kind: "model",
      stopReason: "completed",
      blocks: [expect.objectContaining({ content: "ok" })],
    });
  });

  it("budgets hydrated tool results and preserves complete tool-call/result units", async () => {
    const tinySpec = { ...modelSpec, contextWindow: 4_000, maxTokens: 2_000 };
    const inputDescriptor = descriptor({ modelSpec: tinySpec });
    inputDescriptor.request.contextThroughSeq = 5;
    const inputDeps = deps();
    inputDeps.blobstore.getText = async (digest) => {
      if (digest === "sys") return "BASE SYSTEM";
      if (digest === "large-result") return "x".repeat(30_000);
      return "";
    };
    let streamedContext: { messages?: unknown[] } | undefined;
    mocks.stream.mockImplementation((_model, context) => {
      streamedContext = context;
      return {
        async *[Symbol.asyncIterator]() {},
        result: async () => ({
          content: [{ type: "text", text: "ok" }],
          stopReason: "stop",
          usage: { input: 1, output: 1 },
        }),
      };
    });

    await expect(
      modelCallExecutor.execute({
        descriptor: inputDescriptor,
        state: {
          ...initialAgentState({ channelId: "channel-1", config }),
          entries: [
            {
              kind: "user",
              seq: 1,
              envelopeId: "env-1",
              content: "Inspect the package",
            },
            {
              kind: "assistant",
              seq: 2,
              messageId: "msg-old",
              blocks: [
                {
                  type: "toolCall",
                  id: "call-old",
                  name: "read",
                  arguments: {},
                },
              ],
            },
            {
              kind: "tool-result",
              seq: 3,
              invocationId: "call-old",
              turnId: "turn-context",
              name: "read",
              result: "old result",
              isError: false,
            },
            {
              kind: "assistant",
              seq: 4,
              messageId: "msg-new",
              blocks: [
                {
                  type: "toolCall",
                  id: "call-new",
                  name: "read",
                  arguments: {},
                },
              ],
            },
            {
              kind: "tool-result",
              seq: 5,
              invocationId: "call-new",
              turnId: "turn-context",
              name: "read",
              result: {
                protocol: "vibestudio.blob-ref.v1",
                digest: "large-result",
                size: 30_000,
                encoding: "text",
                originalBytes: 30_000,
              },
              isError: false,
            },
          ],
        },
        signal: new AbortController().signal,
        deps: inputDeps,
        onEphemeral: () => {},
      }),
    ).resolves.toMatchObject({ kind: "model", stopReason: "completed" });

    const messages = streamedContext?.messages ?? [];
    expect(JSON.stringify(messages).length).toBeLessThan(9_000);
    expect(JSON.stringify(messages)).toContain(
      "older completed transcript message",
    );
    expect(JSON.stringify(messages)).toContain(
      "Completed mutations remain durable",
    );
    expect(JSON.stringify(messages)).toContain(
      "Recent completed-call receipts",
    );
    expect(JSON.stringify(messages)).toContain("old result");
    expect(JSON.stringify(messages)).toContain(
      "tool result windowed for model context",
    );
    expect(JSON.stringify(messages)).not.toContain("call-old");
    expect(JSON.stringify(messages)).toContain("call-new");
  });

  it("keeps an assistant tool call when pushed steering arrives before its result", async () => {
    const tinySpec = { ...modelSpec, contextWindow: 4_000, maxTokens: 2_000 };
    const inputDescriptor = descriptor({ modelSpec: tinySpec });
    inputDescriptor.request.contextThroughSeq = 4;
    const inputDeps = deps();
    inputDeps.blobstore.getText = async (digest) =>
      digest === "sys" ? "BASE SYSTEM" : "";
    let streamedContext: { messages?: unknown[] } | undefined;
    mocks.stream.mockImplementation((_model, context) => {
      streamedContext = context;
      return {
        async *[Symbol.asyncIterator]() {},
        result: async () => ({
          content: [{ type: "text", text: "ok" }],
          stopReason: "stop",
          usage: { input: 1, output: 1 },
        }),
      };
    });

    await expect(
      modelCallExecutor.execute({
        descriptor: inputDescriptor,
        state: {
          ...initialAgentState({ channelId: "channel-1", config }),
          entries: [
            {
              kind: "user",
              seq: 1,
              envelopeId: "env-large-request",
              content: "x".repeat(30_000),
            },
            {
              kind: "assistant",
              seq: 2,
              messageId: "msg-inspect",
              blocks: [
                {
                  type: "toolCall",
                  id: "call-interleaved",
                  name: "inspect_subagent",
                  arguments: {},
                },
              ],
            },
            {
              kind: "user",
              seq: 3,
              envelopeId: "env-child-completed",
              content: "A child completed while inspection was running.",
            },
            {
              kind: "tool-result",
              seq: 4,
              invocationId: "call-interleaved",
              turnId: "turn-context",
              name: "inspect_subagent",
              result: "inspection result",
              isError: false,
            },
          ],
        },
        signal: new AbortController().signal,
        deps: inputDeps,
        onEphemeral: () => {},
      }),
    ).resolves.toMatchObject({ kind: "model", stopReason: "completed" });

    const serialized = JSON.stringify(streamedContext?.messages ?? []);
    expect(serialized).toContain("call-interleaved");
    expect(serialized).toContain("inspection result");
    expect(serialized).toContain(
      "A child completed while inspection was running.",
    );
  });

  it("rejects orphaned tool results before provider submission", async () => {
    mocks.getModel.mockReturnValue({ baseUrl: "https://model.test" });
    const inputDescriptor = descriptor();
    inputDescriptor.request.contextThroughSeq = 3;
    const inputDeps = deps();
    inputDeps.blobstore.getText = async (digest) =>
      digest === "sys" ? "BASE SYSTEM" : "";

    await expect(
      modelCallExecutor.execute({
        descriptor: inputDescriptor,
        state: {
          ...initialAgentState({ channelId: "channel-1", config }),
          entries: [
            {
              kind: "assistant",
              seq: 1,
              messageId: "msg-tool",
              blocks: [
                {
                  type: "toolCall",
                  id: "call-present",
                  name: "read",
                  arguments: {},
                },
              ],
            },
            {
              kind: "tool-result",
              seq: 2,
              invocationId: "call-present",
              turnId: "turn-context",
              name: "read",
              result: "valid result",
              isError: false,
            },
            {
              kind: "tool-result",
              seq: 3,
              invocationId: "call-missing",
              turnId: "turn-context",
              name: "inspect_subagent",
              result: "orphan result",
              isError: true,
            },
          ],
        },
        signal: new AbortController().signal,
        deps: inputDeps,
        onEphemeral: () => {},
      }),
    ).rejects.toThrow(
      "model transcript invariant violated: orphaned tool result inspect_subagent call-missing",
    );
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("rejects assistant tool calls without tool results before provider submission", async () => {
    mocks.getModel.mockReturnValue({ baseUrl: "https://model.test" });
    const inputDescriptor = descriptor();
    inputDescriptor.request.contextThroughSeq = 1;
    const inputDeps = deps();
    inputDeps.blobstore.getText = async (digest) =>
      digest === "sys" ? "BASE SYSTEM" : "";

    await expect(
      modelCallExecutor.execute({
        descriptor: inputDescriptor,
        state: {
          ...initialAgentState({ channelId: "channel-1", config }),
          entries: [
            {
              kind: "assistant",
              seq: 1,
              messageId: "msg-tool",
              blocks: [
                {
                  type: "toolCall",
                  id: "call-missing-result",
                  name: "read",
                  arguments: {},
                },
              ],
            },
          ],
        },
        signal: new AbortController().signal,
        deps: inputDeps,
        onEphemeral: () => {},
      }),
    ).rejects.toThrow(
      "model transcript invariant violated: assistant tool call call-missing-result has no tool result",
    );
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("follows an explicit prompt read instruction through the real tool loop in deterministic test mode", async () => {
    const previous = process.env["VIBESTUDIO_TEST_MODE"];
    delete process.env["VIBESTUDIO_TEST_MODE"];
    try {
      mocks.getModel.mockReturnValue({
        baseUrl: "https://chatgpt.com/backend-api",
      });
      const getApiKey = vi.fn(async () => ({ apiKey: "test-key" }));
      const inputDeps = deps();
      inputDeps.credentials.getApiKey = getApiKey;
      inputDeps.env = { VIBESTUDIO_TEST_MODE: "1" };
      inputDeps.blobstore.getText = async (digest) =>
        digest === "sys"
          ? "BASE SYSTEM\n\nRead `packages/agentic-do/SKILL.md` when working on the runtime." +
            "\n\n## Opening turn\n\nRead `skills/onboarding/SKILL.md`, then continue."
          : "";
      const inputDescriptor = descriptor();
      inputDescriptor.request.provider = "openai-codex";
      inputDescriptor.request.model = "gpt-5.3-codex-spark";
      inputDescriptor.request.activeToolNames = ["read"];

      const outcome = await modelCallExecutor.execute({
        descriptor: inputDescriptor,
        state: initialAgentState({ channelId: "channel-1", config }),
        signal: new AbortController().signal,
        deps: inputDeps,
        onEphemeral: () => {},
      });

      expect(getApiKey).not.toHaveBeenCalled();
      expect(mocks.stream).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({
        kind: "model",
        stopReason: "completed",
        blocks: [
          {
            type: "toolCall",
            name: "read",
            arguments: { path: "skills/onboarding/SKILL.md" },
          },
        ],
      });

      const continuedState = initialAgentState({
        channelId: "channel-1",
        config,
      });
      continuedState.entries = [
        {
          kind: "assistant",
          seq: 1,
          messageId: "msg-tool",
          blocks: [
            {
              type: "toolCall",
              id: "msg-tool:test-read",
              name: "read",
              arguments: { path: "skills/onboarding/SKILL.md" },
            },
          ],
        },
        {
          kind: "tool-result",
          seq: 2,
          invocationId: "msg-tool:test-read",
          turnId: "turn-context",
          name: "read",
          result: "---\nname: onboarding\n---",
          isError: false,
        },
      ];
      const continued = await modelCallExecutor.execute({
        descriptor: { ...inputDescriptor, messageId: "msg-continued" },
        state: continuedState,
        signal: new AbortController().signal,
        deps: inputDeps,
        onEphemeral: () => {},
      });
      expect(continued).toMatchObject({
        kind: "model",
        blocks: [
          {
            type: "text",
            content: "E2E model response: initial agent turn completed.",
          },
        ],
      });
    } finally {
      if (previous === undefined) {
        delete process.env["VIBESTUDIO_TEST_MODE"];
      } else {
        process.env["VIBESTUDIO_TEST_MODE"] = previous;
      }
    }
  });

  it("turns a natural web request into a real web_fetch invocation in deterministic test mode", async () => {
    const inputDeps = deps();
    inputDeps.env = { VIBESTUDIO_TEST_MODE: "1" };
    inputDeps.blobstore.getText = async () => "";
    const inputDescriptor = descriptor({
      activeToolNames: ["web_fetch"],
      contextThroughSeq: 2,
    });
    const state = initialAgentState({ channelId: "channel-1", config });
    state.openTurn = {
      turnId: "turn-web",
      openedAtSeq: 2,
      modelCallCount: 1,
      consecutiveModelFailureCount: 0,
      interrupted: false,
      waitingCount: 0,
    };
    state.entries = [
      {
        kind: "user",
        seq: 1,
        envelopeId: "env-web",
        content: {
          blocks: [
            {
              type: "text",
              content: "Read https://example.com and tell me its title.",
            },
          ],
        },
      },
    ];

    const requested = await modelCallExecutor.execute({
      descriptor: inputDescriptor,
      state,
      signal: new AbortController().signal,
      deps: inputDeps,
      onEphemeral: () => {},
    });

    expect(requested).toMatchObject({
      kind: "model",
      stopReason: "completed",
      outcome: "tool_calls_only",
      blocks: [
        {
          type: "toolCall",
          name: "web_fetch",
          arguments: { url: "https://example.com" },
        },
      ],
    });

    state.entries.push(
      {
        kind: "assistant",
        seq: 2,
        messageId: "msg-web",
        blocks: [
          {
            type: "toolCall",
            id: "msg-web:test-web-fetch",
            name: "web_fetch",
            arguments: { url: "https://example.com" },
          },
        ],
      },
      {
        kind: "tool-result",
        seq: 3,
        invocationId: "msg-web:test-web-fetch",
        turnId: "turn-context",
        name: "web_fetch",
        result: "<title>Example Domain</title>",
        isError: false,
      },
    );

    await expect(
      modelCallExecutor.execute({
        descriptor: { ...inputDescriptor, messageId: "msg-after-web" },
        state,
        signal: new AbortController().signal,
        deps: inputDeps,
        onEphemeral: () => {},
      }),
    ).resolves.toMatchObject({
      kind: "model",
      blocks: [
        {
          type: "text",
          content: "E2E model response: initial agent turn completed.",
        },
      ],
    });
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("uses the real eval sandbox for a natural sandbox web request in deterministic test mode", async () => {
    const inputDeps = deps();
    inputDeps.env = { VIBESTUDIO_TEST_MODE: "1" };
    inputDeps.blobstore.getText = async () => "";
    const inputDescriptor = descriptor({
      activeToolNames: ["eval", "web_fetch"],
      contextThroughSeq: 2,
    });
    const state = initialAgentState({ channelId: "channel-1", config });
    state.openTurn = {
      turnId: "turn-eval-web",
      openedAtSeq: 2,
      modelCallCount: 1,
      consecutiveModelFailureCount: 0,
      interrupted: false,
      waitingCount: 0,
    };
    state.entries = [
      {
        kind: "user",
        seq: 1,
        envelopeId: "env-eval-web",
        content: {
          blocks: [
            {
              type: "text",
              content: "Use the sandbox eval to fetch https://example.com.",
            },
          ],
        },
      },
    ];

    const requested = await modelCallExecutor.execute({
      descriptor: inputDescriptor,
      state,
      signal: new AbortController().signal,
      deps: inputDeps,
      onEphemeral: () => {},
    });

    expect(requested).toMatchObject({
      kind: "model",
      outcome: "tool_calls_only",
      blocks: [
        {
          type: "toolCall",
          name: "eval",
          arguments: {
            syntax: "javascript",
          },
        },
      ],
    });
    expect(JSON.stringify(requested)).toContain(
      'credentials.fetch(\\"https://example.com\\")',
    );
    expect(JSON.stringify(requested)).not.toContain('"name":"web_fetch"');

    state.entries.push(
      {
        kind: "assistant",
        seq: 2,
        messageId: "msg-eval-web",
        blocks: [
          {
            type: "toolCall",
            id: "msg-eval-web:test-eval-fetch",
            name: "eval",
            arguments: {},
          },
        ],
      },
      {
        kind: "tool-result",
        seq: 3,
        invocationId: "msg-eval-web:test-eval-fetch",
        turnId: "turn-context",
        name: "eval",
        result: { success: true, returnValue: { status: 200 } },
        isError: false,
      },
    );

    await expect(
      modelCallExecutor.execute({
        descriptor: { ...inputDescriptor, messageId: "msg-after-eval-web" },
        state,
        signal: new AbortController().signal,
        deps: inputDeps,
        onEphemeral: () => {},
      }),
    ).resolves.toMatchObject({
      kind: "model",
      blocks: [
        {
          type: "text",
          content: "E2E model response: initial agent turn completed.",
        },
      ],
    });
  });

  it("substitutes inference for a credential-free local fallback in deterministic test mode", async () => {
    const inputDeps = deps();
    const ensureLoaded = vi.fn();
    inputDeps.localModels = {
      ensureLoaded,
      getLoopbackAuth: vi.fn(),
    };
    inputDeps.credentials.getApiKey = vi.fn();
    inputDeps.env = { VIBESTUDIO_TEST_MODE: "1" };

    const outcome = await modelCallExecutor.execute({
      descriptor: descriptor({
        provider: "local",
        model: "lfm2.5-2.6b",
        auth: "loopback",
        modelSpec: {
          ...modelSpec,
          id: "lfm2.5-2.6b",
          name: "LFM2.5",
          provider: "local",
          baseUrl: "http://127.0.0.1:43117/v1",
        },
      }),
      state: initialAgentState({ channelId: "channel-1", config }),
      signal: new AbortController().signal,
      deps: inputDeps,
      onEphemeral: () => {},
    });

    expect(outcome).toMatchObject({
      kind: "model",
      blocks: [
        {
          type: "text",
          content: "E2E model response: initial agent turn completed.",
        },
      ],
    });
    expect(ensureLoaded).not.toHaveBeenCalled();
    expect(inputDeps.credentials.getApiKey).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("round-trips pi replay signatures through protocol block metadata", () => {
    const protocolBlocks = toProtocolBlocks(
      [
        {
          type: "thinking",
          thinking: "[Reasoning redacted]",
          thinkingSignature: "sig-1",
          redacted: true,
        },
        { type: "text", text: "visible", textSignature: "text-sig-1" },
        {
          type: "toolCall",
          id: "tool-1",
          name: "read",
          arguments: { path: "a.ts" },
          thoughtSignature: "tool-sig-1",
        },
      ],
      "msg-1",
    );

    expect(protocolBlocks).toEqual([
      {
        type: "thinking",
        blockId: "msg-1:block:0",
        content: "[Reasoning redacted]",
        metadata: { pi: { thinkingSignature: "sig-1", redacted: true } },
      },
      {
        type: "text",
        blockId: "msg-1:block:1",
        content: "visible",
        metadata: { pi: { textSignature: "text-sig-1" } },
      },
      {
        type: "toolCall",
        id: "tool-1",
        name: "read",
        arguments: { path: "a.ts" },
        metadata: { pi: { thoughtSignature: "tool-sig-1" } },
      },
    ]);
    expect(toPiAssistantBlocks(protocolBlocks)).toEqual([
      {
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: "sig-1",
        redacted: true,
      },
      { type: "text", text: "visible", textSignature: "text-sig-1" },
      {
        type: "toolCall",
        id: "tool-1",
        name: "read",
        arguments: { path: "a.ts" },
        thoughtSignature: "tool-sig-1",
      },
    ]);
  });

  it("does not emit model-call traces unless tracing is enabled", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const inputDescriptor = descriptor();
    inputDescriptor.request.provider = "openai-codex";
    inputDescriptor.request.model = "gpt-5.3-codex-spark";

    await modelCallExecutor.execute({
      descriptor: inputDescriptor,
      state: initialAgentState({ channelId: "channel-1", config }),
      signal: new AbortController().signal,
      deps: { ...deps(), env: { VIBESTUDIO_TEST_MODE: "1" } },
      onEphemeral: () => {},
    });
    // The per-call "[model-call] finished:" summary is intentionally always on;
    // only the fine-grained stage trace is gated behind the env flag.
    expect(
      info.mock.calls.filter((call) => call[0] === "[model-call] trace:"),
    ).toHaveLength(0);

    await modelCallExecutor.execute({
      descriptor: inputDescriptor,
      state: initialAgentState({ channelId: "channel-1", config }),
      signal: new AbortController().signal,
      deps: {
        ...deps(),
        env: { VIBESTUDIO_TEST_MODE: "1", VIBESTUDIO_MODEL_CALL_TRACE: "1" },
      },
      onEphemeral: () => {},
    });
    expect(info).toHaveBeenCalledWith(
      "[model-call] trace:",
      expect.objectContaining({ stage: "start", provider: "openai-codex" }),
    );
  });
});
