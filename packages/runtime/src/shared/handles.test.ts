import { describe, expect, it, vi } from "vitest";
import { createCallProxy } from "./handles.js";

describe("createCallProxy", () => {
  it("remains safely inspectable without becoming a thenable", async () => {
    const call = vi.fn(async () => "pong");
    const proxy = createCallProxy({ call } as never, "panel:runtime");

    expect(String(proxy)).toBe("[PanelHandle RPC call proxy]");
    expect(Object.prototype.toString.call(proxy)).toBe("[object PanelHandleRpc]");
    expect(Reflect.get(proxy, "then")).toBeUndefined();
    await expect(Promise.resolve(proxy)).resolves.toBe(proxy);
  });

  it("still dispatches arbitrary string method names", async () => {
    const call = vi.fn(async () => "pong");
    const proxy = createCallProxy({ call } as never, "panel:runtime") as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;

    await expect(proxy["ping"]?.("value")).resolves.toBe("pong");
    expect(call).toHaveBeenCalledWith("panel:runtime", "ping", ["value"]);
  });
});
