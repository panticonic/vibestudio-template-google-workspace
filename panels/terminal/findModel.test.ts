import { describe, expect, it } from "vitest";
import { findKeyAction, findStatus } from "./findModel.js";

describe("find model", () => {
  it("does not show a status message for an empty query", () => {
    expect(findStatus("", undefined, { index: -1, count: 0 })).toBe("");
  });

  it("shows no matches when search failed or the result count is zero", () => {
    expect(findStatus("needle", false, { index: -1, count: 0 })).toBe("No matches");
    expect(findStatus("needle", true, { index: -1, count: 0 })).toBe("No matches");
  });

  it("shows one-based match position when results are known", () => {
    expect(findStatus("needle", true, { index: 2, count: 5 })).toBe("3 of 5");
  });

  it("shows a transient searching state before result counts arrive", () => {
    expect(findStatus("needle", true, { index: -1, count: 2 })).toBe("Searching...");
  });

  it("maps find input keys to local find actions", () => {
    expect(findKeyAction({ key: "Escape", shiftKey: false })).toBe("close");
    expect(findKeyAction({ key: "Enter", shiftKey: false })).toBe("next");
    expect(findKeyAction({ key: "Enter", shiftKey: true })).toBe("previous");
    expect(findKeyAction({ key: "ArrowDown", shiftKey: false })).toBe("none");
  });
});
