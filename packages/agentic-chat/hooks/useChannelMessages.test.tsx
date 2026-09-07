// @vitest-environment jsdom

import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  brandId,
  type AgenticEvent,
  type BlockId,
  type MessageId,
} from "@workspace/agentic-protocol";
import type { IncomingEvent, PubSubClient } from "@workspace/pubsub";

import { useChannelMessages, type UseChannelMessagesResult } from "./useChannelMessages";

function messageCompleted(
  id: string,
  content: string,
  createdAt = "2026-05-21T08:00:00.000Z"
): AgenticEvent<"message.completed"> {
  return {
    kind: "message.completed",
    actor: { kind: "user", id: "panel:user" },
    causality: { messageId: brandId<MessageId>(id) },
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      role: "user",
      blocks: [{ blockId: brandId<BlockId>(`${id}:block:0`), type: "text", content }],
      outcome: "completed",
    },
    createdAt,
  };
}

function messageTypeRegistered(
  typeId: string,
  createdAt = "2026-05-21T08:00:00.000Z"
): AgenticEvent<"messageType.registered"> {
  return {
    kind: "messageType.registered",
    actor: { kind: "panel", id: "panel:user" },
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      typeId,
      displayMode: "inline",
      source: { type: "code", code: "export default function Demo() { return null; }" },
    },
    createdAt,
  };
}

function messageReceived(
  id: string,
  actorId: string,
  createdAt = "2026-05-21T08:00:10.000Z"
): AgenticEvent<"message.received"> {
  return {
    kind: "message.received",
    actor: { kind: "agent", id: actorId },
    causality: { messageId: brandId<MessageId>(id) },
    payload: { protocol: AGENTIC_PROTOCOL_VERSION },
    createdAt,
  };
}

function messageRead(
  id: string,
  actorId: string,
  createdAt = "2026-05-21T08:00:20.000Z"
): AgenticEvent<"message.read"> {
  return {
    kind: "message.read",
    actor: { kind: "agent", id: actorId },
    causality: { messageId: brandId<MessageId>(id) },
    payload: { protocol: AGENTIC_PROTOCOL_VERSION },
    createdAt,
  };
}

function messageRetracted(
  id: string,
  actorId: string,
  createdAt = "2026-05-21T08:00:30.000Z"
): AgenticEvent<"message.retracted"> {
  return {
    kind: "message.retracted",
    actor: { kind: "user", id: actorId },
    causality: { messageId: brandId<MessageId>(id) },
    payload: { protocol: AGENTIC_PROTOCOL_VERSION, by: { kind: "user", id: actorId } },
    createdAt,
  };
}

function messageDelta(
  id: string,
  text: string,
  createdAt = "2026-05-21T08:00:00.000Z"
): AgenticEvent<"message.delta"> {
  return {
    kind: "message.delta",
    actor: { kind: "agent", id: "agent:writer" },
    causality: { messageId: brandId<MessageId>(id) },
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      blockId: brandId<BlockId>(`${id}:block:0`),
      type: "text",
      text,
    },
    createdAt,
  };
}

function inlineUiRendered(
  props: Record<string, unknown>,
  createdAt: string
): AgenticEvent<"ui.inline_rendered"> {
  return {
    kind: "ui.inline_rendered",
    actor: { kind: "agent", id: "agent:onboarding" },
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      uiType: "inline",
      id: "onboarding-setup-overview",
      source: { type: "file", path: "skills/onboarding/SetupHub.tsx" },
      props,
    },
    createdAt,
  };
}

function pubsubAgenticEvent(seq: number, payload: AgenticEvent) {
  return {
    type: AGENTIC_EVENT_PAYLOAD_KIND,
    delivery: "log",
    phase: "replay",
    senderId: payload.actor.id,
    pubsubId: seq,
    ts: Date.parse(payload.createdAt),
    senderMetadata: { name: "User", type: "panel", handle: "alice" },
    payload,
  };
}

function livePubsubAgenticEvent(seq: number, payload: AgenticEvent) {
  return { ...pubsubAgenticEvent(seq, payload), phase: "live" as const };
}

function rawReplayEvent(seq: number, payload: AgenticEvent) {
  return {
    id: seq,
    messageId: `env-${seq}`,
    type: AGENTIC_EVENT_PAYLOAD_KIND,
    senderId: payload.actor.id,
    ts: Date.parse(payload.createdAt),
    senderMetadata: { name: "User", type: "panel", handle: "alice" },
    payload,
  };
}

function createClient(events: unknown[] = [], overrides: Partial<PubSubClient> = {}): PubSubClient {
  const client = {
    channelId: "channel-1",
    hasMoreBefore: false,
    connected: false,
    onReady: vi.fn(() => () => {}),
    events: vi.fn(async function* () {
      for (const event of events) yield event;
    }),
    getReplayAfter: vi.fn(async () => ({ logEvents: [], ready: { hasMoreBefore: false } })),
    getReplayBefore: vi.fn(async () => ({ logEvents: [], ready: { hasMoreBefore: false } })),
    ...overrides,
  };
  return client as unknown as PubSubClient;
}

/**
 * A controllable async-iterable event stream so a test can push successive live
 * events into `client.events()` without the generator returning early.
 */
function createEventStream() {
  const queue: IncomingEvent[] = [];
  let resolveNext: ((value: IteratorResult<IncomingEvent>) => void) | null = null;
  const iterator: AsyncIterableIterator<IncomingEvent> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next(): Promise<IteratorResult<IncomingEvent>> {
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift()!, done: false });
      }
      return new Promise((resolve) => {
        resolveNext = resolve;
      });
    },
    return(): Promise<IteratorResult<IncomingEvent>> {
      return Promise.resolve({ value: undefined as never, done: true });
    },
  };
  return {
    iterator,
    push(event: IncomingEvent) {
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value: event, done: false });
      } else {
        queue.push(event);
      }
    },
  };
}

function Probe({
  client,
  onValue,
}: {
  client: PubSubClient;
  onValue: (value: UseChannelMessagesResult) => void;
}) {
  const value = useChannelMessages(client);
  onValue(value);
  return null;
}

describe("useChannelMessages", () => {
  it("reads pagination metadata from a client that is already replay-ready", async () => {
    let latest: UseChannelMessagesResult | undefined;
    const client = createClient([], {
      connected: true,
      hasMoreBefore: true,
    });

    render(
      <Probe
        client={client}
        onValue={(value) => {
          latest = value;
        }}
      />
    );

    await waitFor(() => expect(latest!.replaySettled).toBe(true));
    expect(latest!.hasMoreHistory).toBe(true);
  });

  it("reads finalized pagination metadata when replay becomes ready", async () => {
    let latest: UseChannelMessagesResult | undefined;
    let ready: (() => void) | undefined;
    let hasMoreBefore = false;
    const client = createClient([], {
      onReady: vi.fn((callback: () => void) => {
        ready = callback;
        return () => {};
      }),
    });
    Object.defineProperty(client, "hasMoreBefore", {
      configurable: true,
      get: () => hasMoreBefore,
    });

    render(
      <Probe
        client={client}
        onValue={(value) => {
          latest = value;
        }}
      />
    );
    expect(latest!.hasMoreHistory).toBe(false);

    hasMoreBefore = true;
    act(() => ready?.());

    await waitFor(() => expect(latest!.hasMoreHistory).toBe(true));
  });

  it("backfills a locally published envelope through replay instead of optimistic transcript state", async () => {
    let latest: UseChannelMessagesResult | undefined;
    const initialPrompt = messageCompleted("initial-prompt", "Read the docs first");
    const getReplayAfter = vi.fn(async (request: { after: number; throughSeq?: number }) => {
      expect(request).toEqual({ after: 0, throughSeq: 1 });
      return {
        mode: "after" as const,
        logEvents: [rawReplayEvent(1, initialPrompt)],
        snapshots: [],
        ready: { totalCount: 1, envelopeCount: 1, hasMoreBefore: false },
      };
    });
    const client = createClient([], { getReplayAfter });

    render(
      <Probe
        client={client}
        onValue={(value) => {
          latest = value;
        }}
      />
    );

    await act(async () => {
      await latest!.backfillAfterLocalPublish(1);
    });

    await waitFor(() => {
      expect(latest!.messages).toHaveLength(1);
      expect(latest!.messages[0]).toMatchObject({
        id: "initial-prompt",
        content: "Read the docs first",
        complete: true,
      });
    });
    expect(client.events).toHaveBeenCalledWith({ includeReplay: true, includeSignals: true });
  });

  it("loads earlier typed envelopes before the replay anchor and updates pagination metadata", async () => {
    let latest: UseChannelMessagesResult | undefined;
    const current = messageCompleted("current", "Current message", "2026-05-21T08:01:00.000Z");
    const older = messageCompleted("older", "Older message", "2026-05-21T08:00:00.000Z");
    const getReplayBefore = vi.fn(async (anchor: number, limit: number) => {
      expect(anchor).toBe(10);
      expect(limit).toBe(500);
      return {
        mode: "before" as const,
        logEvents: [rawReplayEvent(2, older)],
        snapshots: [],
        ready: { totalCount: 2, envelopeCount: 2, hasMoreBefore: false },
      };
    });
    const client = createClient([pubsubAgenticEvent(10, current)], {
      hasMoreBefore: true,
      getReplayBefore,
    });

    render(
      <Probe
        client={client}
        onValue={(value) => {
          latest = value;
        }}
      />
    );

    await waitFor(() => {
      expect(latest!.messages.map((message) => message.id)).toEqual(["current"]);
      expect(latest!.hasMoreHistory).toBe(true);
    });

    await act(async () => {
      await latest!.loadEarlierMessages();
    });

    await waitFor(() => {
      expect(latest!.messages.map((message) => message.id)).toEqual(["older", "current"]);
      expect(latest!.hasMoreHistory).toBe(false);
    });
  });

  it("preserves message type array identity when only transcript messages change", async () => {
    let latest: UseChannelMessagesResult | undefined;
    const registryEvent = messageTypeRegistered("weather", "2026-05-21T08:00:00.000Z");
    const firstMessage = messageCompleted("msg-1", "First", "2026-05-21T08:01:00.000Z");
    const secondMessage = messageCompleted("msg-2", "Second", "2026-05-21T08:02:00.000Z");
    let resumeEvents: ((event: IncomingEvent) => void) | undefined;
    const client = createClient([], {
      events: vi.fn(async function* () {
        yield pubsubAgenticEvent(1, registryEvent) as IncomingEvent;
        yield pubsubAgenticEvent(2, firstMessage) as IncomingEvent;
        yield await new Promise<IncomingEvent>((resolve) => {
          resumeEvents = resolve;
        });
      }),
    });

    render(
      <Probe
        client={client}
        onValue={(value) => {
          latest = value;
        }}
      />
    );

    await waitFor(() => {
      expect(latest!.messages.map((message) => message.id)).toEqual(["msg-1"]);
      expect(latest!.messageTypes).toHaveLength(1);
    });
    const registryProjection = latest!.messageTypes;

    act(() => {
      resumeEvents!(pubsubAgenticEvent(3, secondMessage) as IncomingEvent);
    });

    await waitFor(() => {
      expect(latest!.messages.map((message) => message.id)).toEqual(["msg-1", "msg-2"]);
    });
    expect(latest!.messageTypes).toBe(registryProjection);
  });

  it("moves a stable inline UI update to the transcript tail and exposes its render revision", async () => {
    let latest: UseChannelMessagesResult | undefined;
    const stream = createEventStream();
    const client = createClient([], { events: vi.fn(() => stream.iterator) });

    render(
      <Probe
        client={client}
        onValue={(value) => {
          latest = value;
        }}
      />
    );

    await act(async () => {
      stream.push(
        livePubsubAgenticEvent(
          1,
          inlineUiRendered({ revision: 1 }, "2026-05-21T08:00:00.000Z")
        ) as IncomingEvent
      );
      stream.push(
        livePubsubAgenticEvent(
          2,
          messageCompleted("between", "Refresh", "2026-05-21T08:01:00.000Z")
        ) as IncomingEvent
      );
    });
    await waitFor(() => {
      expect(latest!.messages.map((message) => message.id)).toEqual([
        "inline-ui:agent:onboarding:onboarding-setup-overview",
        "between",
      ]);
    });

    await act(async () => {
      stream.push(
        livePubsubAgenticEvent(
          3,
          inlineUiRendered({ revision: 2 }, "2026-05-21T08:02:00.000Z")
        ) as IncomingEvent
      );
    });
    await waitFor(() => {
      expect(latest!.messages.map((message) => message.id)).toEqual([
        "between",
        "inline-ui:agent:onboarding:onboarding-setup-overview",
      ]);
      expect(latest!.messages[1]?.inlineUi).toMatchObject({
        props: { revision: 2 },
        renderedAt: "2026-05-21T08:02:00.000Z",
      });
    });
  });

  it("re-renders the projection when receipts / retract land (sameChatMessage gate)", async () => {
    let latest: UseChannelMessagesResult | undefined;
    const stream = createEventStream();
    const completed = messageCompleted("m1", "steer the agent", "2026-05-21T08:00:00.000Z");
    const received = messageReceived("m1", "agent:writer");
    const read = messageRead("m1", "agent:writer");
    const client = createClient([], { events: vi.fn(() => stream.iterator) });

    render(
      <Probe
        client={client}
        onValue={(value) => {
          latest = value;
        }}
      />
    );

    await act(async () => {
      stream.push(livePubsubAgenticEvent(1, completed) as IncomingEvent);
    });
    await waitFor(() => {
      expect(latest!.messages.map((m) => m.id)).toEqual(["m1"]);
    });
    // No receipts before any ack lands.
    expect(latest!.messages[0]!.receipts).toBeUndefined();

    await act(async () => {
      stream.push(livePubsubAgenticEvent(2, received) as IncomingEvent);
    });
    await waitFor(() => {
      expect(latest!.messages[0]!.receipts?.byParticipant["agent:agent:writer"]).toBe("received");
      expect(latest!.messages[0]!.receipts?.aggregate).toBe("pending");
    });

    await act(async () => {
      stream.push(livePubsubAgenticEvent(3, read) as IncomingEvent);
    });
    await waitFor(() => {
      expect(latest!.messages[0]!.receipts?.byParticipant["agent:agent:writer"]).toBe("read");
      expect(latest!.messages[0]!.receipts?.aggregate).toBe("read");
    });
  });

  it("re-renders to a tombstone when an unread message is retracted", async () => {
    let latest: UseChannelMessagesResult | undefined;
    const stream = createEventStream();
    const completed = messageCompleted("m2", "cancel me", "2026-05-21T08:00:00.000Z");
    const retracted = messageRetracted("m2", "panel:user");
    const client = createClient([], { events: vi.fn(() => stream.iterator) });

    render(
      <Probe
        client={client}
        onValue={(value) => {
          latest = value;
        }}
      />
    );
    await act(async () => {
      stream.push(livePubsubAgenticEvent(1, completed) as IncomingEvent);
    });
    await waitFor(() => {
      expect(latest!.messages[0]?.retracted).toBeFalsy();
    });

    await act(async () => {
      stream.push(livePubsubAgenticEvent(2, retracted) as IncomingEvent);
    });
    await waitFor(() => {
      expect(latest!.messages[0]?.retracted).toBe(true);
    });
  });

  it("applies batched ephemeral message deltas from one signal event", async () => {
    let latest: UseChannelMessagesResult | undefined;
    const client = createClient([
      {
        delivery: "signal",
        type: "signal",
        contentType: AGENTIC_EVENT_PAYLOAD_KIND,
        content: JSON.stringify([
          messageDelta("msg-stream", "hel"),
          messageDelta("msg-stream", "lo"),
        ]),
        ts: Date.parse("2026-05-21T08:00:00.000Z"),
      },
    ]);

    render(
      <Probe
        client={client}
        onValue={(value) => {
          latest = value;
        }}
      />
    );

    await waitFor(() => {
      expect(latest!.messages).toContainEqual(
        expect.objectContaining({
          id: "msg-stream",
          content: "hello",
          complete: false,
        })
      );
    });
  });

  it("keeps an early assistant delta after the user message while message.started catches up", async () => {
    let latest: UseChannelMessagesResult | undefined;
    const stream = createEventStream();
    const client = createClient([], { events: vi.fn(() => stream.iterator) });

    render(
      <Probe
        client={client}
        onValue={(value) => {
          latest = value;
        }}
      />
    );

    await act(async () => {
      stream.push(
        livePubsubAgenticEvent(
          1,
          messageCompleted("initial-prompt", "Help me get onboarded", "2026-05-21T08:00:00.000Z")
        ) as IncomingEvent
      );
      stream.push({
        delivery: "signal",
        type: "signal",
        contentType: AGENTIC_EVENT_PAYLOAD_KIND,
        content: JSON.stringify(
          messageDelta("assistant-stream", "Welcome", "2026-05-21T08:00:01.000Z")
        ),
        ts: Date.parse("2026-05-21T08:00:01.000Z"),
      } as IncomingEvent);
    });

    await waitFor(() => {
      expect(latest!.messages.map((message) => message.id)).toEqual([
        "initial-prompt",
        "assistant-stream",
      ]);
    });
  });
});
