import { describe, expect, it } from "vitest";
import { previewTarget } from "./PaneHeader.js";
import type { SessionInfo } from "./types.js";

describe("pane header", () => {
  it("prefers full detected URLs for preview opening", () => {
    expect(previewTarget(session({ detectedUrls: ["https://localhost:5173/app"], detectedPorts: [5173] })))
      .toEqual({ kind: "url", url: "https://localhost:5173/app" });
  });

  it("normalizes wildcard bind URLs before preview opening", () => {
    expect(previewTarget(session({ detectedUrls: ["http://0.0.0.0:5173/app"], detectedPorts: [5173] })))
      .toEqual({ kind: "url", url: "http://localhost:5173/app" });
  });

  it("falls back to the first detected port", () => {
    expect(previewTarget(session({ detectedPorts: [3000, 5173] }))).toEqual({ kind: "port", port: 3000 });
  });

  it("ignores non-http URLs for preview opening", () => {
    expect(previewTarget(session({ detectedUrls: ["file:///tmp/report.html"] }))).toBeUndefined();
  });
});

function session(patch: Partial<SessionInfo>): SessionInfo {
  return {
    sessionId: "s1",
    label: "Shell",
    command: { argv: ["/bin/sh"], cwd: "/repo" },
    cols: 80,
    rows: 24,
    alive: true,
    detectedPorts: [],
    detectedUrls: [],
    lastActivityAt: 0,
    bytesOut: 0,
    meta: {},
    ...patch,
  };
}
