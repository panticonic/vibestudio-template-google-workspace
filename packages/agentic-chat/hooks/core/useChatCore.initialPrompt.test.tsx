// @vitest-environment jsdom

import { useEffect } from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { IncomingEvent, MethodDefinition } from "@workspace/pubsub";
import { AGENTIC_EVENT_PAYLOAD_KIND } from "@workspace/agentic-protocol";

import { useChatCore, type ChatCoreState } from "./useChatCore.js";
import { createTranscriptHarness } from "../transcriptTestHarness.js";

function CoreProbe({ core }: { core: ChatCoreState }) {
  useEffect(() => {
    void core.connectToChannel({
      channelId: core.channelName,
      methods: {} satisfies Record<string, MethodDefinition>,
      contextId: "ctx-initial-prompt",
    });
    // The probe represents panel mount; reconnecting on every render would mask
    // initial-prompt ordering bugs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function InitialPromptProbe({
  harness,
  prompt,
  onValue,
}: {
  harness: Awaited<ReturnType<typeof createTranscriptHarness>>;
  prompt: string;
  onValue: (value: ChatCoreState) => void;
}) {
  const core = useChatCore({
    config: {
      clientId: "panel:chat",
      rpc: harness.createParticipantRpc({
        id: "panel:chat",
        name: "User",
        type: "panel",
        handle: "alice",
      }) as never,
    },
    channelName: harness.channelId,
    contextId: "ctx-initial-prompt",
    metadata: { name: "User", type: "panel", handle: "alice" },
    initialPrompt: prompt,
  });
  onValue(core);
  return <CoreProbe core={core} />;
}

describe("useChatCore initial prompt", () => {
  it("sends the configured initial prompt through the durable PubSub transcript", async () => {
    const harness = await createTranscriptHarness("chat-core-initial-prompt");
    const prompt = "The user just opened this workspace for the first time";
    const agent = harness.connectParticipant({
      id: "agent:onboarding",
      name: "Onboarding Agent",
      type: "agent",
      handle: "agent",
      contextId: "ctx-initial-prompt",
    });
    await agent.ready();

    const agentIterator = agent.events({ includeReplay: true });
    let agentReceived: IncomingEvent | undefined;
    void (async () => {
      for await (const event of agentIterator) {
        const agenticPayload =
          event.type === AGENTIC_EVENT_PAYLOAD_KIND ? event.payload : undefined;
        const messagePayload =
          agenticPayload?.kind === "message.completed"
            ? (agenticPayload.payload as { role?: unknown })
            : undefined;
        if (agenticPayload?.kind === "message.completed" && messagePayload?.role === "user") {
          agentReceived = event;
          return;
        }
      }
    })();

    let latest: ChatCoreState | undefined;
    render(
      <InitialPromptProbe
        harness={harness}
        prompt={prompt}
        onValue={(value) => {
          latest = value;
        }}
      />
    );

    await waitFor(() => {
      expect(latest?.messages).toContainEqual(
        expect.objectContaining({
          content: prompt,
          complete: true,
          senderId: "panel:chat",
        })
      );
    });

    await waitFor(() => {
      expect(agentReceived).toMatchObject({
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: {
          kind: "message.completed",
          payload: {
            role: "user",
            blocks: [expect.objectContaining({ type: "text", content: prompt })],
            outcome: "completed",
          },
        },
      });
    });

    const stored = (
      await harness.gad.call<any>("readChannelEnvelopes", {
        channelId: harness.channelId,
        payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      })
    ).items;
    expect(stored.map((envelope: any) => envelope.payload.payload.blocks?.[0]?.content)).toContain(
      prompt
    );

    await agentIterator.return?.();
    await latest?.clientRef.current?.close();
    agent.close();
  });
});
