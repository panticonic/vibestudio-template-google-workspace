import { expect, it, vi } from "vitest";
import { prepareOpenGmailGoal } from "./managed.js";
import { matchesComposeIdentity } from "./program/recoverGmailGoal/inspectDraftContinuity/draftIdentity.js";
import type { ProviderRecord, RetainedCompose } from "./program/types.js";

const event = {
  messageId: "event-a",
  id: 1,
  senderId: "case-owner",
  payload: { payload: {
    messageId: "compose-a",
    initialState: { status: "saved", rfcMessageId: "<saved@example.test>", threadId: "thread-a", draftId: "draft-a" },
  } },
};
const fetchEnvelope = vi.hoisted(() => vi.fn());
vi.mock("@workspace/runtime", () => ({ contextId: "owned", rpc: { call: fetchEnvelope } }));
vi.mock("@workspace/pubsub/rpc-contract", () => ({ channelClientRpcMethods: { getEnvelope: {} } }));
vi.mock("@workspace/gmail", () => ({ isGmailApiError: () => false }));
vi.mock("./provider.js", () => ({ ownedGmailProvider: () => ({ readback: () => ({}) }) }));
vi.mock("@workspace-skills/gmail-compose-history-bindings", () => ({
  bindGmailComposeHistory: () => ({
    request: { operationId: "operation-a" },
    services: { gmailComposeHistory: { read: async () => ({
      events: [{ id: "event-a", seq: 1, state: { status: "saved" } }],
    }) } },
  }),
}));

const compose: RetainedCompose = {
  id: "compose-a", channelId: "owned-a", state: "saved", draftId: "draft-a",
  sentId: null, mimeId: "<saved@example.test>", threadId: "thread-a", evidence: ["event-a"],
};
const draft: ProviderRecord = {
  id: "draft-a", messageId: "provider-record-a", mimeId: compose.mimeId, threadId: compose.threadId,
  subject: "pickup", sender: "dispatch@example.test", recipient: "crew@example.test", preview: "", sent: false, digest: "bound",
};

it("verifies the RFC Message-ID separately from Gmail's message identifier", () => {
  expect(matchesComposeIdentity(compose, draft)).toBe(true);
  expect(matchesComposeIdentity(compose, { ...draft, messageId: compose.mimeId, mimeId: "<other@example.test>" })).toBe(false);
  expect(matchesComposeIdentity(compose, { ...draft, threadId: "thread-foreign" })).toBe(false);
});

it("replays the same bound read without allowing a different compose", async () => {
  fetchEnvelope.mockResolvedValue(event);
  const input = { contextId: "owned", caseId: "case-a" };
  const source = {
    key: "a", title: "Pickup", room: "Event logistics", channelId: "owned-a",
    targetId: "target-a", messageId: "compose-a", ownerId: "case-owner", envelopeIds: ["event-a"],
  };
  const { services } = await prepareOpenGmailGoal(input, {
    id: input.caseId, goal: "Read the saved pickup draft", provider: { drafts: [] },
    expected: { compose: "a", status: "confirmed", requests: [], operations: [], providerId: null },
  }, { ...input, sources: [source, { ...source, key: "b", messageId: "compose-b" }] });
  await expect(services.gmailGoalCompose.read(compose.id)).rejects.toThrow("authorized catalog");
  await services.gmailGoalCatalog.discover();
  expect(await services.gmailGoalCompose.read(compose.id)).toEqual(compose);
  expect(await services.gmailGoalCompose.read(compose.id)).toEqual(compose);
  await expect(services.gmailGoalCompose.read("compose-b")).rejects.toThrow("authorized catalog");
  expect(fetchEnvelope).toHaveBeenCalledTimes(1);
});
