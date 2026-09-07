import { describe, expect, it } from "vitest";
import { toServerBaseUrl } from "./gateway.js";

describe("toServerBaseUrl", () => {
  it("normalizes websocket marker URLs to the HTTP server base", () => {
    expect(toServerBaseUrl("ws://127.0.0.1:5000/rpc")).toBe("http://127.0.0.1:5000");
    expect(toServerBaseUrl("wss://host.example/_workspace/dev/rpc")).toBe(
      "https://host.example/_workspace/dev"
    );
    expect(toServerBaseUrl("https://host.example/_workspace/rpc")).toBe(
      "https://host.example/_workspace/rpc"
    );
    expect(toServerBaseUrl("http://127.0.0.1:5000")).toBe("http://127.0.0.1:5000");
  });
});
