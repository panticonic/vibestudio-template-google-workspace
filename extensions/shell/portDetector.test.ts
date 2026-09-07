import { describe, expect, it } from "vitest";
import { createDetectionState, scanChunk } from "./portDetector.js";

const encoder = new TextEncoder();

describe("port detector", () => {
  it("detects URLs and ports split across stream chunks", () => {
    const state = createDetectionState();

    expect(scanChunk(state, encoder.encode("dev server at http://local"))).toBe(false);
    expect(scanChunk(state, encoder.encode("host:5173/app\n"))).toBe(true);

    expect(state.detectedUrls).toEqual(["http://localhost:5173/app"]);
    expect(state.detectedPorts).toEqual([5173]);
  });

  it("detects common local bind addresses and trims URL punctuation", () => {
    const state = createDetectionState();

    scanChunk(state, encoder.encode("Listening on http://0.0.0.0:3000, and http://[::1]:9229.\n"));

    expect(state.detectedUrls).toEqual(["http://0.0.0.0:3000", "http://[::1]:9229"]);
    expect(state.detectedPorts).toEqual([3000, 9229]);
  });

  it("ignores binary-looking chunks", () => {
    const state = createDetectionState();

    expect(scanChunk(state, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe(false);

    expect(state.detectedUrls).toEqual([]);
    expect(state.detectedPorts).toEqual([]);
  });

  it("caps detected items and retained lines", () => {
    const state = createDetectionState();
    for (let index = 0; index < 25; index += 1) {
      scanChunk(state, encoder.encode(`http://localhost:${3000 + index}\n`));
    }

    expect(state.detectedPorts).toHaveLength(20);
    expect(state.detectedPorts[0]).toBe(3005);
    expect(state.detectedUrls).toHaveLength(20);
    expect(state.lineWindow.length).toBeLessThanOrEqual(80);
  });
});
