import { describe, expect, it } from "vitest";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  GENESIS_EVENT_HASH,
  MAX_INLINE_TRAJECTORY_EVENT_BYTES,
  assertNoStoredValueRefs,
  agenticSlice,
  agenticEventEnvelopeSchema,
  agenticEventSchema,
  actorRefSchema,
  brandId,
  checkTrajectoryIntegrity,
  computeEventHash,
  createInitialChannelViewState,
  createInitialTrajectoryState,
  encodeAgenticEventStoredValues,
  hydrateStoredValueRefs,
  reduceChannelView,
  reduceTrajectory,
  sanitizeAgenticEventParticipantRefs,
  storedAgenticEventSchema,
  isStoredValueRef,
  messageDisplayText,
  participantRefSchema,
  principalRefSchema,
  publicActorRef,
  trajectoryEventSchema,
  userVisibleTrajectoryProjection,
  type AgenticEvent,
  type BlockId,
  type BranchId,
  type ChannelEnvelope,
  type ChannelId,
  type EnvelopeId,
  type EventId,
  type InvocationId,
  type MessageId,
  type TaskId,
  type TrajectoryEvent,
  type TrajectoryId,
  type TurnId,
} from "./index.js";

const agent = { kind: "agent" as const, id: "agent-1" };
const user = { kind: "user" as const, id: "user-1" };
const agentParticipant = { ...agent, participantId: "participant-agent-1" };
const userParticipant = { ...user, participantId: "participant-user-1" };

function textCompletedPayload(messageId: string, role: "user" | "assistant", content: string) {
  return {
    protocol: AGENTIC_PROTOCOL_VERSION,
    role,
    blocks: [
      {
        blockId: brandId<BlockId>(`${messageId}:block:0`),
        type: "text" as const,
        content,
      },
    ],
    outcome: "completed" as const,
  };
}

function messageEvent(
  overrides: Partial<AgenticEvent<"message.completed">> = {}
): AgenticEvent<"message.completed"> {
  return {
    kind: "message.completed",
    actor: user,
    causality: { messageId: brandId<MessageId>("msg-1") },
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      role: "user",
      blocks: [
        {
          blockId: brandId<BlockId>("msg-1:block:0"),
          type: "text",
          content: "hello",
        },
      ],
      outcome: "completed",
    },
    createdAt: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}

async function trajectoryEvent(
  event: AgenticEvent,
  overrides: Partial<TrajectoryEvent> = {}
): Promise<TrajectoryEvent> {
  const base = {
    ...event,
    eventId: brandId<EventId>(overrides.eventId ?? "evt-1"),
    trajectoryId: brandId<TrajectoryId>(overrides.trajectoryId ?? "traj-1"),
    branchId: brandId<BranchId>(overrides.branchId ?? "branch-1"),
    seq: overrides.seq ?? 0,
    prevEventHash: overrides.prevEventHash ?? GENESIS_EVENT_HASH,
    eventHash: "",
  } as TrajectoryEvent;
  return {
    ...base,
    eventHash:
      overrides.eventHash ??
      (await computeEventHash({
        prevEventHash: base.prevEventHash,
        branchId: base.branchId,
        seq: base.seq,
        event,
      })),
  };
}

function envelope(payload: AgenticEvent, seq = 1): ChannelEnvelope<AgenticEvent> {
  return {
    envelopeId: brandId<EnvelopeId>(`env-${seq}`),
    channelId: brandId<ChannelId>("channel-1"),
    seq,
    from: payload.actor.kind === "user" ? userParticipant : agentParticipant,
    payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
    payload,
    contentClass: "internal",
    externalKeys: [],
    publishedAt: payload.createdAt,
  };
}

describe("@workspace/agentic-protocol schemas", () => {
  it("validates a first-class automation institution with a friendly schedule snapshot", () => {
    const event: AgenticEvent<"automation.instituted"> = {
      kind: "automation.instituted",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        definition: {
          missionId: "mission-weekly",
          name: "Weekly review",
          summary: "Review the project every Thursday.",
          revision: 1,
          action: "prompt",
          state: "active",
          createdAt: 1_700_000_000_000,
          schedule: {
            kind: "cron",
            expression: "5 5 * * THU",
            timezone: "America/New_York",
            maxRuns: 12,
          },
        },
      },
      createdAt: "2026-07-14T00:00:00.000Z",
    };

    expect(agenticEventSchema.safeParse(event).success).toBe(true);
    const state = reduceChannelView(createInitialChannelViewState(), envelope(event));
    expect(state.automationInstitutions["mission-weekly"]).toMatchObject({
      definition: event.payload.definition,
      actor: agent,
      createdAt: event.createdAt,
      seq: 1,
    });
  });

  it("keeps semantic integration out of subagent lifecycle terminals", () => {
    const terminal = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: "inv-subagent" },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        terminalOutcome: "success",
      },
      createdAt: "2026-07-14T00:00:00.000Z",
    };
    expect(agenticEventSchema.safeParse(terminal).success).toBe(true);
    expect(
      agenticEventSchema.safeParse({
        ...terminal,
        payload: {
          ...terminal.payload,
          subagent: { integration: "merged" },
        },
      }).success
    ).toBe(false);
  });

  it("accepts explicit participant audiences on invocation responses", () => {
    const base = {
      actor: agent,
      causality: { invocationId: "inv-audience" },
      createdAt: "2026-07-14T00:00:00.000Z",
    };
    const to = [{ kind: "participant", participantId: "agent-1" }];

    expect(
      agenticEventSchema.safeParse({
        ...base,
        kind: "invocation.output",
        payload: { protocol: AGENTIC_PROTOCOL_VERSION, output: "line", to },
      }).success
    ).toBe(true);
    expect(
      agenticEventSchema.safeParse({
        ...base,
        kind: "invocation.completed",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          terminalOutcome: "success",
          to,
        },
      }).success
    ).toBe(true);
    expect(
      agenticEventSchema.safeParse({
        ...base,
        kind: "invocation.cancelled",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          terminalOutcome: "cancelled",
          reason: "cancelled",
          to,
        },
      }).success
    ).toBe(true);
  });

  it("separates participant refs from runtime principal actor refs", () => {
    expect(actorRefSchema.parse({ kind: "do", id: "do:agent" }).kind).toBe("do");
    expect(principalRefSchema.parse({ kind: "do", id: "do:agent" }).kind).toBe("do");
    expect(participantRefSchema.safeParse({ kind: "do", id: "do:agent" }).success).toBe(false);
    expect(participantRefSchema.parse({ kind: "panel", id: "panel:user" }).kind).toBe("panel");
  });

  it("keeps actor extensions inside metadata instead of accepting undeclared wire fields", () => {
    expect(
      actorRefSchema.safeParse({
        kind: "agent",
        id: "agent-1",
        privateAccountId: "hidden",
      }).success
    ).toBe(false);
    expect(
      actorRefSchema.safeParse({
        kind: "agent",
        id: "agent-1",
        metadata: { accountId: "public-account" },
      }).success
    ).toBe(true);
  });

  it("removes private account identity from public actor projections", () => {
    const actor = actorRefSchema.parse({
      kind: "agent",
      id: "agent-1",
      metadata: {
        executionMode: "headless",
        accountSubject: { userId: "usr_private" },
      },
    });

    expect(publicActorRef(actor)).toEqual({
      kind: "agent",
      id: "agent-1",
      metadata: { executionMode: "headless" },
    });
  });

  it("accepts human vocabulary events without turnId", () => {
    expect(agenticEventSchema.parse(messageEvent()).turnId).toBeUndefined();
  });

  it("rejects message events without a messageId", () => {
    const result = agenticEventSchema.safeParse(messageEvent({ causality: undefined }));
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toContain("messageId");
  });

  it("requires terminalOutcome on invocation terminal events", () => {
    const result = agenticEventSchema.safeParse({
      kind: "invocation.failed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-1") },
      // schema rejection fixture: terminalOutcome is missing
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "failed without typed outcome",
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("rejects terminalOutcome values that do not match the invocation kind", () => {
    const result = agenticEventSchema.safeParse({
      kind: "invocation.failed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-1") },
      // schema rejection fixture: terminalOutcome does not match event kind
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "wrong terminal kind",
        terminalOutcome: "cancelled",
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    });

    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toContain(
      "Expected 'tool_error' | 'infrastructure_error'"
    );
  });

  it("types terminal invocation payloads by event kind", () => {
    const abandonedPayload: AgenticEvent<"invocation.abandoned">["payload"] = {
      protocol: AGENTIC_PROTOCOL_VERSION,
      reason: "abandoned",
      // @ts-expect-error abandoned invocation events must use terminalOutcome: "abandoned"
      terminalOutcome: "tool_error",
    };
    expect(abandonedPayload.terminalOutcome).toBe("tool_error");
  });

  it("does not require terminalOutcome on message.failed", () => {
    expect(
      agenticEventSchema.parse({
        kind: "message.failed",
        actor: agent,
        causality: { messageId: brandId<MessageId>("msg-failed") },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          reason: "message failed",
        },
        createdAt: "2026-05-20T12:00:00.000Z",
      }).kind
    ).toBe("message.failed");
  });

  it("accepts reset metadata on message.failed", () => {
    expect(
      agenticEventSchema.parse({
        kind: "message.failed",
        actor: agent,
        causality: { messageId: brandId<MessageId>("msg-reset") },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          reason: "The usage limit has been reached.",
          recoverable: false,
          code: "usage_limit_terminal",
          resetAt: "2026-06-15T18:35:01.000Z",
          retryAfterMs: 12000,
        },
        createdAt: "2026-05-20T12:00:00.000Z",
      }).payload
    ).toMatchObject({
      code: "usage_limit_terminal",
      resetAt: "2026-06-15T18:35:01.000Z",
    });
  });

  it("enforces per-type message block invariants via the discriminated union", () => {
    const completed = (block: unknown) => ({
      kind: "message.completed" as const,
      actor: agent,
      causality: { messageId: brandId<MessageId>("msg-blocks") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [block],
        outcome: "completed",
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    });

    // Valid shapes pass.
    expect(
      agenticEventSchema.safeParse(
        completed({
          blockId: brandId<BlockId>("b0"),
          type: "invocation",
          invocationId: brandId<InvocationId>("call-1"),
        })
      ).success
    ).toBe(true);
    expect(
      agenticEventSchema.safeParse(
        completed({
          blockId: brandId<BlockId>("b0"),
          type: "text",
          content: "hi",
        })
      ).success
    ).toBe(true);

    // An invocation block without an invocationId is rejected.
    expect(agenticEventSchema.safeParse(completed({ type: "invocation" })).success).toBe(false);
    // A text block carrying an invocationId is rejected (strict: field belongs only to invocation).
    expect(
      agenticEventSchema.safeParse(
        completed({
          type: "text",
          content: "hi",
          invocationId: brandId<InvocationId>("call-1"),
        })
      ).success
    ).toBe(false);
    // A text block without content is rejected.
    expect(agenticEventSchema.safeParse(completed({ type: "text" })).success).toBe(false);
  });

  it("requires terminalOutcome on stored invocation terminal events", () => {
    const result = storedAgenticEventSchema.safeParse({
      kind: "invocation.failed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-stored") },
      // schema rejection fixture: terminalOutcome is missing
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "stored failure without typed outcome",
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    });

    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toContain("terminalOutcome");
  });

  it("rejects mismatched terminalOutcome on stored invocation terminal events", () => {
    const result = storedAgenticEventSchema.safeParse({
      kind: "invocation.failed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-stored") },
      // schema rejection fixture: terminalOutcome does not match event kind
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "stored failure with wrong outcome",
        terminalOutcome: "cancelled",
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    });

    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toContain("inconsistent");
  });

  it("rejects malformed invocation terminal events inside agentic envelopes", () => {
    const result = agenticEventEnvelopeSchema.safeParse({
      envelopeId: brandId<EnvelopeId>("env-terminal"),
      channelId: brandId<ChannelId>("channel-1"),
      seq: 1,
      from: agentParticipant,
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: {
        kind: "invocation.cancelled",
        actor: agent,
        causality: { invocationId: brandId<InvocationId>("inv-envelope") },
        // schema rejection fixture: terminalOutcome is missing
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          reason: "missing outcome",
        },
        createdAt: "2026-05-20T12:00:00.000Z",
      },
      publishedAt: "2026-05-20T12:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("requires turnId for owner-authored turn-scoped trajectory events", async () => {
    const event = await trajectoryEvent(
      messageEvent({
        actor: agent,
        payload: textCompletedPayload("msg-1", "assistant", "done"),
      })
    );
    const result = trajectoryEventSchema.safeParse(event);
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toContain("turnId");
  });

  it("accepts an inbound user message copied into an agent-owned trajectory before turn assignment", async () => {
    const event = await trajectoryEvent(
      messageEvent({
        actor: agent,
        payload: {
          ...textCompletedPayload("msg-1", "user", "hello"),
          senderRef: user,
        } as never,
      })
    );

    expect(trajectoryEventSchema.parse(event).payload).toMatchObject({
      role: "user",
      senderRef: user,
    });
  });

  it("accepts owner-authored turn-scoped trajectory events with turnId", async () => {
    const event = await trajectoryEvent(
      messageEvent({
        actor: agent,
        turnId: brandId<TurnId>("turn-1"),
      })
    );
    expect(trajectoryEventSchema.parse(event)["turnId"]).toBe("turn-1");
  });

  it("rejects unknown stored event kinds before reducer use", () => {
    const result = storedAgenticEventSchema.safeParse({
      kind: "invocation.typo",
      actor: agent,
      causality: { invocationId: "inv-1" },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, reason: "bad kind" },
      createdAt: "2026-05-20T12:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("rejects non-object stored event payloads unless the whole payload is a stored ref", () => {
    expect(
      storedAgenticEventSchema.safeParse({
        kind: "turn.closed",
        actor: agent,
        payload: null,
        createdAt: "2026-05-20T12:00:00.000Z",
      }).success
    ).toBe(false);

    expect(
      storedAgenticEventSchema.parse({
        kind: "turn.closed",
        actor: agent,
        payload: {
          protocol: "vibestudio.blob-ref.v1",
          digest: "payload-digest",
          size: 64,
          encoding: "json",
          originalBytes: 64,
        },
        createdAt: "2026-05-20T12:00:00.000Z",
      }).payload
    ).toMatchObject({ digest: "payload-digest" });
  });

  it("rejects stored events missing reducer-critical payload fields", () => {
    const result = storedAgenticEventSchema.safeParse({
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: "inv-1" },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        request: { code: "run()" },
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    });

    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toContain("payload.name");
  });

  it("keeps bounded block content inline (storage classes — no threshold spill)", async () => {
    const blobs = new Map<string, string>();
    const bounded = "x".repeat(80 * 1024); // under MAX_INLINE_TRAJECTORY_TEXT_BYTES
    const event = messageEvent({
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [
          {
            blockId: brandId<BlockId>(`msg-1:block:0`),
            type: "text",
            content: bounded,
            metadata: { index: 0 },
          },
        ],
        outcome: "completed",
      },
    });

    const encoded = await encodeAgenticEventStoredValues(event, {
      putText: async (value) => {
        const digest = `digest-${blobs.size + 1}`;
        blobs.set(digest, value);
        return { digest, size: value.length };
      },
    });

    // Block content is class-INLINE: bounded content stays verbatim in the
    // envelope (the fold/step read block structure), and NOTHING spills by
    // size — fold-readability is a static property of the path.
    expect(encoded.eventBytes).toBeLessThan(MAX_INLINE_TRAJECTORY_EVENT_BYTES);
    const blocks = storedAgenticEventSchema.parse(encoded.event).payload as Record<string, unknown>;
    expect(JSON.stringify(blocks)).toContain(bounded);
    expect(blobs.size).toBe(0);
  });

  it("always stores toolCall block arguments as refs (class REFERENCE inside blocks)", async () => {
    const blobs = new Map<string, string>();
    const event = messageEvent({
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [
          {
            type: "toolCall",
            id: "call-1",
            name: "write",
            arguments: { path: "a.txt", content: "tiny" },
          },
        ],
        outcome: "completed",
      } as never,
    });

    const encoded = await encodeAgenticEventStoredValues(event, {
      putText: async (value) => {
        const digest = `digest-${blobs.size + 1}`;
        blobs.set(digest, value);
        return { digest, size: value.length };
      },
    });

    const payload = encoded.event.payload as Record<string, unknown>;
    const block = (payload["blocks"] as Array<Record<string, unknown>>)[0]!;
    // One code path: arguments are refs even when tiny (`[*]` reference path).
    expect(isStoredValueRef(block["arguments"])).toBe(true);
    expect(block["name"]).toBe("write"); // structure stays inline for the step
  });

  it("hydrates refs nested inside hydrated json blobs", async () => {
    const blobs = new Map<string, string>();
    const innerRef = {
      protocol: "vibestudio.blob-ref.v1" as const,
      digest: "inner",
      size: 14,
      encoding: "json" as const,
      originalBytes: 14,
    };
    const outerRef = {
      protocol: "vibestudio.blob-ref.v1" as const,
      digest: "outer",
      size: 32,
      encoding: "json" as const,
      originalBytes: 32,
    };
    blobs.set("inner", JSON.stringify({ text: "hydrated" }));
    blobs.set("outer", JSON.stringify({ blocks: [innerRef] }));

    await expect(
      hydrateStoredValueRefs(outerRef, {
        getText: async (digest) => blobs.get(digest) ?? null,
      })
    ).resolves.toEqual({ blocks: [{ text: "hydrated" }] });
  });

  it("sanitizes participant refs without persisting method schemas", () => {
    const fullMetadata = {
      type: "panel",
      name: "Panel",
      handle: "panel",
      methods: [
        {
          name: "eval",
          description: "large method description",
          parameters: {
            type: "object",
            properties: { code: { type: "string" } },
          },
          returns: { type: "object" },
        },
      ],
      arbitraryLargeField: "x".repeat(1024),
    };
    const event: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: { kind: "agent", id: "agent-1", metadata: fullMetadata },
      turnId: brandId<TurnId>("turn-1"),
      causality: { invocationId: brandId<InvocationId>("inv-1") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "eval",
        transport: {
          kind: "channel",
          channelId: brandId<ChannelId>("channel-1"),
          target: {
            kind: "panel",
            id: "panel-1",
            participantId: "panel-1",
            metadata: fullMetadata,
          },
        },
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };

    const sanitized = sanitizeAgenticEventParticipantRefs(event);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain("parameters");
    expect(serialized).not.toContain("returns");
    expect(serialized).not.toContain("description");
    expect(serialized).not.toContain("arbitraryLargeField");
    expect(sanitized.actor.metadata).toEqual({
      type: "panel",
      name: "Panel",
      handle: "panel",
      methods: [{ name: "eval" }],
    });
    expect("transport" in sanitized.payload ? sanitized.payload.transport?.kind : undefined).toBe(
      "channel"
    );
    if ("transport" in sanitized.payload && sanitized.payload.transport?.kind === "channel") {
      expect(sanitized.payload.transport.target.metadata).toEqual({
        type: "panel",
        name: "Panel",
        handle: "panel",
        methods: [{ name: "eval" }],
      });
    }
  });
});

describe("@workspace/agentic-protocol stored values", () => {
  it("strictly hydrates stored refs and reports missing blob paths", async () => {
    const stored = {
      outer: {
        value: {
          protocol: "vibestudio.blob-ref.v1" as const,
          digest: "json-digest",
          size: 12,
          encoding: "json" as const,
          originalBytes: 12,
        },
      },
    };

    await expect(
      hydrateStoredValueRefs(
        stored,
        { getText: async () => JSON.stringify({ ok: true }) },
        { strict: true, context: "test payload" }
      )
    ).resolves.toEqual({ outer: { value: { ok: true } } });

    await expect(
      hydrateStoredValueRefs(
        stored,
        { getText: async () => null },
        { strict: true, context: "test payload" }
      )
    ).rejects.toThrow("test payload stored value missing at $.outer.value: json-digest");

    await expect(hydrateStoredValueRefs(stored, { getText: async () => null })).resolves.toEqual({
      outer: { value: null },
    });
  });

  it("asserts when stored refs cross forbidden boundaries", () => {
    expect(() =>
      assertNoStoredValueRefs(
        {
          content: [
            {
              type: "text",
              text: {
                protocol: "vibestudio.blob-ref.v1",
                digest: "digest-1",
                size: 10,
                encoding: "json",
                originalBytes: 10,
              },
            },
          ],
        },
        "toolResult admission"
      )
    ).toThrow(
      "toolResult admission contains unresolved stored value refs: $.content[0].text -> digest-1"
    );
  });

  it("encodes every class-REFERENCE agentic payload field as a stored ref", async () => {
    // NOTE: `details` is class-INLINE — the agent-loop fold reads
    // fold-critical fields from system.event details and never hydrates;
    // emitters must keep details bounded (oversize is a hard error).
    // NOTE: `replacement` (compaction) is class-INLINE — the fold replaces
    // its entries from it; bulky members inside those entries are already
    // refs from their original events.
    const unboundedFields = [
      "request",
      "result",
      "data",
      "output",
      "error",
      "body",
      "update",
      "initialState",
      "props",
      "imports",
      "source",
    ];

    const writes: string[] = [];
    for (const field of unboundedFields) {
      const event: AgenticEvent = {
        kind: "invocation.completed",
        actor: agent,
        causality: { invocationId: brandId<InvocationId>(`inv-${field}`) },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          terminalOutcome: "success",
          [field]: { field, nested: ["value"] },
        } as AgenticEvent["payload"],
        createdAt: "2026-05-20T12:00:00.000Z",
      };
      const { event: encoded } = await encodeAgenticEventStoredValues(event, {
        putText: async (value) => {
          writes.push(value);
          return { digest: `digest-${field}`, size: value.length };
        },
      });
      const payload = encoded.payload as Record<string, unknown>;
      expect(isStoredValueRef(payload[field]), field).toBe(true);
      expect((payload[field] as { digest: string }).digest).toBe(`digest-${field}`);
    }

    expect(writes).toHaveLength(unboundedFields.length);
  });

  it("stores invocation.output as a ref regardless of size (one code path)", async () => {
    const writes: string[] = [];
    const writer = {
      putText: async (value: string) => {
        writes.push(value);
        return { digest: `digest-${writes.length}`, size: value.length };
      },
    };
    const make = (output: unknown): AgenticEvent => ({
      kind: "invocation.output",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-out") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        output,
      } as AgenticEvent["payload"],
      createdAt: "2026-05-20T12:00:00.000Z",
    });

    // Progress chunks are fold-opaque, arbitrary client data — class
    // REFERENCE, so they can never trigger an inline-bound error remotely.
    const small = await encodeAgenticEventStoredValues(make("streamed line"), writer);
    expect(isStoredValueRef((small.event.payload as Record<string, unknown>)["output"])).toBe(true);

    const large = await encodeAgenticEventStoredValues(make("x".repeat(140 * 1024)), writer);
    expect(isStoredValueRef((large.event.payload as Record<string, unknown>)["output"])).toBe(true);
    expect(writes).toHaveLength(2);
  });

  it("rejects oversized inline content at encode time (no implicit spill)", async () => {
    const largeText = "x".repeat(140 * 1024);
    const writer = {
      putText: async (value: string) => ({
        digest: "unused",
        size: value.length,
      }),
    };

    // Block content over the inline bound is the EMITTER's bug (the
    // model-call executor splits long text into multiple blocks); the
    // storage layer surfaces it loudly instead of silently blinding the fold.
    await expect(
      encodeAgenticEventStoredValues(
        messageEvent({
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            role: "assistant",
            blocks: [
              {
                blockId: brandId<BlockId>("msg-1:block:0"),
                type: "text",
                content: largeText,
              },
            ],
            outcome: "completed",
          },
        }),
        writer
      )
    ).rejects.toThrow(/inline value at \$\.payload\.blocks\[0\]\.content .* no implicit spill/u);
  });
});

describe("@workspace/agentic-protocol reducers", () => {
  it("does not let a stale (lower-seq) turn event resurrect a closed turn", () => {
    const turnId = brandId<TurnId>("turn-seq");
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const closed: AgenticEvent<"turn.closed"> = {
      kind: "turn.closed",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "done" },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    // A late/replayed turn.waiting at a LOWER seq than the close must be ignored.
    const staleWaiting: AgenticEvent<"turn.waiting"> = {
      kind: "turn.waiting",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "model_credential_required",
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [envelope(opened, 1), envelope(closed, 5), envelope(staleWaiting, 3)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );

    expect(state.turns[turnId]?.status).toBe("closed");
  });

  it("supports replacement assistant message deltas", () => {
    const started: AgenticEvent<"message.started"> = {
      kind: "message.started",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      causality: { messageId: brandId<MessageId>("msg-replace") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [
          {
            blockId: brandId<BlockId>("msg-replace:block:0"),
            type: "text",
            content: "hello worl",
          },
        ],
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const replacement: AgenticEvent<"message.delta"> = {
      kind: "message.delta",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      causality: { messageId: brandId<MessageId>("msg-replace") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        blockId: brandId<BlockId>("msg-replace:block:0"),
        type: "text",
        text: "hello world",
        replace: true,
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [started, replacement]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(messageDisplayText(state.messages["msg-replace"]?.blocks)).toBe("hello world");
  });

  it("anchors a stream that is first observed through a delta", () => {
    const delta: AgenticEvent<"message.delta"> = {
      kind: "message.delta",
      actor: agent,
      turnId: brandId<TurnId>("turn-early-delta"),
      causality: { messageId: brandId<MessageId>("msg-early-delta") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        blockId: brandId<BlockId>("msg-early-delta:block:0"),
        type: "text",
        text: "Streaming",
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = reduceChannelView(createInitialChannelViewState(), envelope(delta, 1));

    expect(state.messages["msg-early-delta"]?.startedAt).toBe(delta.createdAt);
  });

  it("preserves message blocks and updates streamed blocks", () => {
    const started: AgenticEvent<"message.started"> = {
      kind: "message.started",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      causality: { messageId: brandId<MessageId>("msg-thinking") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [
          {
            blockId: brandId<BlockId>("think-1"),
            type: "thinking",
            content: "draft",
          },
        ],
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const replacement: AgenticEvent<"message.delta"> = {
      kind: "message.delta",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      causality: { messageId: brandId<MessageId>("msg-thinking") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        blockId: brandId<BlockId>("think-1"),
        type: "thinking",
        text: " updated",
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [started, replacement]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(state.messages["msg-thinking"]?.blocks).toEqual([
      { blockId: "think-1", type: "thinking", content: "draft updated" },
    ]);
  });

  it("routes interleaved thinking and text deltas to their own blocks without cross-contamination", () => {
    const started: AgenticEvent<"message.started"> = {
      kind: "message.started",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      causality: { messageId: brandId<MessageId>("msg-stream") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [],
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const delta = (
      blockId: string,
      type: "text" | "thinking",
      text: string
    ): AgenticEvent<"message.delta"> => ({
      kind: "message.delta",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      causality: { messageId: brandId<MessageId>("msg-stream") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        blockId: brandId<BlockId>(blockId),
        type,
        text,
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    });

    const events = [
      started,
      delta("msg-stream:block:0", "thinking", "Think"),
      delta("msg-stream:block:1", "text", "Hel"),
      delta("msg-stream:block:0", "thinking", " more"),
      delta("msg-stream:block:1", "text", "lo"),
    ];
    const state = events
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    // Each block accumulates only its own fragments — no duplication, no bleed.
    expect(state.messages["msg-stream"]?.blocks).toEqual([
      {
        blockId: "msg-stream:block:0",
        type: "thinking",
        content: "Think more",
      },
      { blockId: "msg-stream:block:1", type: "text", content: "Hello" },
    ]);
    expect(messageDisplayText(state.messages["msg-stream"]?.blocks)).toBe("Hello");
  });

  it("records malformed agentic envelope errors without stopping transcript reduction", () => {
    const malformed = {
      envelopeId: brandId<EnvelopeId>("env-bad"),
      channelId: brandId<ChannelId>("channel-1"),
      seq: 1,
      from: agentParticipant,
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: {
        kind: "message.completed",
        payload: { content: "missing required fields" },
      },
      publishedAt: "2026-05-20T12:00:00.000Z",
    } as unknown as ChannelEnvelope<AgenticEvent>;
    const valid = envelope(
      messageEvent({
        causality: { messageId: brandId<MessageId>("msg-good") },
        payload: textCompletedPayload("msg-good", "user", "kept"),
        createdAt: "2026-05-20T12:00:01.000Z",
      }),
      2
    );

    const state = [malformed, valid].reduce(reduceChannelView, createInitialChannelViewState());

    expect(state.ignoredEnvelopeIds).toEqual(["env-bad"]);
    expect(state.ignoredEnvelopeErrors["env-bad"]).toContain("payload.actor");
    expect(messageDisplayText(state.messages["msg-good"]?.blocks)).toBe("kept");
  });

  it("keeps channel view and trajectory visible projection aligned for a single-agent visible stream", async () => {
    const turnOpened = await trajectoryEvent(
      {
        kind: "turn.opened",
        actor: agent,
        turnId: brandId<TurnId>("turn-1"),
        payload: { protocol: AGENTIC_PROTOCOL_VERSION },
        createdAt: "2026-05-20T12:00:00.000Z",
      },
      { eventId: brandId<EventId>("evt-turn"), seq: 0 }
    );
    const started = await trajectoryEvent(
      {
        kind: "message.started",
        actor: agent,
        turnId: brandId<TurnId>("turn-1"),
        causality: { messageId: brandId<MessageId>("msg-1") },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          role: "assistant",
          blocks: [],
        },
        createdAt: "2026-05-20T12:00:01.000Z",
      },
      {
        eventId: brandId<EventId>("evt-start"),
        seq: 1,
        prevEventHash: turnOpened.eventHash,
      }
    );
    const completed = await trajectoryEvent(
      {
        kind: "message.completed",
        actor: agent,
        turnId: brandId<TurnId>("turn-1"),
        causality: { messageId: brandId<MessageId>("msg-1") },
        payload: textCompletedPayload("msg-1", "assistant", "done"),
        createdAt: "2026-05-20T12:00:02.000Z",
      },
      {
        eventId: brandId<EventId>("evt-complete"),
        seq: 2,
        prevEventHash: started.eventHash,
      }
    );

    const trajectory = [turnOpened, started, completed].reduce(
      reduceTrajectory,
      createInitialTrajectoryState()
    );
    const channel = [started, completed]
      .map((event, index) => envelope(agenticSlice(event), index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(channel.messages).toEqual(userVisibleTrajectoryProjection(trajectory).messages);
  });

  it("keeps turns open but marked waiting when external input is required", async () => {
    const turnOpened = await trajectoryEvent(
      {
        kind: "turn.opened",
        actor: agent,
        turnId: brandId<TurnId>("turn-wait"),
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          summary: "Running model",
        },
        createdAt: "2026-05-20T12:00:00.000Z",
      },
      { eventId: brandId<EventId>("evt-turn"), seq: 0 }
    );
    const waiting = await trajectoryEvent(
      {
        kind: "turn.waiting",
        actor: agent,
        turnId: brandId<TurnId>("turn-wait"),
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          summary: "Waiting for model credential refresh",
          reason: "model_credential_reconnect_required",
        },
        createdAt: "2026-05-20T12:00:01.000Z",
      },
      {
        eventId: brandId<EventId>("evt-waiting"),
        seq: 1,
        prevEventHash: turnOpened.eventHash,
      }
    );

    const trajectory = [turnOpened, waiting].reduce(
      reduceTrajectory,
      createInitialTrajectoryState()
    );
    const channel = [turnOpened, waiting]
      .map((event, index) => envelope(agenticSlice(event), index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(trajectory.openTurnIdByBranch["branch-1"]).toBe("turn-wait");
    expect(trajectory.turns["turn-wait"]).toMatchObject({
      status: "waiting",
      summary: "Waiting for model credential refresh",
      reason: "model_credential_reconnect_required",
    });
    expect(channel.turns["turn-wait"]).toMatchObject({
      status: "waiting",
      summary: "Waiting for model credential refresh",
      reason: "model_credential_reconnect_required",
    });
  });

  it("updates invocation cards when intermediate progress is missing", () => {
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-1") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "read_file",
        userVisible: true,
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const completed: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-1") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        result: "contents",
        terminalOutcome: "success",
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [envelope(started, 1), envelope(completed, 2)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );

    expect(state.invocations["inv-1"]?.status).toBe("completed");
    expect(state.invocations["inv-1"]?.result).toBe("contents");
  });

  it("projects durable tasks independently from their launching invocation", () => {
    const taskId = brandId<TaskId>("task-1");
    const events: AgenticEvent[] = [
      {
        kind: "task.started",
        actor: agent,
        causality: { taskId, invocationId: brandId<InvocationId>("spawn-1") },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          taskType: "subagent",
          title: "Repository audit",
          details: { subagent: { runId: "task-1" } },
        },
        createdAt: "2026-05-20T12:00:00.000Z",
      },
    ];
    const state = events
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(state.tasks["task-1"]).toMatchObject({
      taskId: "task-1",
      taskType: "subagent",
      title: "Repository audit",
      status: "started",
    });
    expect(state.invocations).toEqual({});
  });

  it("rejects subagent lifecycle fields on ordinary invocation events", () => {
    const result = agenticEventSchema.safeParse({
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: "spawn-1" },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "spawn_subagent",
        subagent: { runId: "spawn-1" },
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("merges invocation updates by invocation id across participant envelopes", () => {
    const output: AgenticEvent<"invocation.output"> = {
      kind: "invocation.output",
      actor: { kind: "panel", id: "provider-1" },
      causality: { invocationId: brandId<InvocationId>("inv-cross") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, output: "streamed line" },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const completed: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-cross") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        result: "done",
        terminalOutcome: "success",
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const providerEnvelope = {
      ...envelope(output, 1),
      from: {
        kind: "panel" as const,
        id: "provider-1",
        participantId: "provider-1",
      },
    };
    const state = [providerEnvelope, envelope(completed, 2)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );

    expect(Object.keys(state.invocations)).toEqual(["inv-cross"]);
    expect(state.invocations["inv-cross"]).toMatchObject({
      status: "completed",
      outputs: ["streamed line"],
      result: "done",
    });
  });

  it("ignores duplicate channel envelopes during replay backfill", () => {
    const event: AgenticEvent<"invocation.output"> = {
      kind: "invocation.output",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-1") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, output: "line 1" },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const duplicatedEnvelope = envelope(event, 1);

    const state = [duplicatedEnvelope, duplicatedEnvelope].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );

    expect(state.timeline).toHaveLength(1);
    expect(state.invocations["inv-1"]?.outputs).toEqual(["line 1"]);
  });

  it("reduces typed UI events into channel UI state", () => {
    const inline: AgenticEvent<"ui.inline_rendered"> = {
      kind: "ui.inline_rendered",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "inline",
        id: "inline-1",
        source: {
          type: "code",
          code: "export default function App() { return null; }",
        },
        props: { ok: true },
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const actionBar: AgenticEvent<"ui.action_bar.updated"> = {
      kind: "ui.action_bar.updated",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "action_bar",
        id: "bar-1",
        source: { type: "file", path: "ActionBar.tsx" },
        result: { ok: true },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [envelope(inline, 1), envelope(actionBar, 2)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );

    expect(state.inlineUi["participant-agent-1"]?.["inline-1"]?.props).toEqual({
      ok: true,
    });
    expect(state.actionBars["participant-agent-1"]?.source).toEqual({
      type: "file",
      path: "ActionBar.tsx",
    });
  });

  it("merges custom message updates before starts and keeps updates sorted by seq", () => {
    const update2: AgenticEvent<"custom.updated"> = {
      kind: "custom.updated",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        messageId: brandId<MessageId>("custom-1"),
        update: { tempF: 72 },
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const duplicateUpdate2: AgenticEvent<"custom.updated"> = {
      ...update2,
      payload: { ...update2.payload, update: { tempF: 999 } },
      createdAt: "2026-05-20T12:00:03.000Z",
    };
    const started: AgenticEvent<"custom.started"> = {
      kind: "custom.started",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        messageId: brandId<MessageId>("custom-1"),
        typeId: "weather",
        initialState: { tempF: 70 },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const update1: AgenticEvent<"custom.updated"> = {
      kind: "custom.updated",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        messageId: brandId<MessageId>("custom-1"),
        update: { tempF: 71 },
      },
      createdAt: "2026-05-20T12:00:01.500Z",
    };

    const state = [
      envelope(update2, 3),
      envelope(started, 1),
      envelope(update1, 2),
      {
        ...envelope(duplicateUpdate2, 3),
        envelopeId: brandId<EnvelopeId>("env-duplicate-seq"),
      },
    ].reduce(reduceChannelView, createInitialChannelViewState());

    expect(state.customMessages["custom-1"]).toMatchObject({
      messageId: "custom-1",
      typeId: "weather",
      startedAtSeq: 1,
      lastSeq: 3,
      updatedAt: "2026-05-20T12:00:02.000Z",
    });
    expect(state.customMessages["custom-1"]?.updates).toEqual([
      { seq: 2, update: { tempF: 71 } },
      { seq: 3, update: { tempF: 72 } },
    ]);
  });

  it("does not resurrect a cleared message type from older registration replay", () => {
    const oldRegister: AgenticEvent<"messageType.registered"> = {
      kind: "messageType.registered",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        typeId: "weather",
        displayMode: "row",
        source: {
          type: "code",
          code: "export default function Weather() { return null; }",
        },
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const currentRegister: AgenticEvent<"messageType.registered"> = {
      ...oldRegister,
      payload: {
        ...oldRegister.payload,
        source: {
          type: "code",
          code: "export default function CurrentWeather() { return null; }",
        },
      },
      createdAt: "2026-05-20T12:00:10.000Z",
    };
    const clear: AgenticEvent<"messageType.cleared"> = {
      kind: "messageType.cleared",
      actor: agent,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, typeId: "weather" },
      createdAt: "2026-05-20T12:00:20.000Z",
    };
    const replayedAfterRegister: AgenticEvent<"messageType.registered"> = {
      ...oldRegister,
      payload: {
        ...oldRegister.payload,
        source: {
          type: "code",
          code: "export default function ReplayedWeather() { return null; }",
        },
      },
      createdAt: "2026-05-20T12:00:15.000Z",
    };

    const state = [
      envelope(currentRegister, 10),
      envelope(clear, 20),
      envelope(replayedAfterRegister, 15),
      envelope(oldRegister, 5),
    ].reduce(reduceChannelView, createInitialChannelViewState());

    expect(state.messageTypes["weather"]?.updatedAtSeq).toBe(10);
    expect(state.messageTypes["weather"]?.clearedAtSeq).toBe(20);
    expect(state.messageTypes["weather"]?.source).toEqual(currentRegister.payload.source);
  });

  it("does not let older custom.started envelopes clobber an existing start", () => {
    const newerStarted: AgenticEvent<"custom.started"> = {
      kind: "custom.started",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        messageId: brandId<MessageId>("custom-start-order"),
        typeId: "weather.v2",
        initialState: { city: "Berlin" },
        displayMode: "row",
      },
      createdAt: "2026-05-20T12:00:10.000Z",
    };
    const olderStarted: AgenticEvent<"custom.started"> = {
      kind: "custom.started",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        messageId: brandId<MessageId>("custom-start-order"),
        typeId: "weather.v1",
        initialState: { city: "Paris" },
        displayMode: "inline",
      },
      createdAt: "2026-05-20T12:00:05.000Z",
    };

    const state = [envelope(newerStarted, 10), envelope(olderStarted, 5)].reduce(
      reduceChannelView,
      createInitialChannelViewState()
    );

    expect(state.customMessages["custom-start-order"]).toMatchObject({
      typeId: "weather.v2",
      initialState: { city: "Berlin" },
      displayMode: "row",
      startedAtSeq: 10,
      lastSeq: -1,
    });
  });
});

describe("@workspace/agentic-protocol hash helpers", () => {
  it("detects tampering in a per-branch hash chain", async () => {
    const first = await trajectoryEvent(messageEvent(), {
      eventId: brandId<EventId>("evt-1"),
      seq: 0,
    });
    const second = await trajectoryEvent(
      messageEvent({
        causality: { messageId: brandId<MessageId>("msg-2") },
        payload: textCompletedPayload("msg-2", "user", "next"),
      }),
      {
        eventId: brandId<EventId>("evt-2"),
        seq: 1,
        prevEventHash: first.eventHash,
      }
    );

    await expect(checkTrajectoryIntegrity([first, second])).resolves.toEqual({
      ok: true,
      errors: [],
    });

    const tampered = {
      ...second,
      payload: textCompletedPayload("msg-2", "user", "changed"),
    } as TrajectoryEvent;
    const result = await checkTrajectoryIntegrity([first, tampered]);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("eventHash mismatch");
  });
});

describe("@workspace/agentic-protocol message delivery events", () => {
  const target = brandId<MessageId>("msg-deliver");
  const receipt = (
    kind: "message.received" | "message.read",
    actor = agentParticipant,
    extra: Record<string, unknown> = {}
  ): AgenticEvent =>
    ({
      kind,
      actor,
      causality: { messageId: target },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, ...extra },
      createdAt: "2026-05-20T12:00:05.000Z",
    }) as AgenticEvent;
  type AnyParticipant = {
    kind: "user" | "agent";
    id: string;
    participantId: string;
  };
  const edited = (
    by: AnyParticipant = userParticipant,
    actor: AnyParticipant = userParticipant
  ): AgenticEvent =>
    ({
      kind: "message.edited",
      actor,
      causality: { messageId: target },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        by,
        blocks: [{ type: "text", content: "edited body" }],
      },
      createdAt: "2026-05-20T12:00:06.000Z",
    }) as AgenticEvent;
  const retracted = (
    by: AnyParticipant = userParticipant,
    actor: AnyParticipant = userParticipant
  ): AgenticEvent =>
    ({
      kind: "message.retracted",
      actor,
      causality: { messageId: target },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, by },
      createdAt: "2026-05-20T12:00:06.000Z",
    }) as AgenticEvent;
  const sent = () =>
    messageEvent({
      actor: userParticipant,
      causality: { messageId: target },
      payload: {
        ...textCompletedPayload(target, "user", "hello"),
        to: undefined,
      },
    });

  it("accepts received/read/edited/retracted events", () => {
    expect(agenticEventSchema.parse(receipt("message.received")).kind).toBe("message.received");
    expect(
      agenticEventSchema.parse(receipt("message.read", agentParticipant, { turnId: "t-1" })).kind
    ).toBe("message.read");
    expect(agenticEventSchema.parse(edited()).kind).toBe("message.edited");
    expect(agenticEventSchema.parse(retracted()).kind).toBe("message.retracted");
  });

  it("rejects message delivery events without a messageId", () => {
    expect(
      agenticEventSchema.safeParse({
        ...receipt("message.read"),
        causality: undefined,
      }).success
    ).toBe(false);
  });

  it("rejects edited events without blocks", () => {
    const bad = {
      kind: "message.edited" as const,
      actor: userParticipant,
      causality: { messageId: target },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, by: userParticipant },
      createdAt: "2026-05-20T12:00:06.000Z",
    };
    expect(agenticEventSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts payload metadata on message.started and message.completed", () => {
    expect(
      agenticEventSchema.parse({
        kind: "message.completed",
        actor: userParticipant,
        causality: { messageId: target },
        payload: {
          ...textCompletedPayload(target, "user", "later"),
          metadata: { deliverAfterTurn: true },
        },
        createdAt: "2026-05-20T12:00:00.000Z",
      }).kind
    ).toBe("message.completed");
  });

  it("projects completed → received → read into per-participant receipts", () => {
    const state = [
      sent(),
      receipt("message.received"),
      receipt("message.read", agentParticipant, { turnId: "t-9" }),
    ]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());
    const message = state.messages[target];
    expect(message?.receivedBy?.["participant-agent-1"]).toBeDefined();
    expect(message?.readBy?.["participant-agent-1"]?.turnId).toBe("t-9");
  });

  it("projects payload.to and snapshots intended recipients at send time", () => {
    const withTo = messageEvent({
      actor: userParticipant,
      causality: { messageId: target },
      payload: {
        ...textCompletedPayload(target, "user", "hi"),
        to: [{ kind: "participant", participantId: "participant-agent-1" }],
      },
    });
    const state = [withTo]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());
    expect(state.messages[target]?.to).toEqual([
      { kind: "participant", participantId: "participant-agent-1" },
    ]);
    expect(state.intendedRecipientsByMessage[target]).toContain("participant-agent-1");
  });

  it("applies an edit before read and increments revision", () => {
    const state = [sent(), edited()]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());
    expect(messageDisplayText(state.messages[target]?.blocks)).toBe("edited body");
    expect(state.messages[target]?.revision).toBe(1);
    expect(state.messages[target]?.editedAt).toBeDefined();
  });

  it("ignores edit/retract after a read", () => {
    const state = [sent(), receipt("message.read"), edited(), retracted()]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());
    expect(messageDisplayText(state.messages[target]?.blocks)).toBe("hello");
    expect(state.messages[target]?.revision).toBeUndefined();
    expect(state.messages[target]?.retracted).toBeUndefined();
  });

  it("ignores edit/retract from a non-author", () => {
    const state = [
      sent(),
      edited(agentParticipant, agentParticipant),
      retracted(agentParticipant, agentParticipant),
    ]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());
    expect(messageDisplayText(state.messages[target]?.blocks)).toBe("hello");
    expect(state.messages[target]?.retracted).toBeUndefined();
  });

  it("ignores a read that races in after a retract (no readBy on a tombstone)", () => {
    const state = [sent(), retracted(), receipt("message.read")]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());
    expect(state.messages[target]?.retracted).toBe(true);
    expect(state.messages[target]?.readBy).toBeUndefined();
  });
});
