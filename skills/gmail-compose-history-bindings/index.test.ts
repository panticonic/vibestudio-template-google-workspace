import { AGENTIC_EVENT_PAYLOAD_KIND, AGENTIC_PROTOCOL_VERSION } from "@workspace/agentic-protocol";
import { channelClientRpcMethods } from "@workspace/pubsub/rpc-contract";
import { doTargetId } from "@vibestudio/shared/workspaceServiceRpc";
import { beforeEach, expect, it, vi } from "vitest";
import { bindGmailComposeHistory } from "./index.js";

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@workspace/runtime", () => ({ contextId: "owned-context", rpc: { call } }));

function envelope(id: number, kind: string, data: object, senderId = "owner") {
  return {
    id, messageId: `native-${id}`, senderId, type: AGENTIC_EVENT_PAYLOAD_KIND,
    payload: {
      kind,
      actor: { kind: "agent", id: senderId },
      createdAt: "2026-11-19T00:00:00.000Z",
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, messageId: "assigned-card", ...data },
    },
  };
}
const start = envelope(10, "custom.started", {
  typeId: "gmail.compose",
  initialState: { to: "recipient@example.test", subject: "private subject", body: "private body", status: "review" },
});
function fixture() {
  return bindGmailComposeHistory({
    goal: "Check draft status", channelId: "owned-channel", messageId: "assigned-card",
    targetId: doTargetId({ source: "workers/pubsub-channel", className: "PubSubChannel", objectKey: "owned-channel" }),
    ownerId: "owner", envelopeIds: ["native-10", "native-13"],
  });
}
function configure(update: ReturnType<typeof envelope>) {
  call.mockImplementation(async (_target, method, args) => {
    if (method.name === channelClientRpcMethods.getContextId.name) return "owned-context";
    if (method.name === channelClientRpcMethods.getEnvelope.name) return args[0] === "native-10" ? start : update;
    throw new Error("Unexpected method");
  });
}
beforeEach(() => { call.mockReset(); });

it("folds the exact owned card and leaves recipient and message content out of the receipt", async () => {
  configure(envelope(13, "custom.updated", { update: { status: "saved", draftId: "accepted-draft" } }));
  const { request, services } = fixture();
  await expect(services.gmailComposeHistory.read("outside")).rejects.toThrow("assigned");
  expect(call).not.toHaveBeenCalled();
  const receipt = await services.gmailComposeHistory.read(request.operationId);
  expect(receipt.events[1]).toEqual({
    id: "native-13", seq: 13, event: "update",
    state: {
      status: "saved", draftId: "accepted-draft", recipientPresent: true, alias: "default",
      mimeIdentity: false, sentIdentity: false,
    },
  });
  expect(JSON.stringify(receipt)).not.toMatch(/private|recipient@example/u);
});

it("rejects a native update belonging to another participant", async () => {
  configure(envelope(13, "custom.updated", { update: { status: "saved" } }, "other-owner"));
  const { request, services } = fixture();
  await expect(services.gmailComposeHistory.read(request.operationId)).rejects.toThrow("assigned compose lineage");
});
