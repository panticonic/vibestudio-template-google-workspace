import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcEnvelope, RpcMessage } from "@vibestudio/rpc";
import { createPanelTransport } from "./transport.js";

const g = globalThis as typeof globalThis & {
  __vibestudioShell?: {
    postEnvelope: ReturnType<typeof vi.fn>;
    onEnvelope: ReturnType<typeof vi.fn>;
    onRecovery?: ReturnType<typeof vi.fn>;
    serviceCall?: ReturnType<typeof vi.fn>;
    isLocalService?: ReturnType<typeof vi.fn>;
  };
};

function makeShell(
  overrides: Partial<NonNullable<typeof g.__vibestudioShell>> = {},
) {
  return {
    postEnvelope: vi.fn(async () => {}),
    onEnvelope: vi.fn(() => vi.fn()),
    onRecovery: vi.fn(() => vi.fn()),
    ...overrides,
  };
}

function envelope(target: string, message: RpcMessage): RpcEnvelope {
  return {
    from: "panel:panel-1",
    target,
    delivery: { caller: { callerId: "panel:panel-1", callerKind: "panel" } },
    provenance: [{ callerId: "panel:panel-1", callerKind: "panel" }],
    message,
  };
}

const createOwnedPanelTransport = () =>
  createPanelTransport(new AbortController().signal);

describe("createPanelTransport", () => {
  afterEach(() => {
    delete g.__vibestudioShell;
  });

  it("posts canonical envelopes over the shell bridge unchanged", async () => {
    const shell = makeShell();
    g.__vibestudioShell = shell;
    const transport = createOwnedPanelTransport();
    const message: RpcMessage = {
      type: "event",
      fromId: "panel:panel-1",
      event: "test",
      payload: {},
    };

    const sentEnvelope = envelope("panel:panel-2", message);
    await transport.send(sentEnvelope);

    expect(shell.postEnvelope).toHaveBeenCalledWith(sentEnvelope);
  });

  it("delivers incoming envelopes unchanged", () => {
    let incoming!: (envelope: RpcEnvelope) => void;
    g.__vibestudioShell = makeShell({
      onEnvelope: vi.fn((handler) => {
        incoming = handler;
        return vi.fn();
      }),
    });
    const transport = createOwnedPanelTransport();
    const handler = vi.fn();
    const message: RpcMessage = {
      type: "event",
      fromId: "panel:panel-1",
      event: "test",
      payload: {},
    };
    const inboundEnvelope = envelope("panel:panel-2", message);
    transport.onMessage(handler);

    incoming(inboundEnvelope);

    expect(handler).toHaveBeenCalledWith(inboundEnvelope);
  });

  it("registers durable subscription recovery with the host bridge", () => {
    const shell = makeShell();
    g.__vibestudioShell = shell;

    createOwnedPanelTransport();

    expect(shell.onRecovery).toHaveBeenCalledTimes(2);
    expect(shell.onRecovery).toHaveBeenNthCalledWith(
      1,
      "resubscribe",
      expect.any(Function),
    );
    expect(shell.onRecovery).toHaveBeenNthCalledWith(
      2,
      "cold-recover",
      expect.any(Function),
    );
  });

  it("removes recovery subscriptions when the owning runtime retires", () => {
    const unsubscribeResubscribe = vi.fn();
    const unsubscribeColdRecover = vi.fn();
    const shell = makeShell({
      onRecovery: vi
        .fn()
        .mockReturnValueOnce(unsubscribeResubscribe)
        .mockReturnValueOnce(unsubscribeColdRecover),
    });
    g.__vibestudioShell = shell;
    const lifetime = new AbortController();
    createPanelTransport(lifetime.signal);
    lifetime.abort();
    lifetime.abort();
    expect(unsubscribeResubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribeColdRecover).toHaveBeenCalledTimes(1);
  });

  it("sends panel event watches over the shell bridge", async () => {
    const serviceCall = vi.fn(async () => {});
    const shell = makeShell({ serviceCall });
    g.__vibestudioShell = shell;
    const transport = createOwnedPanelTransport();
    const message: RpcMessage = {
      type: "request",
      fromId: "panel:panel-1",
      requestId: "req-1",
      method: "events.watch",
      args: [["notification:action"]],
    };

    const sentEnvelope = envelope("main", message);
    await transport.send(sentEnvelope);

    expect(shell.postEnvelope).toHaveBeenCalledWith(sentEnvelope);
    expect(serviceCall).not.toHaveBeenCalled();
  });

  it("sends panel CDP requests over the shell bridge", async () => {
    const serviceCall = vi.fn(async () => {});
    const shell = makeShell({ serviceCall });
    g.__vibestudioShell = shell;
    const transport = createPanelTransport(new AbortController().signal);
    const message: RpcMessage = {
      type: "request",
      fromId: "panel:chat-entity",
      requestId: "req-cdp",
      method: "panelCdp.getCdpEndpoint",
      args: ["panel:target-slot"],
    };

    const sentEnvelope = envelope("main", message);
    await transport.send(sentEnvelope);

    expect(shell.postEnvelope).toHaveBeenCalledWith(sentEnvelope);
    expect(serviceCall).not.toHaveBeenCalled();
  });

  it("leaves native ownership and error replies to the host", async () => {
    let incoming!: (envelope: RpcEnvelope) => void;
    const shell = makeShell({
      onEnvelope: vi.fn((handler) => {
        incoming = handler;
        return vi.fn();
      }),
    });
    g.__vibestudioShell = shell;
    const transport = createPanelTransport(new AbortController().signal);
    const handler = vi.fn();
    transport.onMessage(handler);
    const request = envelope("main", {
      type: "request",
      fromId: "panel:panel-1",
      requestId: "native-1",
      method: "panel.reloadView",
      args: ["panel-1"],
    });
    await transport.send(request);
    expect(shell.postEnvelope).toHaveBeenCalledWith(request);
    expect(handler).not.toHaveBeenCalled();
    const reply = envelope("panel:panel-1", {
      type: "response",
      requestId: "native-1",
      error: "denied",
      errorKind: "access",
    });
    incoming(reply);
    expect(handler).toHaveBeenCalledWith(reply);
  });

  describe("bridge stream surface", () => {
    function makeStreamShell() {
      let streamHandler: ((msg: unknown) => void) | null = null;
      const sentBodyChunks: unknown[] = [];
      const shell = makeShell({
        streamChunkFormat: "base64",
        streamOpen: vi.fn((msg: { opId: string }) => {
          // Respond head+end on the next microtask, like a host with an
          // empty-bodied 200 response.
          queueMicrotask(() => {
            streamHandler?.({
              kind: "head",
              opId: msg.opId,
              status: 200,
              statusText: "OK",
              headers: [["content-type", "text/plain"]],
            });
            streamHandler?.({ kind: "end", opId: msg.opId });
          });
        }),
        streamBodyChunk: vi.fn(async (msg: unknown) => {
          sentBodyChunks.push(msg);
        }),
        streamAbort: vi.fn(),
        streamAck: vi.fn(),
        onStreamMessage: vi.fn((handler: (msg: unknown) => void) => {
          streamHandler = handler;
          return () => {
            streamHandler = null;
          };
        }),
      } as never);
      return { shell, sentBodyChunks };
    }

    function streamRequestEnvelope(): RpcEnvelope {
      return envelope("main", {
        type: "stream-request",
        requestId: "sreq-1",
        fromId: "panel:panel-1",
        method: "gateway.fetch",
        args: [{ path: "/upload" }],
      } as RpcMessage);
    }

    it("wires streamBody from the shell bridge surface and pumps the body across", async () => {
      const { shell, sentBodyChunks } = makeStreamShell();
      g.__vibestudioShell = shell as never;
      const transport = createPanelTransport(new AbortController().signal);
      expect(typeof transport.streamBody).toBe("function");

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      });
      const response = await transport.streamBody!(
        streamRequestEnvelope(),
        null,
        body,
      );
      expect(response.status).toBe(200);

      await vi.waitFor(() => {
        // 1 data chunk + the done marker.
        expect(sentBodyChunks.length).toBe(2);
      });
      expect(sentBodyChunks[0]).toMatchObject({
        seq: 1,
        chunk: expect.any(String),
      });
      expect(sentBodyChunks[1]).toMatchObject({ seq: 2, done: true });
      expect(
        (shell as unknown as { streamOpen: ReturnType<typeof vi.fn> })
          .streamOpen,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          bodyId: expect.any(String),
          envelope: expect.objectContaining({ target: "main" }),
        }),
      );
    });

    it("routes body-less subscriptions through the host stream plane", async () => {
      const { shell, sentBodyChunks } = makeStreamShell();
      g.__vibestudioShell = shell as never;
      const transport = createPanelTransport(new AbortController().signal);

      const response = await transport.stream!(
        streamRequestEnvelope(),
        null,
        null,
      );

      expect(response.status).toBe(200);
      expect(sentBodyChunks).toEqual([]);
      expect(
        (shell as unknown as { streamOpen: ReturnType<typeof vi.fn> })
          .streamOpen,
      ).toHaveBeenCalledWith({
        opId: expect.any(String),
        envelope: expect.objectContaining({ target: "main" }),
      });
    });

    it("leaves streamBody undefined when the bridge has no upload surface", () => {
      g.__vibestudioShell = makeShell();
      const transport = createPanelTransport(new AbortController().signal);
      expect(transport.streamBody).toBeUndefined();
    });

    it("passes the upload body through a first-class shell.stream verbatim", async () => {
      const stream = vi.fn(async () => new Response(null, { status: 204 }));
      g.__vibestudioShell = makeShell({ stream } as never);
      const transport = createPanelTransport(new AbortController().signal);
      const body = new ReadableStream<Uint8Array>();
      const sentEnvelope = streamRequestEnvelope();

      await transport.stream!(sentEnvelope, null, body);

      expect(stream).toHaveBeenCalledWith(sentEnvelope, null, body);
    });
  });
});
