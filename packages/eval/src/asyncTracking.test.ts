import { afterEach, describe, expect, it } from "vitest";
import { getAsyncTracking } from "./asyncTracking";

describe("getAsyncTracking", () => {
  const originalTracking = (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"];

  afterEach(() => {
    // Restore original state
    if (originalTracking !== undefined) {
      (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"] = originalTracking;
    } else {
      delete (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"];
    }
  });

  it("returns undefined when __vibestudioAsyncTracking__ is not set", () => {
    delete (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"];
    expect(getAsyncTracking()).toBeUndefined();
  });

  it("returns the tracking API when set", () => {
    const mockAPI = { start: () => ({ id: 1, promises: new Set(), pauseCount: 0 }) };
    (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"] = mockAPI;
    expect(getAsyncTracking()).toBe(mockAPI);
  });
});
