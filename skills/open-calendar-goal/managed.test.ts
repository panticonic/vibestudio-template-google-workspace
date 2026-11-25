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
  const optionalEcho = await prepared.verify({
    decision: { status: "selected", selection, evidence: [] },
    handoff: { path: "/invented", bytes: 1, sha256: "invented" },
  });
  expect(optionalEcho.passed).toBe(true);
  expect(optionalEcho.outcomeDimensions.effects.passed).toBe(true);
  expect(optionalEcho.outcomeDimensions.incidentalValues?.checks.returnedCalendarHandoff).toBe(false);
  const native = await prepared.verifyObserved();
  expect(native.passed).toBe(true);
  expect(native.checks).not.toHaveProperty("reconciledCalendarDecision");
  expect((await prepared.verify({ decision: { status: "held", selection: null, evidence: [] }, handoff: null })).passed).toBe(false);
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

it("keeps issued event readbacks usable after other owned event/window observations", async () => {
  const prepared = await prepareOpenCalendarGoal(owner, { ...world,
    timelines: [{ ...world.timelines[0]!, initial: [[proposal, { ...proposal, id: "other", summary: "Another proposal" }]] }, world.timelines[1]!],
  });
  const { calendarGoalCatalog, calendarGoalWindows: windows, calendarGoalReadback: readback } = prepared.services;
  await calendarGoalCatalog.discover();
  const opened = await windows.open("review", start, end);
  const current = await windows.refresh(opened.id);
  const selection = current.records.find(row => row.eventId === proposal.id)!;
  await readback.verify(selection);
  // Neither another issued candidate nor a later source-window read invalidates this receipt.
  await readback.verify(current.records.find(row => row.eventId === "other")!);
  const room = await windows.open("room", start, end);
  await windows.refresh(room.id);
  expect(await readback.verify(selection)).toMatchObject({ status: "current" });
  const report = { decision: { status: "selected", selection, evidence: [] }, handoff: null };
  expect((await prepared.verify(report)).passed).toBe(true);
  const supported = {...report,decision:{...report.decision,evidence:current.records}};
  const proof = await prepared.verify(supported);
  expect(proof.passed).toBe(true);
  expect(proof.semanticReviewRequired).toBe(true);
  expect(proof.semanticReviewInput.actual.requestedReturn).toEqual(supported);
  expect(proof.semanticReviewInput.actual.observations.windows).toEqual(proof.windows);
  expect((await prepared.verify({...report,decision:{...report.decision,evidence:[{...selection,eventId:"foreign"}]}})).passed).toBe(false);
  await expect(readback.verify({ ...selection, calendarId: "foreign" })).rejects.toThrow("observed");
  expect((await prepared.verify({ ...report, decision: { ...report.decision, selection: { ...selection, updated: "stale" } } })).passed).toBe(false);
});

it("grounds a moved event in its exact current readback without authorizing a stale handoff", async () => {
  const moved = {...proposal, updated:"2026-10-22T08:30:00Z",start:{dateTime:"2026-10-22T14:00:00Z"},end:{dateTime:"2026-10-22T15:00:00Z"}};
  const revisedWorld:OpenCalendarWorld = {...world,canStage:true,timelines:[{...world.timelines[0]!,readback:{[proposal.id]:moved}},world.timelines[1]!],expected:{...world.expected,status:"stale",selection:null,evidence:[{calendarId:"review",eventId:proposal.id,source:"readback"}]}};
  const prepared = await prepareOpenCalendarGoal(owner,revisedWorld);
  const proof = await prepared.qualify();
  expect(proof.passed).toBe(true);expect(proof.checks.groundedCalendarEvidence).toBe(true);
  expect(proof.readback?.observed).toMatchObject({status:"changed",record:{startsAt:"2026-10-22T14:00:00.000Z"}});
  const original=proof.readback!.requested;
  await expect(prepared.services.calendarGoalHandoff.stage({status:"selected",selection:original,evidence:[]})).rejects.toThrow("current Calendar evidence");
  const invented={...proof.report,decision:{...proof.report.decision,evidence:[{...proof.report.decision.evidence[0]!,startsAt:"2026-10-22T13:00:00.000Z"}]}};
  expect((await prepared.verify(invented)).passed).toBe(false);
  const unread = await prepareOpenCalendarGoal(owner,revisedWorld);
  const services=unread.services;await services.calendarGoalCatalog.discover();
  for(const id of revisedWorld.expected.scope){const opened=await services.calendarGoalWindows.open(id,start,end);await services.calendarGoalWindows.refresh(opened.id);}
  expect((await unread.verify(proof.report)).checks.groundedCalendarEvidence).toBe(false);
  expect((await unread.verify(proof.report)).passed).toBe(false);
});
