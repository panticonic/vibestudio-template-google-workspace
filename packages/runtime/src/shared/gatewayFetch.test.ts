import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayFetch } from "./gatewayFetch.js";

describe("explicit gateway transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses authenticated HTTP only when configured with its host credential", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    const gateway = createGatewayFetch({
      serverUrl: "https://gateway.test",
      token: "secret",
    });
    await gateway("/a/../route");
    expect(fetch).toHaveBeenCalledWith(
      "https://gateway.test/route",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers,
    ).toEqual(new Headers({ Authorization: "Bearer secret" }));
  });

  it.each([
    "https://other.test/x",
    "//other.test/x",
    "https://user:password@gateway.test/x",
  ])("rejects foreign or credential-bearing destinations: %s", async (path) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const gateway = createGatewayFetch({
      serverUrl: "https://gateway.test",
      token: "secret",
    });
    await expect(gateway(path)).rejects.toThrow(/only gateway-relative/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows absolute same-origin gateway URLs", async () => {
    const stream = vi.fn(async () => new Response("ok"));
    await createGatewayFetch({
      rpc: { stream },
      serverUrl: "https://gateway.test",
    })("https://gateway.test/build?key=1");
    expect(stream).toHaveBeenCalledWith(
      "main",
      "gateway.fetch",
      [expect.objectContaining({ path: "/build?key=1" })],
      { signal: undefined, body: null },
    );
  });

  it("runs the same RPC client with or without panel globals and never sends a bearer", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const shell of [
      undefined,
      {
        stream: vi.fn(() => {
          throw new Error("wrong transport");
        }),
      },
    ]) {
      vi.stubGlobal("__vibestudioShell", shell);
      const stream = vi.fn(async () => new Response("tunneled"));
      const response = await createGatewayFetch({ rpc: { stream } })(
        "api/route",
      );
      expect(await response.text()).toBe("tunneled");
      expect(stream).toHaveBeenCalledWith(
        "main",
        "gateway.fetch",
        [{ path: "/api/route", method: "GET", headers: {} }],
        { signal: undefined, body: null },
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves streaming uploads and cancellation without buffering or descriptor bodies", async () => {
    const stream = vi.fn(async () => new Response("ok"));
    const abort = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("payload"));
        c.close();
      },
    });
    await createGatewayFetch({ rpc: { stream } })("/upload", {
      method: "POST",
      body,
      signal: abort.signal,
    });
    const args = stream.mock.calls[0] as unknown as [
      string,
      string,
      unknown[],
      { body: ReadableStream<Uint8Array>; signal: AbortSignal },
    ];
    expect(args[2]).toEqual([{ path: "/upload", method: "POST", headers: {} }]);
    expect(args[3].body).toBe(body);
    expect(args[3].signal).toBe(abort.signal);
    expect(await new Response(args[3].body).text()).toBe("payload");
  });

  it("preserves automatically generated multipart boundaries", async () => {
    const stream = vi.fn(async () => new Response("ok"));
    const body = new FormData();
    body.set("field", "value");
    await createGatewayFetch({ rpc: { stream } })("/upload", {
      method: "POST",
      body,
    });
    const args = stream.mock.calls[0] as unknown as [
      string,
      string,
      [{ headers: Record<string, string> }],
      { body: ReadableStream<Uint8Array> },
    ];
    const parsed = await new Response(args[3].body, {
      headers: args[2][0].headers,
    }).formData();
    expect(parsed.get("field")).toBe("value");
  });

  it("rejects network destinations without a configured gateway URL", async () => {
    const stream = vi.fn(async () => new Response("ok"));
    const gateway = createGatewayFetch({ rpc: { stream } });
    for (const path of [
      "https://other.test/x",
      "//other.test/x",
      "data:hello",
      "\\evil.test",
      "/x\n",
    ]) {
      await expect(gateway(path)).rejects.toThrow(/only gateway-relative/);
    }
    expect(stream).not.toHaveBeenCalled();
  });

  it("rejects missing RPC support rather than falling back to HTTP", () => {
    expect(() => createGatewayFetch({ rpc: {} as never })).toThrow(
      /transport is unavailable/,
    );
  });
});
