import { expect, it, vi } from "vitest";
vi.mock("@workspace/runtime", () => ({ contextId: "owned", fs: {} }));
import { prepareOpenGoogleHandoffGoal } from "./managed.js";
it("retains earlier message-linked content after reading another owned link to the same file", async () => {
  const content = "actual bytes " + "verified native content ".repeat(10);
  const intent = { messageId: "message-a", fileId: "file", mode: "content" as const };
  const decision = { status: "ready" as const, reason: "approved" as const, mailIds: ["message-a"], assetIds: ["file"], facts: [{ fileId: "file", quote: "actual bytes" }] };
  const prepared = await prepareOpenGoogleHandoffGoal({ contextId: "owned", caseId: "review" }, {
    id: "review", goal: "Check the approved file's actual content", canStage: "none", provider: {
      pages: [["thread"]], threads: [{ id: "thread", messages: ["a", "b"].map(key => ({ id: "message-" + key, from: "owner@example.test", subject: "Owned file", receivedAt: "2026-11-23T00:00:00Z", body: "Read https://drive.google.com/file/d/file/view" })) }],
      files: [{ id: "file", initial: { metadata: { id: "file", name: "Owned file", mimeType: "text/plain", version: "1" }, bytes: content } }],
    }, expected: { reviews: [intent], decision, stage: false, verify: { before: decision, result: "current" } },
  });
  const s = prepared.services;
  await s.googleHandoffMail.discover(); await s.googleHandoffMail.read("thread");
  await s.googleHandoffDrive.inspect(intent);
  await s.googleHandoffDrive.inspect({ ...intent, messageId: "message-b", mode: "metadata" });
  expect(await s.googleHandoffFreshness.verify(decision)).toBe("current");
  expect((await prepared.verify({ decision, handoff: null })).passed).toBe(true);
  const supported = {decision:{...decision,mailIds:["message-a","message-b"],facts:[{fileId:"file",quote:content}]},handoff:null};
  const proof = await prepared.verify(supported);
  expect(proof.passed).toBe(true);
  expect(proof.semanticReviewRequired).toBe(true);
  expect(proof.semanticReviewInput.actual.requestedReturn).toEqual(supported);
  expect(proof.semanticReviewInput.actual.observations.reviews).toEqual(proof.reviews);
  expect((await prepared.verify({decision:{...decision,assetIds:["foreign"]},handoff:null})).passed).toBe(false);
  await expect(s.googleHandoffDrive.inspect({ ...intent, messageId: "foreign" })).rejects.toThrow("observed message");
  expect((await prepared.verify({ decision: { ...decision, facts: [{ fileId: "file", quote: "invented bytes" }] }, handoff: null })).passed).toBe(false);
});

it("reacquires an unavailable content projection instead of caching the failed read forever", async () => {
  const metadata = { id: "file", name: "Owned file", mimeType: "text/plain", version: "1" };
  const prepared = await prepareOpenGoogleHandoffGoal({ contextId: "owned", caseId: "retry" }, {
    id: "retry", goal: "Read the owned file when the content transport recovers", canStage: "none", provider: {
      pages: [["thread"]], threads: [{ id: "thread", messages: [{ id: "mail", from: "owner@example.test", subject: "Read", receivedAt: "2026-11-23T00:00:00Z", body: "https://drive.google.com/file/d/file/view" }] }],
      files: [{ id: "file", initial: { metadata, bytes: 503 }, next: { metadata, bytes: "recovered actual bytes" } }],
    }, expected: { reviews: [], decision: { status: "incomplete", reason: "provider", mailIds: ["mail"], assetIds: ["file"] }, stage: false },
  });
  const s = prepared.services;
  await s.googleHandoffMail.discover(); await s.googleHandoffMail.read("thread");
  const intent = { messageId: "mail", fileId: "file", mode: "content" as const };
  expect((await s.googleHandoffDrive.inspect(intent)).missingChecks).toContain("content");
  expect((await s.googleHandoffDrive.inspect(intent)).content?.text).toBe("recovered actual bytes");
});
