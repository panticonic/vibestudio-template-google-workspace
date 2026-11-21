import { expect, it, vi } from "vitest";
import { prepareOpenCalendarGoal, type OpenCalendarWorld } from "./managed.js";
import type { Event } from "./provider.js";

vi.mock("@workspace/runtime", () => ({ contextId: "owned-context", fs: {} }));

const owner = { contextId: "owned-context", caseId: "review-window" };
const start = "2026-10-22T09:00:00.000Z";
const end = "2026-10-22T12:00:00.000Z";
const proposal: Event = {
  id: "review",
  status: "confirmed",
  start: { dateTime: "2026-10-22T10:00:00Z" },
  end: { dateTime: "2026-10-22T11:00:00Z" },
};
const world: OpenCalendarWorld = {
  id: owner.caseId,
  goal: "Check the latest review proposal against the meeting room calendar.",
  window: { start, end },
  timelines: [
    { id: "review", name: "Review", description: "", timeZone: "UTC", initial: [[proposal]] },
    { id: "room", name: "Room", description: "", timeZone: "UTC", initial: [[]] },
  ],
  catalogPageSize: 1,
  canStage: false,
  expected: {
    scope: ["review", "room"],
    refresh: true,
    status: "selected",
    selection: { calendarId: "review", eventId: proposal.id },
    evidence: [],
    verify: { calendarId: "review", eventId: proposal.id },
    stage: false,
  },
};

it.each([true, false])("verifies the per-calendar observation sequence with room refresh=%s", async (refreshRoom) => {
  const prepared = await prepareOpenCalendarGoal(owner, world);
  const { calendarGoalCatalog, calendarGoalWindows, calendarGoalReadback } = prepared.services;
  await calendarGoalCatalog.discover();
  const review = await calendarGoalWindows.open("review", start, end);
  const freshReview = await calendarGoalWindows.refresh(review.id);
  const room = await calendarGoalWindows.open("room", start, end);
  if (refreshRoom) await calendarGoalWindows.refresh(room.id);
  const selection = freshReview.records[0]!;
  await calendarGoalReadback.verify(selection);

  const proof = await prepared.verify({
    decision: { status: "selected", selection, evidence: [] },
    handoff: null,
  });
  expect(proof.checks.exactCalendarWindows).toBe(refreshRoom);
  expect(proof.passed).toBe(refreshRoom);
});
