import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_HOP_LIMIT,
  resolveShouldRespond,
  type ResolveShouldRespondInput,
} from "./addressing.js";

function input(overrides: {
  event?: Partial<ResolveShouldRespondInput["event"]>;
  [key: string]: unknown;
}): ResolveShouldRespondInput {
  const { event, ...rest } = overrides;
  return {
    event: {
      senderParticipantId: "user-1",
      senderKind: "user",
      ...event,
    },
    self: { participantId: "agent-a" },
    policy: "mentioned",
    participantIds: ["user-1", "agent-a", "agent-b"],
    lastCompletedSender: null,
    ...(rest as Partial<ResolveShouldRespondInput>),
  };
}

describe("resolveShouldRespond", () => {
  it("never responds to own messages", () => {
    const decision = resolveShouldRespond(
      input({ event: { senderParticipantId: "agent-a" }, policy: "all" })
    );
    expect(decision.respond).toBe(false);
    expect(decision.reason).toBe("own message");
  });

  it("hard-refuses when `to` excludes self, even under policy all", () => {
    const decision = resolveShouldRespond(
      input({
        policy: "all",
        event: { to: [{ kind: "participant", participantId: "agent-b" }] },
      })
    );
    expect(decision.respond).toBe(false);
  });

  it("responds when `to` targets self", () => {
    const decision = resolveShouldRespond(
      input({ event: { to: [{ kind: "participant", participantId: "agent-a" }] } })
    );
    expect(decision.respond).toBe(true);
  });

  it("matches role selectors against self roles", () => {
    const decision = resolveShouldRespond(
      input({
        self: { participantId: "agent-a", roles: ["reviewer"] },
        event: { to: [{ kind: "role", role: "reviewer" }] },
      })
    );
    expect(decision.respond).toBe(true);
  });

  it("responds on mention regardless of other participants", () => {
    const decision = resolveShouldRespond(input({ event: { mentions: ["agent-a"] } }));
    expect(decision.respond).toBe(true);
  });

  it("responds when replying to self's message", () => {
    const decision = resolveShouldRespond(
      input({ event: { replyTo: "msg-1", replyToSenderId: "agent-a" } })
    );
    expect(decision.respond).toBe(true);
  });

  describe("mentioned (default)", () => {
    it("responds when self is the only other participant", () => {
      const decision = resolveShouldRespond(input({ participantIds: ["user-1", "agent-a"] }));
      expect(decision.respond).toBe(true);
      expect(decision.reason).toBe("only other participant");
    });

    it("stays silent in a multi-agent channel without a mention", () => {
      const decision = resolveShouldRespond(input({}));
      expect(decision.respond).toBe(false);
    });
  });

  describe("mentioned-strict", () => {
    it("only responds when explicitly addressed", () => {
      expect(
        resolveShouldRespond(
          input({ policy: "mentioned-strict", participantIds: ["user-1", "agent-a"] })
        ).respond
      ).toBe(false);
      expect(
        resolveShouldRespond(
          input({ policy: "mentioned-strict", event: { mentions: ["agent-a"] } })
        ).respond
      ).toBe(true);
    });
  });

  describe("mentioned-or-followup", () => {
    it("uses the durable last-completed sender", () => {
      expect(
        resolveShouldRespond(
          input({ policy: "mentioned-or-followup", lastCompletedSender: "agent-a" })
        ).respond
      ).toBe(true);
      expect(
        resolveShouldRespond(
          input({ policy: "mentioned-or-followup", lastCompletedSender: "agent-b" })
        ).respond
      ).toBe(false);
    });

    it("responds to an explicit @mention (the 'mentioned' half), not only a followup", () => {
      const decision = resolveShouldRespond(
        input({ policy: "mentioned-or-followup", event: { mentions: ["agent-a"] } })
      );
      expect(decision.respond).toBe(true);
      expect(decision.reason).toBe("explicitly addressed");
    });
  });

  describe("from-participants", () => {
    it("respects the allow-list", () => {
      expect(
        resolveShouldRespond(
          input({ policy: "from-participants", respondFrom: ["user-1"] })
        ).respond
      ).toBe(true);
      expect(
        resolveShouldRespond(
          input({ policy: "from-participants", respondFrom: ["user-2"] })
        ).respond
      ).toBe(false);
    });
  });

  describe("agent senders (echo suppression)", () => {
    it("does not pile onto unaddressed agent messages under policy all", () => {
      const decision = resolveShouldRespond(
        input({ policy: "all", event: { senderParticipantId: "agent-b", senderKind: "agent" } })
      );
      expect(decision.respond).toBe(false);
      expect(decision.reason).toContain("agent sender");
    });

    it("responds to agent messages that mention self", () => {
      const decision = resolveShouldRespond(
        input({
          event: {
            senderParticipantId: "agent-b",
            senderKind: "agent",
            mentions: ["agent-a"],
            agentHops: 1,
          },
        })
      );
      expect(decision.respond).toBe(true);
    });

    it("open channels allow agent messages through like user messages", () => {
      const decision = resolveShouldRespond(
        input({
          policy: "all",
          conversationPolicy: "open",
          event: { senderParticipantId: "agent-b", senderKind: "agent", agentHops: 1 },
        })
      );
      expect(decision.respond).toBe(true);
    });

    it("refuses past the hop cap even when explicitly addressed", () => {
      const decision = resolveShouldRespond(
        input({
          event: {
            senderParticipantId: "agent-b",
            senderKind: "agent",
            mentions: ["agent-a"],
            agentHops: DEFAULT_AGENT_HOP_LIMIT,
          },
        })
      );
      expect(decision.respond).toBe(false);
      expect(decision.reason).toContain("hop limit");
    });

    it("honors a channel-configured hop limit", () => {
      const decision = resolveShouldRespond(
        input({
          agentHopLimit: 10,
          event: {
            senderParticipantId: "agent-b",
            senderKind: "agent",
            mentions: ["agent-a"],
            agentHops: 5,
          },
        })
      );
      expect(decision.respond).toBe(true);
    });
  });

  describe("moderated channels", () => {
    it("requires explicit addressing for everyone", () => {
      expect(
        resolveShouldRespond(
          input({
            policy: "all",
            conversationPolicy: "moderated",
          })
        ).respond
      ).toBe(false);
      expect(
        resolveShouldRespond(
          input({
            policy: "all",
            conversationPolicy: "moderated",
            event: { mentions: ["agent-a"] },
          })
        ).respond
      ).toBe(true);
    });
  });
});
