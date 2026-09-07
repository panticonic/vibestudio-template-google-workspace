import { describe, expect, it } from "vitest";
import { connectionRetryDelayMs, isTransientConnectionFailure } from "./connectionRetry";

describe("chat connection recovery", () => {
  it("backs transient reconnects off to a bounded five-second interval", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(connectionRetryDelayMs)).toEqual([
      250, 500, 1_000, 2_000, 4_000, 5_000, 5_000,
    ]);
  });

  it("does not loop on authoritative access or application failures", () => {
    expect(isTransientConnectionFailure({ errorKind: "access" })).toBe(false);
    expect(isTransientConnectionFailure({ errorKind: "application" })).toBe(false);
    expect(isTransientConnectionFailure({ errorKind: "connection" })).toBe(true);
    expect(isTransientConnectionFailure(new Error("server restarting"))).toBe(true);
  });
});
