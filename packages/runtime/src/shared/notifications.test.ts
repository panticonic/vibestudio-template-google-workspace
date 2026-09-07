import { describe, expect, it, vi } from "vitest";
import type { RpcClient } from "@vibestudio/rpc";
import { createNotificationClient } from "./notifications.js";

function makeRpc() {
  const directListeners = new Set<(event: { payload: unknown }) => void>();
  const rpc = {
    call: vi.fn(async (_target: string, method: string, _args: unknown[]) => {
      if (method === "notification.show") return "n1";
      return undefined;
    }),
    on: vi.fn((_event: string, listener: (event: { payload: unknown }) => void) => {
      directListeners.add(listener);
      return () => directListeners.delete(listener);
    }),
  };
  return {
    rpc,
    emitDirectAction(payload: { id: string; actionId: string }) {
      for (const listener of directListeners) listener({ payload });
    },
  };
}

describe("notification client", () => {
  it("routes action button clicks through the addressed event without serializing functions", async () => {
    const fixture = makeRpc();
    const onClick = vi.fn();
    const client = createNotificationClient(fixture.rpc as unknown as RpcClient);

    const id = await client.show({
      type: "success",
      title: "Image pasted",
      actions: [{ id: "reveal", label: "Reveal", onClick }],
    });

    expect(fixture.rpc.on).toHaveBeenCalledWith("notification:action", expect.any(Function));
    expect(fixture.rpc.call).toHaveBeenCalledWith("main", "notification.show", [
      expect.objectContaining({
        actions: [expect.objectContaining({ id: "reveal", label: "Reveal" })],
      }),
    ]);
    expect(id).toBe("n1");
    const shown = fixture.rpc.call.mock.calls.find(
      (call) => call[1] === "notification.show"
    )?.[2][0] as {
      actions?: Array<Record<string, unknown>>;
    };
    expect(shown.actions?.[0]?.["onClick"]).toBeUndefined();

    fixture.emitDirectAction({ id, actionId: "reveal" });
    await vi.waitFor(() => expect(onClick).toHaveBeenCalledTimes(1));
  });

  it("uses the host-issued notification ID with stable action IDs", async () => {
    const fixture = makeRpc();
    const onClick = vi.fn();
    const client = createNotificationClient(fixture.rpc as unknown as RpcClient);

    const id = await client.show({
      type: "success",
      title: "Image pasted",
      actions: [{ label: "Reveal in folder", onClick }],
    });

    expect(fixture.rpc.call).toHaveBeenCalledWith("main", "notification.show", [
      expect.objectContaining({
        actions: [expect.objectContaining({ id: "reveal-in-folder-0", label: "Reveal in folder" })],
      }),
    ]);
    fixture.emitDirectAction({ id, actionId: "reveal-in-folder-0" });
    await vi.waitFor(() => expect(onClick).toHaveBeenCalledTimes(1));
  });

  it("handles user-addressed action events on the direct RPC channel", async () => {
    const fixture = makeRpc();
    const onClick = vi.fn();
    const client = createNotificationClient(fixture.rpc as unknown as RpcClient);

    const id = await client.show({
      title: "Approval complete",
      actions: [{ id: "open", label: "Open", onClick }],
    });
    fixture.emitDirectAction({ id, actionId: "open" });

    await vi.waitFor(() => expect(onClick).toHaveBeenCalledOnce());
  });

  it("defaults to an info notification without opening an unused watch", async () => {
    const fixture = makeRpc();
    const client = createNotificationClient(fixture.rpc as unknown as RpcClient);

    await client.show({ title: "Hello", message: "Shown from the message field" });

    expect(fixture.rpc.call).toHaveBeenCalledWith("main", "notification.show", [
      expect.objectContaining({
        type: "info",
        title: "Hello",
        message: "Shown from the message field",
      }),
    ]);
    expect(fixture.rpc.on).not.toHaveBeenCalled();
  });
});
