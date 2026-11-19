import { doTargetId } from "@vibestudio/shared/workspaceServiceRpc";
import { AGENTIC_EVENT_PAYLOAD_KIND, storedAgenticEventSchema } from "@workspace/agentic-protocol";
import { channelClientRpcMethods } from "@workspace/pubsub/rpc-contract";
import { contextId, rpc } from "@workspace/runtime";
import type {
  ComposeAuditKind,
  ComposeHistoryReceipt,
  ComposeHistoryState,
  GmailCompose,
} from "../gmail-workflow-review/types.js";

type Assignment = {
  goal: string;
  channelId: string;
  targetId: string;
  messageId: string;
  ownerId: string;
  envelopeIds: string[];
};
const statuses = new Set<ComposeHistoryState["status"]>([
  "drafting", "review", "saving", "saved", "sending", "delivery-unknown",
  "sent", "discarding", "discarded", "error",
]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The compose event supplied no object state");
  return value as Record<string, unknown>;
}

function present(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function project(state: Record<string, unknown>): ComposeHistoryState {
  const status = state["status"] as ComposeHistoryState["status"];
  if (!statuses.has(status)) throw new Error("The compose card has an unknown state");
  const from = state["from"];
  const aliases = state["fromOptions"];
  return {
    status,
    recipientPresent: present(state["to"]),
    alias: !present(from) ? "default" : Array.isArray(aliases) && aliases.includes(from) ? "configured" : "unknown",
    draftId: present(state["draftId"]) ? state["draftId"] : null,
    mimeIdentity: present(state["rfcMessageId"]),
    sentIdentity: present(state["sentMessageId"]),
  };
}

export function bindGmailComposeHistory(input: Assignment) {
  const { channelId, targetId, messageId, ownerId, envelopeIds, goal } = structuredClone(input);
  if (!contextId || ![channelId, messageId, ownerId, goal].every(present) ||
    targetId !== doTargetId({ source: "workers/pubsub-channel", className: "PubSubChannel", objectKey: channelId }) ||
    !envelopeIds.length || envelopeIds.length > 12 ||
    new Set(envelopeIds).size !== envelopeIds.length || !envelopeIds.every(present))
    throw new Error("Assign an owned compose card and ordered channel cursor");
  const request = { goal, operationId: crypto.randomUUID() };
  let pending: Promise<ComposeHistoryReceipt> | undefined;

  async function read(): Promise<ComposeHistoryReceipt> {
    if (await rpc.call(targetId, channelClientRpcMethods.getContextId, []) !== contextId)
      throw new Error("The selected channel belongs to another context");
    const events: ComposeHistoryReceipt["events"] = [];
    let state: Record<string, unknown> = {};
    for (const [index, id] of envelopeIds.entries()) {
      const envelope = await rpc.call(targetId, channelClientRpcMethods.getEnvelope, [id]);
      if (!envelope || envelope.messageId !== id || envelope.senderId !== ownerId ||
        envelope.type !== AGENTIC_EVENT_PAYLOAD_KIND ||
        !Number.isSafeInteger(envelope.id) || envelope.id <= (events.at(-1)?.seq ?? -1))
        throw new Error("The selected envelope is outside the assigned compose lineage");
      const event = storedAgenticEventSchema.parse(envelope.payload);
      const payload = record(event.payload);
      if (payload["messageId"] !== messageId)
        throw new Error("The selected envelope is for another compose card");
      let kind: ComposeHistoryReceipt["events"][number]["event"];
      if (index === 0 && event.kind === "custom.started" && payload["typeId"] === "gmail.compose") {
        state = record(payload["initialState"]);
        kind = "start";
      } else if (index > 0 && event.kind === "custom.updated") {
        state = { ...state, ...record(payload["update"]) };
        kind = payload["status"] === "failed" ? "failed-update" : "update";
      } else {
        throw new Error("Start with the compose creation followed by its updates");
      }
      events.push({ id, seq: envelope.id, event: kind, state: project(state) });
    }
    return { channelId, messageId, events };
  }

  function assignedReceipt(id: string) {
    if (id !== request.operationId)
      throw new Error("Read only the caller's assigned compose history");
    return pending ??= read();
  }

  return {
    request,
    services: {
      gmailComposeHistory: {
        async read(id: string): Promise<ComposeHistoryReceipt> {
          return structuredClone(await assignedReceipt(id));
        },
      },
      gmailComposeAudit: {
        async project(id: string, kind: ComposeAuditKind): Promise<GmailCompose> {
          const receipt = await assignedReceipt(id);
          const latest = receipt.events.at(-1)!;
          const { status, recipientPresent, alias, draftId } = latest.state;
          if (status !== "drafting" && status !== "review" && status !== "saved" &&
            status !== "sending" && status !== "delivery-unknown" && status !== "sent")
            throw new Error("The current compose stage has no review projection");
          const target = {
            id: receipt.events[0]!.id, channelId, accountRef: "channel-only:" + channelId,
          };
          const beforeDraft = receipt.events.slice(0, -1).findLast(({ state }) => state.draftId !== null)
            ?.state.draftId ?? null;
          if (kind !== "draft" && kind !== "reconcile")
            throw new Error("Select draft or delivery reconciliation evidence");
          return {
            kind: "compose",
            goal,
            scope: { target, observed: { ...target, id: latest.id, binding: "channel-readback" } },
            card: {
              id: latest.id, messageId: receipt.messageId, requestedMessageId: messageId,
              ownedByChannel: true, state: status, hasRecipient: recipientPresent, alias,
            },
            readback: kind === "draft"
              ? { kind, id: latest.id, origin: "channel-readback", beforeDraft, afterDraft: draftId }
              : { kind, id: latest.id, providerProof: "not-checked" },
          };
        },
      },
    },
  };
}
