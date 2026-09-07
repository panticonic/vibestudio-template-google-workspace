import { describe, expect, it, vi } from "vitest";
import { ChannelClient } from "./channel-client.js";

interface Captured {
  event?: { payload?: { tier?: unknown; role?: unknown; blocks?: Array<Record<string, unknown>> } };
  publishOpts?: { attachments?: Array<Record<string, unknown>> };
}

/** A ChannelClient backed by a stub RpcCaller that captures the published event. */
function makeClient(captured: Captured): ChannelClient {
  const rpc = {
    call: async (_target: string, method: string, args: unknown[]) => {
      if (method === "workers.resolveService") {
        return { kind: "durable-object", targetId: "chan-do" };
      }
      if (method === "publish") {
        captured.event = args[2] as Captured["event"];
        captured.publishOpts = args[3] as Captured["publishOpts"];
        return { id: 1 };
      }
      return undefined;
    },
  };
  return new ChannelClient(rpc as never, "chan-1");
}

describe("ChannelClient.send tier", () => {
  it("keeps a structured publish pending until the channel acknowledges durable acceptance", async () => {
    let acknowledge!: () => void;
    const accepted = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const rpc = {
      call: vi.fn(async (_target: string, method: string) => {
        if (method === "workers.resolveService") {
          return { kind: "durable-object", targetId: "chan-do" };
        }
        if (method === "publish") {
          await accepted;
          return { id: 1 };
        }
        return undefined;
      }),
    };
    const publish = new ChannelClient(rpc as never, "chan-1").publish(
      "agent:1",
      "vibestudio.test",
      { ok: true },
      { idempotencyKey: "receipt:1" }
    );
    let settled = false;
    void publish.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    acknowledge();
    await expect(publish).resolves.toEqual({ id: 1 });
  });

  it("defaults a deliberate agent send (e.g. the say tool) to the primary tier", async () => {
    const captured: Captured = {};
    await makeClient(captured).send("agent:1", "m1", "hello there", {
      senderMetadata: { type: "agent" },
    });
    expect(captured.event?.payload?.role).toBe("assistant");
    expect(captured.event?.payload?.tier).toBe("primary");
  });

  it("honors an explicit secondary tier for a deliberately slight send", async () => {
    const captured: Captured = {};
    await makeClient(captured).send("agent:1", "m2", "working on it…", {
      senderMetadata: { type: "agent" },
      tier: "secondary",
    });
    expect(captured.event?.payload?.tier).toBe("secondary");
  });
});

describe("ChannelClient.send attachments", () => {
  it("forwards attachments to publish and records an attachment block per file", async () => {
    const captured: Captured = {};
    // "aGVsbG8=" is base64("hello") — 5 bytes.
    await makeClient(captured).send("agent:1", "m3", "screenshot attached", {
      senderMetadata: { type: "agent" },
      attachments: [{ data: "aGVsbG8=", mimeType: "image/png", name: "shot.png" }],
    });
    expect(captured.publishOpts?.attachments).toEqual([
      { id: "att_0", data: "aGVsbG8=", mimeType: "image/png", name: "shot.png", size: 5 },
    ]);
    const blocks = captured.event?.payload?.blocks ?? [];
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({
      type: "attachment",
      metadata: { mimeType: "image/png", filename: "shot.png" },
    });
  });

  it("omits attachments from publish opts when none are given", async () => {
    const captured: Captured = {};
    await makeClient(captured).send("agent:1", "m4", "plain text", {
      senderMetadata: { type: "agent" },
    });
    expect(captured.publishOpts?.attachments).toBeUndefined();
    expect(captured.event?.payload?.blocks).toHaveLength(1);
  });
});

describe("ChannelClient finite relationships", () => {
  it("joins without opening an RPC response stream", async () => {
    const stream = vi.fn();
    const rpc = {
      call: vi.fn(async (_target: string, method: string, args: unknown[]) => {
        if (method === "workers.resolveService") {
          return { kind: "durable-object", targetId: "chan-do" };
        }
        if (method === "join") {
          return { ok: true, participantId: (args[0] as { participantId: string }).participantId };
        }
        return undefined;
      }),
      stream,
    };
    const client = new ChannelClient(rpc as never, "chan-1");
    await expect(client.join({
      participantId: "agent-1",
      revision: 1,
      contextId: "ctx-1",
      metadata: { type: "agent" },
      delivery: "all",
      endpoint: { kind: "entity", entityId: "agent-1", invocation: "direct" },
      applicationConfig: null,
      replay: true,
    })).resolves.toMatchObject({ ok: true, participantId: "agent-1" });
    expect(stream).not.toHaveBeenCalled();
  });

  it("does not resolve leave until the channel acknowledges it", async () => {
    let acknowledgeLeave!: () => void;
    const leaveAcknowledged = new Promise<void>((resolve) => {
      acknowledgeLeave = resolve;
    });
    const rpc = {
      call: vi.fn(async (_target: string, method: string) => {
        if (method === "workers.resolveService") {
          return { kind: "durable-object", targetId: "chan-do" };
        }
        if (method === "leave") {
          await leaveAcknowledged;
        }
        return undefined;
      }),
    };
    const client = new ChannelClient(rpc as never, "chan-1");

    let settled = false;
    const leaving = client.leave("agent-1", 2).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(rpc.call).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);

    acknowledgeLeave();
    await leaving;
    expect(settled).toBe(true);
  });
});
