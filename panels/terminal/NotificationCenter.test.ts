import { describe, expect, it } from "vitest";
import { buildNotificationCenterModel, notificationItemPresentation } from "./NotificationCenter.js";
import type { SessionInfo, TerminalNotification } from "./types.js";

describe("NotificationCenter model", () => {
  it("filters notifications by severity and labels groups from session info", () => {
    const model = buildNotificationCenterModel([
      notification("n1", "s1", "approval"),
      notification("n2", "s2", "failure"),
      notification("n3", "s1", "approval"),
    ], "approval", {
      s1: session("s1", "Agent"),
      s2: session("s2", "Tests"),
    });

    expect(model.filter).toBe("approval");
    expect(model.notifications.map((item) => item.notifId)).toEqual(["n1", "n3"]);
    expect(model.groups).toEqual([{
      sessionId: "s1",
      label: "Agent",
      items: [expect.objectContaining({ notifId: "n1" }), expect.objectContaining({ notifId: "n3" })],
    }]);
  });

  it("falls back to a short session id label for ended or missing sessions", () => {
    const model = buildNotificationCenterModel([
      notification("n1", "abcdef123456", "info"),
    ], "all", {});

    expect(model.groups[0]?.label).toBe("Session abcdef12");
    expect(model.groups[0]?.items[0]?.canJump).toBe(false);
  });

  it("only enables jump for live sessions", () => {
    const model = buildNotificationCenterModel([
      notification("n1", "live", "info"),
      notification("n2", "dead", "failure"),
    ], "all", {
      live: session("live", "Live", true),
      dead: session("dead", "Dead", false),
    });

    expect(model.notifications.map((item) => [item.notifId, item.canJump])).toEqual([
      ["n1", true],
      ["n2", false],
    ]);
  });

  it("orders notifications and groups by newest item first", () => {
    const model = buildNotificationCenterModel([
      notification("old", "s1", "info", 10),
      notification("newest", "s2", "done", 30),
      notification("middle", "s1", "failure", 20),
    ], "all", {
      s1: session("s1", "One"),
      s2: session("s2", "Two"),
    });

    expect(model.notifications.map((item) => item.notifId)).toEqual(["newest", "middle", "old"]);
    expect(model.groups.map((group) => group.sessionId)).toEqual(["s2", "s1"]);
    expect(model.groups.find((group) => group.sessionId === "s1")?.items.map((item) => item.notifId)).toEqual(["middle", "old"]);
  });

  it("renders terminal notification bodies with mono styling and expandable long output", () => {
    const short = notificationItemPresentation({ message: "ok" });
    const long = notificationItemPresentation({ message: `first line\n${"x".repeat(160)}` });

    expect(short.canExpand).toBe(false);
    expect(short.collapsedBodyStyle.fontFamily).toContain("monospace");
    expect(short.collapsedBodyStyle.WebkitLineClamp).toBe(2);
    expect(long.canExpand).toBe(true);
    expect(long.expandedBodyStyle.whiteSpace).toBe("pre-wrap");
    expect(long.expandedBodyStyle.fontFamily).toContain("monospace");
  });
});

function notification(notifId: string, sessionId: string, severity: TerminalNotification["severity"], timestamp = 1): TerminalNotification {
  return {
    notifId,
    sessionId,
    severity,
    message: notifId,
    timestamp,
    read: false,
  };
}

function session(sessionId: string, label: string, alive = true): SessionInfo {
  return {
    sessionId,
    label,
    command: { argv: ["/bin/sh"], cwd: "/repo" },
    cols: 80,
    rows: 24,
    alive,
    detectedPorts: [],
    detectedUrls: [],
    lastActivityAt: 1,
    bytesOut: 0,
    meta: {},
  };
}
