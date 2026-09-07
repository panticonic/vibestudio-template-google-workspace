import { describe, expect, it } from "vitest";
import { terminalStartupDetail, terminalStartupPendingLabel } from "./startupModel.js";

describe("terminal startup model", () => {
  it("does not show a pending label when no session open is pending", () => {
    expect(terminalStartupPendingLabel({ pending: false, elapsedSeconds: 0, shellUnit: null })).toBeUndefined();
  });

  it("starts with a generic startup label", () => {
    expect(terminalStartupPendingLabel({ pending: true, elapsedSeconds: 0, shellUnit: { status: "running" } }))
      .toBe("Starting terminal...");
  });

  it("switches to terminal approval feedback after the first second", () => {
    expect(terminalStartupPendingLabel({ pending: true, elapsedSeconds: 1, shellUnit: { status: "running" } }))
      .toBe("Waiting for terminal approval... 1s");
  });

  it("distinguishes extension preparation from terminal approval", () => {
    expect(terminalStartupPendingLabel({ pending: true, elapsedSeconds: 5, shellUnit: { status: "building" } }))
      .toBe("Preparing terminal... 5s");
  });

  it("escalates long extension preparation without changing the in-flight request", () => {
    expect(terminalStartupPendingLabel({ pending: true, elapsedSeconds: 21, shellUnit: { status: "building" } }))
      .toBe("Still preparing terminal... 21s");
    expect(terminalStartupDetail({
      status: "opening",
      elapsedSeconds: 21,
      shellUnit: { status: "building" },
      error: null,
    }).detail).toContain("already in progress");
  });

  it("distinguishes unit approval from terminal approval", () => {
    expect(terminalStartupPendingLabel({ pending: true, elapsedSeconds: 5, shellUnit: { pendingApproval: { kind: "install" } } }))
      .toBe("Waiting for unit approval... 5s");
  });

  it("escalates long terminal approval waits with actionable feedback", () => {
    expect(terminalStartupPendingLabel({ pending: true, elapsedSeconds: 16, shellUnit: { status: "running" } }))
      .toBe("Still waiting for terminal approval... 16s");
    expect(terminalStartupDetail({
      status: "waitingApproval",
      elapsedSeconds: 16,
      shellUnit: { status: "running" },
      error: null,
    }).detail).toContain("approval bar");
  });
});
