import { describe, expect, it, vi } from "vitest";
import { readResponseEvents } from "./codex-responses.js";

describe("Codex Responses SSE", () => {
  it("handles arbitrary byte boundaries, CRLF, UTF-8, data-only events, and trailing frames", async () => {
    const bytes = new TextEncoder().encode(
      ': heartbeat\r\n\r\ndata: {"type":"response.created","text":"魚"}\r\n\r\nevent: response.completed\ndata: {"ok":true}',
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    const events = [];
    for await (const event of readResponseEvents(stream)) events.push(event);
    expect(events).toEqual([
      {
        type: "response.created",
        data: { type: "response.created", text: "魚" },
      },
      { type: "response.completed", data: { ok: true } },
    ]);
    expect(stream.locked).toBe(false);
  });
  it("cancels the body when a consumer stops after completion", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"response.completed"}\n\n'),
        );
      },
      cancel,
    });
    for await (const _event of readResponseEvents(stream)) break;
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
});
