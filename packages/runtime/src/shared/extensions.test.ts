import { describe, expect, it, vi } from "vitest";
import type { RpcCaller } from "@vibestudio/rpc";
import { createExtensionsClient } from "./extensions.js";

describe("createExtensionsClient", () => {
  it("routes ordinary extension proxy methods through unary invoke", async () => {
    const rpc = createRpc();
    const extensions = createExtensionsClient(rpc);
    const shell = extensions.use("@workspace-extensions/shell");

    await shell.open({ command: "bash", cwd: "/repo" });

    expect(rpc.call).toHaveBeenCalledWith("main", "extensions.invoke", [
      "@workspace-extensions/shell",
      "open",
      [{ command: "bash", cwd: "/repo" }],
    ]);
    expect(rpc.stream).not.toHaveBeenCalled();
  });

  it("routes manifest-declared streaming methods through invokeStream", async () => {
    const response = new Response("stream");
    const rpc = createRpc(response, ["attach"]);
    const extensions = createExtensionsClient(rpc);
    const shell = extensions.use("@workspace-extensions/shell");

    await expect(shell.attach("session-1", { after: "42" })).resolves.toBe(response);
    await shell.write("session-1", "x");

    expect(rpc.call).toHaveBeenCalledWith("main", "extensions.streamingMethods", [
      "@workspace-extensions/shell",
    ]);
    expect(rpc.stream).toHaveBeenCalledWith("main", "extensions.invokeStream", [
      "@workspace-extensions/shell",
      "attach",
      ["session-1", { after: "42" }],
    ]);
    expect(rpc.call).toHaveBeenCalledWith("main", "extensions.invoke", [
      "@workspace-extensions/shell",
      "write",
      ["session-1", "x"],
    ]);
  });

  it("lets the streamingMethods option override manifest resolution", async () => {
    const response = new Response("stream");
    const rpc = createRpc(response);
    const extensions = createExtensionsClient(rpc);
    const shell = extensions.use("@workspace-extensions/shell", { streamingMethods: ["attach"] });

    await expect(shell.attach("session-1")).resolves.toBe(response);

    expect(rpc.call).not.toHaveBeenCalledWith(
      "main",
      "extensions.streamingMethods",
      expect.anything()
    );
    expect(rpc.stream).toHaveBeenCalledWith("main", "extensions.invokeStream", [
      "@workspace-extensions/shell",
      "attach",
      ["session-1"],
    ]);
  });

  it("fails closed when streaming declarations cannot be loaded", async () => {
    const rpc = createRpc();
    rpc.call.mockRejectedValueOnce(new Error("registry unavailable"));
    const extensions = createExtensionsClient(rpc);
    const shell = extensions.use("@workspace-extensions/shell");

    await expect(shell.attach("session-1")).rejects.toThrow("registry unavailable");
    expect(rpc.call).not.toHaveBeenCalledWith(
      "main",
      "extensions.invoke",
      expect.anything()
    );
    expect(rpc.stream).not.toHaveBeenCalled();
  });

  it("exposes the untyped `invoke` primitive (so `services.extensions.invoke` works in eval)", async () => {
    const rpc = createRpc();
    const extensions = createExtensionsClient(rpc);

    await extensions.invoke("@workspace-extensions/typecheck-service", "checkPanel", [
      "panels/app",
    ]);

    expect(rpc.call).toHaveBeenCalledWith("main", "extensions.invoke", [
      "@workspace-extensions/typecheck-service",
      "checkPanel",
      ["panels/app"],
    ]);
  });

  it("routes provider namespaces only through invokeProvider", async () => {
    const rpc = createRpc();
    const extensions = createExtensionsClient(rpc);

    await extensions.invokeProvider("browserData", "getHistory", [{ limit: 1 }]);

    expect(rpc.call).toHaveBeenCalledWith("main", "extensions.invokeProvider", [
      "browserData",
      "getHistory",
      [{ limit: 1 }],
    ]);
    expect(rpc.call).not.toHaveBeenCalledWith("main", "extensions.invoke", expect.anything());
  });

  it("keeps Promise assimilation and inspection keys inert on extension proxies", () => {
    const rpc = createRpc();
    const extensions = createExtensionsClient(rpc);
    const shell = extensions.use("@workspace-extensions/shell") as unknown as Record<
      string,
      unknown
    >;

    expect(shell["then"]).toBeUndefined();
    expect(shell["toJSON"]).toBeUndefined();
    expect(rpc.call).not.toHaveBeenCalled();
    expect(rpc.stream).not.toHaveBeenCalled();
  });

  it("reports Promise-style catch misuse on extension proxies clearly", () => {
    const rpc = createRpc();
    const extensions = createExtensionsClient(rpc);
    const shell = extensions.use("@workspace-extensions/shell") as unknown as Record<
      string,
      unknown
    >;

    expect(() => (shell["catch"] as () => void)()).toThrow(
      'extensions.use("@workspace-extensions/shell") is synchronous'
    );
    expect(rpc.call).not.toHaveBeenCalled();
    expect(rpc.stream).not.toHaveBeenCalled();
  });
});

function createRpc(
  response: Response = new Response(),
  streamingMethods: string[] = []
): RpcCaller & {
  call: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
} {
  return {
    call: vi.fn(async (_target: string, method: string) =>
      method === "extensions.streamingMethods" ? streamingMethods : null
    ),
    stream: vi.fn(async () => response),
    emit: vi.fn(async () => undefined),
    on: vi.fn(),
  } as unknown as RpcCaller & {
    call: ReturnType<typeof vi.fn>;
    stream: ReturnType<typeof vi.fn>;
  };
}
