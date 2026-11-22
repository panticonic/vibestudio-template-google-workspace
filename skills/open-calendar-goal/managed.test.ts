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

it.each([true, false])("accepts a correct current decision with room refresh=%s", async (refreshRoom) => {
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
  expect(proof.checks.groundedCalendarEvidence).toBe(true);
  expect(proof.passed).toBe(true);
});

it("joins concurrent and repeated reads without advancing the provider snapshots twice", async () => {
  const revised = { ...proposal, summary: "Updated review" };
  const prepared = await prepareOpenCalendarGoal(owner, {
    ...world,
    timelines: [{ ...world.timelines[0]!, refresh: [[revised]] }, world.timelines[1]!],
  });
  const { calendarGoalCatalog, calendarGoalWindows: windows, calendarGoalReadback } = prepared.services;
  await calendarGoalCatalog.discover();
  const [unauthorized, review, room, repeated] = await Promise.allSettled([
    windows.open("outside", start, end),
    windows.open("review", start, end),
    windows.open("room", start, end),
    windows.open("review", start, end),
  ]);
  expect(unauthorized.status).toBe("rejected");
  if (review.status !== "fulfilled" || room.status !== "fulfilled" || repeated.status !== "fulfilled")
    throw new Error("Authorized calendar reads must complete");
  expect(repeated.value).toEqual(review.value);
  const [fresh, , retried] = await Promise.all([
    windows.refresh(review.value.id),
    windows.refresh(room.value.id),
    windows.refresh(review.value.id),
  ]);
  expect(fresh.records[0]?.title).toBe("Updated review");
  expect(retried).toEqual(fresh);
  await expect(windows.open("review", start, end)).resolves.toEqual(review.value);
  const selection = fresh.records[0]!;
  await Promise.all([calendarGoalReadback.verify(selection), calendarGoalReadback.verify(selection)]);
  const proof = await prepared.verify({ decision: { status: "selected", selection, evidence: [] }, handoff: null });
  expect(proof.passed).toBe(true);
  expect(proof.attempts).toHaveLength(4);
});
