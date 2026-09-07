import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "@workspace/pi-ai";
import {
  getOpenAICodexWebSocketDebugStats,
  releaseOpenAICodexWebSocketSession,
  stream,
} from "@workspace/pi-ai/api/openai-codex-responses";

const model = {
  id: "gpt-5.3-codex-spark",
  name: "GPT-5.3 Codex Spark",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 128_000,
} satisfies Model<"openai-codex-responses">;

const context: Context = { messages: [] };
const apiKey = [
  btoa(JSON.stringify({ alg: "none" })),
  btoa(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-test" },
    })
  ),
  "signature",
].join(".");

const terminalResponse = {
  type: "response.completed",
  response: {
    id: "response-test",
    status: "completed",
    output: [],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
    },
  },
};

async function collect(eventStream: ReturnType<typeof stream>) {
  const events: Array<{ type: string }> = [];
  for await (const event of eventStream) events.push(event as { type: string });
  return { events, result: await eventStream.result() };
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static onSend: ((socket: FakeWebSocket) => void) | null = null;
  readyState = 0;
  closed = false;
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(_url: string, _options?: unknown) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", { type: "open" });
    });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(_payload: string): void {
    if (FakeWebSocket.onSend) {
      FakeWebSocket.onSend(this);
      return;
    }
    queueMicrotask(() =>
      this.receive({
        type: "response.created",
        response: { id: "response-started", status: "in_progress", output: [] },
      })
    );
  }

  receive(value: unknown): void {
    this.emit("message", { type: "message", data: JSON.stringify(value) });
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", { type: "close", code, reason, wasClean: true }));
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 8));
        const chunk = chunks[index++];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunk));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

describe("OpenAI Codex transport liveness", () => {
  afterEach(() => {
    releaseOpenAICodexWebSocketSession();
    FakeWebSocket.instances = [];
    FakeWebSocket.onSend = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("expires a silent post-start WebSocket and retries the session over SSE", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const sessionId = "transport-fallback-test";
    const first = await collect(
      stream(model, context, {
        apiKey,
        sessionId,
        transport: "auto",
        streamIdleTimeoutMs: 15,
        env: { TEST: "1" },
      })
    );

    expect(first.events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(first.result).toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining("WebSocket idle timeout after 15ms"),
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.closed).toBe(true);
    expect(getOpenAICodexWebSocketDebugStats(sessionId)).toMatchObject({
      websocketFailures: 1,
      websocketFallbackActive: true,
    });

    const fetchMock = vi.fn(async () =>
      sseResponse([`data: ${JSON.stringify(terminalResponse)}\n\n`])
    );
    vi.stubGlobal("fetch", fetchMock);
    const retry = await collect(
      stream(model, context, {
        apiKey,
        sessionId,
        transport: "auto",
        streamIdleTimeoutMs: 15,
        env: { TEST: "1" },
      })
    );

    expect(retry.result.stopReason).toBe("stop");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    releaseOpenAICodexWebSocketSession(sessionId);
    expect(getOpenAICodexWebSocketDebugStats(sessionId)).toBeUndefined();
  });

  it("uses the attributed fetch-upgrade route in a Workers runtime even when WebSocket exists", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("WebSocketPair", class WebSocketPair {});
    const routedSocket = new FakeWebSocket("wss://routed.invalid");
    FakeWebSocket.instances = [];
    FakeWebSocket.onSend = (socket) => queueMicrotask(() => socket.receive(terminalResponse));
    const fetchMock = vi.fn(async () => {
      // Fetch's web platform Response constructor rejects 101 even though the
      // Workers runtime returns an upgrade response carrying `webSocket`.
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, "webSocket", { value: routedSocket });
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await collect(
      stream(model, context, {
        apiKey,
        sessionId: "workers-routed-upgrade-test",
        transport: "websocket",
      })
    );

    expect(response.result.stopReason).toBe("stop");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("expires an SSE response body that stops delivering chunks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );

    const response = await collect(
      stream(model, context, {
        apiKey,
        transport: "sse",
        streamIdleTimeoutMs: 15,
      })
    );

    expect(response.events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(response.result).toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining("SSE stream idle timeout after 15ms"),
    });
  });

  it("renews the SSE lease on raw activity without limiting total stream time", async () => {
    const keepalive = ": keepalive\n\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          keepalive,
          keepalive,
          keepalive,
          keepalive,
          `data: ${JSON.stringify(terminalResponse)}\n\n`,
        ])
      )
    );

    const startedAt = Date.now();
    const response = await collect(
      stream(model, context, {
        apiKey,
        transport: "sse",
        streamIdleTimeoutMs: 15,
      })
    );

    expect(Date.now() - startedAt).toBeGreaterThan(30);
    expect(response.result.stopReason).toBe("stop");
    expect(response.events.at(-1)?.type).toBe("done");
  });

  it("renews the WebSocket lease on provider frames that produce no semantic delta", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    FakeWebSocket.onSend = (socket) => {
      socket.receive({
        type: "response.created",
        response: { id: "response-started", status: "in_progress", output: [] },
      });
      for (const delay of [8, 16, 24, 32]) {
        setTimeout(() => socket.receive({ type: "response.in_progress" }), delay);
      }
      setTimeout(() => socket.receive(terminalResponse), 40);
    };

    const startedAt = Date.now();
    const response = await collect(
      stream(model, context, {
        apiKey,
        sessionId: "websocket-renewal-test",
        transport: "websocket",
        streamIdleTimeoutMs: 15,
        env: { TEST: "1" },
      })
    );

    expect(Date.now() - startedAt).toBeGreaterThan(30);
    expect(response.result.stopReason).toBe("stop");
    expect(response.events.at(-1)?.type).toBe("done");
  });

  it("treats explicit cancellation as cancellation rather than idle failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );
    const controller = new AbortController();
    const pending = collect(
      stream(model, context, {
        apiKey,
        transport: "sse",
        streamIdleTimeoutMs: 1_000,
        signal: controller.signal,
      })
    );
    setTimeout(() => controller.abort(new Error("test cancellation")), 10);

    const response = await pending;
    expect(response.result.stopReason).toBe("aborted");
    expect(response.result.errorMessage).toContain("Request was aborted");
  });
});
