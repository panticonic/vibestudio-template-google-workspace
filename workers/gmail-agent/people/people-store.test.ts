import { describe, expect, it } from "vitest";
import { createInMemorySql } from "@workspace/runtime/worker/test-utils";
import type { SqlStorage } from "@workspace/runtime/worker";
import { createGmailTables } from "../schema.js";
import { PeopleStore } from "./people-store.js";

const NOW = 1_750_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

async function makeStore(): Promise<PeopleStore> {
  const sql = (await createInMemorySql()) as unknown as SqlStorage;
  createGmailTables(sql);
  return new PeopleStore({ sql, now: () => NOW });
}

describe("PeopleStore", () => {
  it("records incoming/outgoing interactions and counts people per channel", async () => {
    const store = await makeStore();
    store.recordIncoming("ch-1", { email: "A@X.com", name: "Alice", at: NOW - DAY });
    store.recordIncoming("ch-1", { email: "a@x.com", at: NOW });
    store.recordOutgoing("ch-1", [{ email: "b@y.org", name: "Bob" }], NOW);
    store.recordOutgoing("ch-2", [{ email: "c@z.io" }], NOW);

    expect(store.count("ch-1")).toBe(2);
    expect(store.count("ch-2")).toBe(1);
    const [alice] = store.resolve("ch-1", "alice");
    expect(alice).toMatchObject({
      email: "a@x.com",
      displayName: "Alice",
      receivedFrom: 2,
      sentTo: 0,
      lastInteractionAt: NOW,
    });
  });

  it("upgrades display names but never downgrades to email-shaped placeholders", async () => {
    const store = await makeStore();
    store.recordIncoming("ch-1", { email: "a@x.com", at: NOW });
    store.recordOutgoing("ch-1", [{ email: "a@x.com", name: "a@x.com" }], NOW);
    expect(store.suggest("ch-1", "a@x")[0]?.displayName).toBeUndefined();
    store.recordIncoming("ch-1", { email: "a@x.com", name: "Alice Smith", at: NOW });
    expect(store.suggest("ch-1", "a@x")[0]?.displayName).toBe("Alice Smith");
    // A shorter name does not replace a longer real one.
    store.recordIncoming("ch-1", { email: "a@x.com", name: "Alice", at: NOW });
    expect(store.suggest("ch-1", "a@x")[0]?.displayName).toBe("Alice Smith");
  });

  it("ranks by sent*3 + received + replied*10 + recency bonus", async () => {
    const store = await makeStore();
    // frequent: 2 sent (6) + 1 received (1) + recency (5) = 12
    store.recordOutgoing("ch-1", [{ email: "frequent@x.com" }], NOW - DAY);
    store.recordOutgoing("ch-1", [{ email: "frequent@x.com" }], NOW - DAY);
    store.recordIncoming("ch-1", { email: "frequent@x.com", at: NOW - DAY });
    // replied: 1 received (1) + replied (10) + stale (no bonus) = 11
    store.recordIncoming("ch-1", { email: "replied@x.com", at: NOW - 60 * DAY });
    store.markReplied("ch-1", "replied@x.com");
    // quiet: 1 received + recency = 6
    store.recordIncoming("ch-1", { email: "quiet@x.com", at: NOW });

    const byScore = ["frequent@x.com", "replied@x.com", "quiet@x.com"].map(
      (email) => store.suggest("ch-1", email.split("@")[0]!)[0]!
    );
    expect(byScore.map((candidate) => candidate.score)).toEqual([12, 11, 6]);
  });

  it("suggest matches email prefix and display-name substring, ranked", async () => {
    const store = await makeStore();
    store.recordIncoming("ch-1", { email: "alice@x.com", name: "Alice Smith", at: NOW });
    store.recordOutgoing("ch-1", [{ email: "alina@y.org", name: "Alina Jones" }], NOW);
    store.recordIncoming("ch-1", { email: "bob@z.io", name: "Bob", at: NOW });

    const results = store.suggest("ch-1", "ali");
    expect(results.map((candidate) => candidate.email)).toEqual(["alina@y.org", "alice@x.com"]);
    expect(store.suggest("ch-1", "smith").map((candidate) => candidate.email)).toEqual([
      "alice@x.com",
    ]);
    expect(store.suggest("ch-1", "")).toEqual([]);
  });

  it("resolve requires all tokens to hit name or email local part", async () => {
    const store = await makeStore();
    store.recordIncoming("ch-1", { email: "alice.smith@x.com", name: "Alice Smith", at: NOW });
    store.recordIncoming("ch-1", { email: "alice.jones@y.org", name: "Alice Jones", at: NOW });

    expect(store.resolve("ch-1", "alice smith").map((candidate) => candidate.email)).toEqual([
      "alice.smith@x.com",
    ]);
    expect(store.resolve("ch-1", "Alice")).toHaveLength(2);
    // local-part match works without a display name
    store.recordIncoming("ch-1", { email: "smithy@z.io", at: NOW });
    expect(store.resolve("ch-1", "smith").map((candidate) => candidate.email)).toContain(
      "smithy@z.io"
    );
    expect(store.resolve("ch-1", "nobody")).toEqual([]);
  });

  it("markReplied flags the person and boosts ranking", async () => {
    const store = await makeStore();
    store.recordIncoming("ch-1", { email: "a@x.com", at: NOW });
    store.recordIncoming("ch-1", { email: "b@x.com", at: NOW });
    store.markReplied("ch-1", "B@x.com");
    const resolved = store.resolve("ch-1", "b");
    expect(resolved[0]).toMatchObject({ email: "b@x.com", youReplied: true });
    expect(resolved[0]!.score).toBeGreaterThan(store.resolve("ch-1", "a")[0]!.score);
  });
});
