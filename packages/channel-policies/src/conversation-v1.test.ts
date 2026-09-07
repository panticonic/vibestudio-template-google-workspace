import { describe, expect, it } from "vitest";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  eventKindSchemas,
} from "@workspace/agentic-protocol";
import {
  AGENTIC_EVENT_AUDIENCE_POLICY,
  assertDeclaredAgenticEventAudience,
  conversationV1Policy,
  resolveChannelPolicies,
  getChannelPolicy,
  DEFAULT_CHANNEL_POLICIES,
  type PolicyEnvelopeView,
} from "./index.js";

function completedEnvelope(
  seq: number,
  senderId: string,
  actorKind: "agent" | "user" | "panel",
  appendedAt = `2026-05-20T12:00:0${seq}.000Z`,
  extraCausality: Record<string, unknown> = {}
): PolicyEnvelopeView {
  return {
    envelopeId: `env-${seq}`,
    seq,
    payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
    payload: {
      kind: "message.completed",
      actor: { kind: actorKind, id: senderId },
      causality: { messageId: `msg-${seq}`, ...extraCausality },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant", outcome: "completed" },
      createdAt: appendedAt,
    },
    senderId,
    senderKind: actorKind,
    appendedAt,
  };
}

function opaqueEnvelope(seq: number): PolicyEnvelopeView {
  return {
    envelopeId: `env-${seq}`,
    seq,
    payloadKind: "custom.kind",
    payload: { value: seq },
    senderId: "panel:user",
    senderKind: "panel",
    appendedAt: `2026-05-20T12:00:0${seq}.000Z`,
  };
}

describe("agentic.conversation.v1", () => {
  it("declares an audience policy for every protocol event kind", () => {
    expect(Object.keys(AGENTIC_EVENT_AUDIENCE_POLICY).sort()).toEqual(
      Object.keys(eventKindSchemas).sort()
    );
    expect(() =>
      assertDeclaredAgenticEventAudience({
        kind: "invocation.started",
        actor: { kind: "agent", id: "agent:a" },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          name: "eval",
          invocationType: "tool",
          request: {},
          transport: {
            kind: "channel",
            channelId: "channel-1",
            target: { kind: "agent", id: "agent:a" },
            transportCallId: "transport-1",
          },
          userVisible: false,
        },
        createdAt: "2026-05-20T12:00:00.000Z",
      } as never)
    ).toThrow(/requires an explicit participant audience/u);
    expect(() =>
      assertDeclaredAgenticEventAudience({
        kind: "ui.feedback",
        actor: { kind: "system", id: "channel" },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          target: { kind: "agent", id: "agent:a", participantId: "agent:a" },
          category: "method_call_failed",
          error: { message: "failed" },
        },
        createdAt: "2026-05-20T12:00:00.000Z",
      } as never)
    ).toThrow(/requires an explicit participant audience/u);
  });
  it("folds completed messages into conversation state with previous-slot shifting", () => {
    const policy = conversationV1Policy;
    let state = policy.init();
    state = policy.reduce(state, opaqueEnvelope(1));
    state = policy.reduce(state, completedEnvelope(2, "user:1", "user"));
    state = policy.reduce(state, completedEnvelope(3, "agent:a", "agent"));
    state = policy.reduce(state, completedEnvelope(4, "agent:a", "agent"));

    expect(state).toEqual({
      lastCompletedSender: "agent:a",
      lastCompletedMessageId: "msg-4",
      lastCompletedSeq: 4,
      lastCompletedAt: "2026-05-20T12:00:04.000Z",
      previousCompletedSender: "agent:a",
      previousCompletedMessageId: "msg-3",
      previousCompletedSeq: 3,
      // Two completed messages from the SAME agent (one multi-round turn) = ONE hop, not
      // two — the author never changed. (Was 2 before the hop-vs-message-count fix.)
      agentStreak: 1,
    });

    // a user-completed message resets the streak
    const reset = policy.reduce(state, completedEnvelope(5, "user:1", "user"));
    expect(reset.agentStreak).toBe(0);
    expect(reset.previousCompletedSender).toBe("agent:a");
  });

  it("counts agent→agent hops (author alternations), not model-call rounds within a turn", () => {
    const policy = conversationV1Policy;
    let state = policy.init();
    state = policy.reduce(state, completedEnvelope(1, "user:1", "user"));

    // One agent turn emits a `message.completed` per model-call round (same sender). However
    // many rounds, that's a SINGLE hop — otherwise a heavy-tool-use turn self-trips the agent
    // hop breaker (the chat-storm bug).
    for (let seq = 2; seq <= 12; seq += 1) {
      state = policy.reduce(state, completedEnvelope(seq, "agent:a", "agent"));
    }
    expect(state.agentStreak).toBe(1);

    // A different author replying IS a real hop; alternation accrues.
    state = policy.reduce(state, completedEnvelope(13, "agent:b", "agent"));
    expect(state.agentStreak).toBe(2);
    state = policy.reduce(state, completedEnvelope(14, "agent:a", "agent"));
    expect(state.agentStreak).toBe(3);

    // A human message resets the chain.
    state = policy.reduce(state, completedEnvelope(15, "user:1", "user"));
    expect(state.agentStreak).toBe(0);
  });

  it("replay-fold equals incremental fold (cache derivation is pure)", () => {
    const policy = conversationV1Policy;
    const script = [
      opaqueEnvelope(1),
      completedEnvelope(2, "user:1", "user"),
      completedEnvelope(3, "agent:a", "agent"),
      opaqueEnvelope(4),
      completedEnvelope(5, "agent:b", "agent"),
    ];
    const oneShot = script.reduce((state, env) => policy.reduce(state, env), policy.init());
    let incremental = policy.init();
    for (const env of script) incremental = policy.reduce(incremental, env);
    expect(incremental).toEqual(oneShot);
    // determinism: same inputs, same output, independent of wall clock
    const again = script.reduce((state, env) => policy.reduce(state, env), policy.init());
    expect(again).toEqual(oneShot);
  });

  it("annotates agent-authored completed drafts with agentHops without touching the payload", () => {
    const policy = conversationV1Policy;
    let state = policy.init();
    state = policy.reduce(state, completedEnvelope(2, "agent:a", "agent"));

    const payload = completedEnvelope(3, "agent:a", "agent").payload as Record<string, unknown>;
    const draft = {
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      payload,
      senderId: "agent:a",
      senderKind: "agent",
    };
    const before = JSON.stringify(payload);
    // agent:a continuing its own turn (last completed was also agent:a) is NOT a new hop.
    expect(policy.annotate(state, draft)).toEqual({ agentHops: 1 });
    expect(JSON.stringify(payload)).toBe(before);

    // A DIFFERENT author replying IS a new hop (streak + 1).
    const draftB = {
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: completedEnvelope(3, "agent:b", "agent").payload,
      senderId: "agent:b",
      senderKind: "agent" as const,
    };
    expect(policy.annotate(state, draftB)).toEqual({ agentHops: 2 });

    // explicit caller-computed hops win
    const explicit = completedEnvelope(3, "agent:a", "agent", undefined, { agentHops: 7 })
      .payload as Record<string, unknown>;
    expect(policy.annotate(state, { ...draft, payload: explicit })).toEqual({ agentHops: 7 });

    // user-authored drafts are not annotated
    expect(
      policy.annotate(state, {
        ...draft,
        payload: completedEnvelope(3, "user:1", "user").payload,
      })
    ).toBeNull();
    // opaque drafts are not annotated
    expect(
      policy.annotate(state, {
        payloadKind: "custom.kind",
        payload: { value: 1 },
        senderId: "agent:a",
        senderKind: "agent",
      })
    ).toBeNull();
  });

  it("builds call-transport events purely from injected timestamps", () => {
    const builders = conversationV1Policy.callEventPayload!;
    expect(Object.keys(builders).sort()).toEqual(["cancelled", "output", "started", "terminal"]);
    const caller = { kind: "panel" as const, id: "panel:caller", participantId: "panel:caller" };
    const target = {
      kind: "panel" as const,
      id: "panel:provider",
      participantId: "panel:provider",
    };
    const createdAt = "2026-05-20T12:00:00.000Z";

    const started = builders.started({
      channelId: "channel-1",
      caller,
      target,
      invocationId: "inv-1",
      transportCallId: "transport-1",
      turnId: "turn-1",
      method: "eval",
      args: { code: "1 + 1" },
      deadlineAt: 1750000000000,
      createdAt,
    });
    expect(started).toMatchObject({
      kind: "invocation.started",
      actor: caller,
      turnId: "turn-1",
      causality: { invocationId: "inv-1", transportCallId: "transport-1" },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "eval",
        invocationType: "panel",
        request: { code: "1 + 1" },
        transport: {
          kind: "channel",
          channelId: "channel-1",
          target,
          transportCallId: "transport-1",
          deadlineAt: 1750000000000,
        },
        to: [{ kind: "participant", participantId: target.participantId }],
        userVisible: false,
      },
      createdAt,
    });

    const descriptor = {
      channelId: "channel-1",
      caller,
      invocationId: "inv-1",
      transportCallId: "transport-1",
      turnId: "turn-1",
      method: "eval",
    };
    expect(builders.terminal({ descriptor, result: 2, isError: false, createdAt })).toMatchObject({
      kind: "invocation.completed",
      payload: {
        result: 2,
        terminalOutcome: "success",
        to: [{ kind: "participant", participantId: caller.participantId }],
      },
      createdAt,
    });
    expect(
      builders.terminal({
        descriptor,
        result: "boom",
        isError: true,
        terminalOutcome: "infrastructure_error",
        createdAt,
      })
    ).toMatchObject({
      kind: "invocation.failed",
      payload: {
        terminalOutcome: "infrastructure_error",
        terminalReasonCode: "method_failed",
        to: [{ kind: "participant", participantId: caller.participantId }],
      },
    });
    expect(
      builders.terminal({
        descriptor,
        result: "superseded",
        isError: true,
        terminalOutcome: "stale_dispatch",
        createdAt,
      })
    ).toMatchObject({
      kind: "invocation.cancelled",
      payload: {
        terminalOutcome: "stale_dispatch",
        reason: "superseded",
        to: [{ kind: "participant", participantId: caller.participantId }],
      },
    });
    expect(
      builders.terminal({
        descriptor,
        result: "target left",
        isError: true,
        terminalOutcome: "abandoned",
        createdAt,
      })
    ).toMatchObject({
      kind: "invocation.abandoned",
      payload: {
        terminalOutcome: "abandoned",
        reason: "target left",
        to: [{ kind: "participant", participantId: caller.participantId }],
      },
    });
    expect(builders.output({ descriptor, output: { pct: 50 }, createdAt })).toMatchObject({
      kind: "invocation.output",
      payload: {
        output: { pct: 50 },
        to: [{ kind: "participant", participantId: caller.participantId }],
      },
    });
    expect(
      builders.cancelled({
        descriptor,
        actor: { kind: "system", id: "system" },
        reason: "timed out",
        createdAt,
      })
    ).toMatchObject({
      kind: "invocation.cancelled",
      actor: { kind: "system", id: "system" },
      payload: {
        terminalOutcome: "cancelled",
        reason: "timed out",
        to: [{ kind: "participant", participantId: caller.participantId }],
      },
    });
  });

  it("registry resolves defaults and rejects unknown or conflicting policies", () => {
    expect(getChannelPolicy("agentic.conversation.v1").version).toBe(1);
    expect(() => getChannelPolicy("nope")).toThrow(/Unknown channel policy/u);
    const resolved = resolveChannelPolicies(undefined);
    expect(resolved.map((policy) => policy.name)).toEqual([...DEFAULT_CHANNEL_POLICIES]);
  });
});

/**
 * Cross-channel hop depth (messaging plan §4.6, D13).
 *
 * `agentHops` is a per-channel fold, so a chain that crosses channels would
 * restart its streak in every channel it touches and get N times the depth the
 * cap intends — while every single-channel test still passed. Termination is
 * therefore not evidence; the observed count is.
 */
describe("agentic.conversation.v1 hop depth across channels", () => {
  const policy = conversationV1Policy;

  /** Depth reported for the Nth message of an A↔B chain inside one channel. */
  function singleChannelDepth(steps: number): number {
    let state = policy.init();
    let annotated = 0;
    for (let step = 1; step <= steps; step += 1) {
      const senderId = step % 2 === 1 ? "agent:a" : "agent:b";
      const draft = {
        payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: completedEnvelope(step, senderId, "agent").payload,
        senderId,
        senderKind: "agent" as const,
      };
      annotated = (policy.annotate(state, draft) as { agentHops: number }).agentHops;
      state = policy.reduce(state, completedEnvelope(step, senderId, "agent"));
    }
    return annotated;
  }

  /**
   * The same chain, but every message crosses into a channel that has never
   * seen this conversation — a fresh policy state each step. The sender stamps
   * `causality.agentHops = <inbound> + 1`, which the policy honours.
   */
  function crossChannelDepth(steps: number): number {
    let inbound = 0;
    let annotated = 0;
    for (let step = 1; step <= steps; step += 1) {
      const senderId = step % 2 === 1 ? "agent:a" : "agent:b";
      const stamped = inbound + 1;
      const draft = {
        payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: completedEnvelope(step, senderId, "agent", undefined, { agentHops: stamped })
          .payload,
        senderId,
        senderKind: "agent" as const,
      };
      // A channel the chain has never touched: its fold starts from nothing.
      annotated = (policy.annotate(policy.init(), draft) as { agentHops: number }).agentHops;
      inbound = annotated;
    }
    return annotated;
  }

  it("counts a chain that crosses channels at the same depth as one that does not", () => {
    for (const steps of [1, 2, 4, 6]) {
      const local = singleChannelDepth(steps);
      const crossed = crossChannelDepth(steps);
      expect(
        crossed,
        `a ${steps}-step chain reached depth ${crossed} across channels but ${local} within one; ` +
          `the hop cap is only as tight as the smaller number`
      ).toBe(local);
    }
  });

  it("would undercount without the explicit stamp, which is why the stamp exists", () => {
    // Guard the guard: an unstamped guest envelope arriving in a fresh channel
    // reports depth 1 no matter how deep the conversation already is. If this
    // ever stops being true the stamping path has become redundant and the test
    // above stops proving anything.
    const draft = {
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: completedEnvelope(9, "agent:b", "agent").payload,
      senderId: "agent:b",
      senderKind: "agent" as const,
    };
    expect(policy.annotate(policy.init(), draft)).toEqual({ agentHops: 1 });
  });
});
