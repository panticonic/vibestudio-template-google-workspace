import { describe, expect, it } from "vitest";
import { currentJournal, Journal, withJournal } from "../shared/journal.js";

describe("panel operation journal", () => {
  it("does not reject overlapping async journal scopes", async () => {
    const first = new Journal();
    const second = new Journal();
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const firstRun = withJournal(first, async () => {
      currentJournal()?.append({ type: "reload", id: "first-before" });
      await withJournal(second, async () => {
        currentJournal()?.append({ type: "reload", id: "second" });
        await secondGate;
      });
      currentJournal()?.append({ type: "reload", id: "first-after" });
    });

    await Promise.resolve();
    currentJournal()?.append({ type: "reload", id: "overlap" });
    releaseSecond();
    await firstRun;

    expect(first.entries.map((entry) => entry.id)).toEqual([
      "first-before",
      "second",
      "overlap",
      "first-after",
    ]);
    expect(second.entries.map((entry) => entry.id)).toEqual(["second", "overlap"]);
    expect(currentJournal()).toBeNull();
  });
});
