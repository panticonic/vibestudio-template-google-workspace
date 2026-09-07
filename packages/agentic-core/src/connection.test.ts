import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECTION_READY_TIMEOUT_MS, ConnectionManager } from "./connection.js";
import type { ChatParticipantMetadata, ConnectionConfig } from "./types.js";

const CHANNEL_TARGET = "do:workers/pubsub-channel:PubSubChannel:chat-1";

function createConfig(): ConnectionConfig {
  const call = vi.fn((target: string, method: string) => {
    if (target === "main" && method === "workers.resolveService") {
      return Promise.resolve({
        kind: "durable-object",
        targetId: CHANNEL_TARGET,
      });
    }
    return Promise.resolve(undefined);
  }) as NonNullable<ConnectionConfig["rpc"]>["call"];
  return {
    clientId: "panel:panel-1",
    rpc: {
      selfId: "panel:panel-1",
      call,
      stream: vi.fn((_target, _method, _args, options) =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `${JSON.stringify({
                      kind: "subscribed",
                      result: { ok: true, participantId: "panel:panel-1" },
                    })}\n`
                  )
                );
                options?.signal?.addEventListener("abort", () => controller.close(), {
                  once: true,
                });
              },
            })
          )
        )
      ),
      on: vi.fn(() => vi.fn()),
    },
  };
}

const metadata: ChatParticipantMetadata = {
  name: "Panel",
  type: "panel",
};

describe("ConnectionManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes a pubsub client when a pending connect is aborted", async () => {
    const config = createConfig();
    const manager = new ConnectionManager({ config, metadata, callbacks: {} });

    const connectPromise = manager.connect({
      channelId: "chat-1",
      methods: {},
    });
    await vi.waitFor(() => {
      expect(config.rpc!.stream).toHaveBeenCalledWith(
        CHANNEL_TARGET,
        "subscribe",
        [
          "panel:panel-1",
          expect.objectContaining({
            replayMessageLimit: 50,
          }),
          expect.any(String),
        ],
        { signal: expect.any(AbortSignal) }
      );
    });
    await manager.disconnect();

    await expect(connectPromise).rejects.toThrow("ready aborted");
    expect(config.rpc!.call).toHaveBeenCalledWith(CHANNEL_TARGET, "unsubscribe", [
      "panel:panel-1",
      expect.any(String),
    ], { timeoutMs: 15_000 });
  });

  it("bounds an explicit replay message limit to the canonical page maximum", async () => {
    const config = { ...createConfig(), replayMessageLimit: 1234 };
    const manager = new ConnectionManager({ config, metadata, callbacks: {} });

    const connectPromise = manager.connect({
      channelId: "chat-1",
      methods: {},
    });
    await vi.waitFor(() => {
      expect(config.rpc.stream).toHaveBeenCalledWith(
        CHANNEL_TARGET,
        "subscribe",
        [
          "panel:panel-1",
          expect.objectContaining({
            replayMessageLimit: 500,
          }),
          expect.any(String),
        ],
        { signal: expect.any(AbortSignal) }
      );
    });
    await manager.disconnect();

    await expect(connectPromise).rejects.toThrow("ready aborted");
  });

  it("terminates a connection whose replay-ready boundary never arrives", async () => {
    vi.useFakeTimers();
    const config = createConfig();
    const onError = vi.fn();
    const manager = new ConnectionManager({
      config,
      metadata,
      callbacks: { onError },
    });

    const connectPromise = manager.connect({
      channelId: "chat-1",
      methods: {},
    });
    const rejected = expect(connectPromise).rejects.toThrow(
      "Channel chat-1 did not finish loading within 15 seconds"
    );
    await vi.advanceTimersByTimeAsync(CONNECTION_READY_TIMEOUT_MS);

    await rejected;
    expect(manager.status).toBe("disconnected");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Channel chat-1 did not finish loading within 15 seconds",
      })
    );
  });

  it("bounds channel service resolution before starting replay", async () => {
    vi.useFakeTimers();
    const config = createConfig();
    config.rpc!.call = vi.fn(async (target, method, _args, options) => {
      if (target === "main" && method === "workers.resolveService") {
        await new Promise<void>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("service resolution timed out")),
            options?.timeoutMs
          );
        });
      }
      return undefined;
    }) as NonNullable<ConnectionConfig["rpc"]>["call"];
    const manager = new ConnectionManager({ config, metadata, callbacks: {} });

    const connectPromise = manager.connect({
      channelId: "chat-1",
      methods: {},
    });
    let settled = false;
    void connectPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await vi.advanceTimersByTimeAsync(CONNECTION_READY_TIMEOUT_MS);
    await expect(connectPromise).rejects.toThrow("service resolution timed out");
    expect(config.rpc!.call).toHaveBeenCalledWith(
      "main",
      "workers.resolveService",
      ["vibestudio.channel.v1", "chat-1"],
      {
        signal: expect.any(AbortSignal),
        timeoutMs: CONNECTION_READY_TIMEOUT_MS,
      }
    );
    expect(settled).toBe(true);
  });
});
