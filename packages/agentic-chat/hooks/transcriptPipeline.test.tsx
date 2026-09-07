// @vitest-environment jsdom

import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PubSubClient } from "@workspace/pubsub";
import { AGENTIC_EVENT_PAYLOAD_KIND } from "@workspace/agentic-protocol";
import { useChannelMessages, type UseChannelMessagesResult } from "./useChannelMessages.js";
import {
  agenticPublication,
  appendTrajectoryEventsAndBroadcast,
  assistantMessage,
  createTranscriptHarness,
  invocationCompleted,
  invocationStarted,
} from "./transcriptTestHarness.js";

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

describe("headless transcript pipeline", () => {
  it("projects initial user send and assistant channel publication without Electron UI", async () => {
    const harness = await createTranscriptHarness();
    const panel = harness.connectParticipant({
      id: "panel:chat",
      name: "User",
      type: "panel",
      handle: "alice",
    });
    const agent = harness.connectParticipant({
      id: "agent:onboarding",
      name: "Onboarding Agent",
      type: "agent",
      handle: "agent",
    });

    let latest: UseChannelMessagesResult | undefined;
    render(
      <Probe
        client={panel}
        onValue={(value) => {
          latest = value;
        }}
      />
    );

    await act(async () => {
      await Promise.all([panel.ready(), agent.ready()]);
    });

    let sent: Awaited<ReturnType<typeof panel.send>>;
    await act(async () => {
      sent = await panel.send("The user just opened this workspace for the first time");
      await latest!.backfillAfterLocalPublish(sent.pubsubId);
    });

    await waitFor(() => {
      expect(latest!.messages.map((message) => message.content)).toContain(
        "The user just opened this workspace for the first time"
      );
    });

    const assistant = assistantMessage("assistant-1", "Welcome to Vibestudio.");
    await act(async () => {
      await agent.publish(AGENTIC_EVENT_PAYLOAD_KIND, agenticPublication(assistant));
    });

    await waitFor(() => {
      expect(latest!.messages.map((message) => message.content)).toEqual(
        expect.arrayContaining([
          "The user just opened this workspace for the first time",
          "Welcome to Vibestudio.",
        ])
      );
    });

    const stored = (
      await harness.gad.call<any>("readChannelEnvelopes", {
        channelId: harness.channelId,
        payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      })
    ).items;
    expect(stored.map((envelope: any) => envelope.payload.payload.blocks?.[0]?.content)).toEqual(
      expect.arrayContaining([
        "The user just opened this workspace for the first time",
        "Welcome to Vibestudio.",
      ])
    );

    panel.close();
    agent.close();
  });

  it("projects pending and completed invocation beads with exact names and arguments", async () => {
    const harness = await createTranscriptHarness("transcript-pipeline-invocations");
    const panel = harness.connectParticipant({
      id: "panel:chat",
      name: "User",
      type: "panel",
      handle: "alice",
    });
    const agent = harness.connectParticipant({
      id: "agent:onboarding",
      name: "Onboarding Agent",
      type: "agent",
      handle: "agent",
    });

    let latest: UseChannelMessagesResult | undefined;
    render(
      <Probe
        client={panel}
        onValue={(value) => {
          latest = value;
        }}
      />
    );

    await act(async () => {
      await Promise.all([panel.ready(), agent.ready()]);
    });

    await act(async () => {
      await agent.publish(
        AGENTIC_EVENT_PAYLOAD_KIND,
        agenticPublication(
          invocationStarted("call-eval", "eval", { code: "read('skills/onboarding/SKILL.md')" })
        )
      );
    });

    await waitFor(() => {
      expect(latest!.messages).toContainEqual(
        expect.objectContaining({
          id: "invocation:call-eval",
          contentType: "invocation",
          complete: false,
          invocation: expect.objectContaining({
            id: "call-eval",
            name: "eval",
            arguments: { code: "read('skills/onboarding/SKILL.md')" },
            execution: expect.objectContaining({ status: "pending" }),
          }),
        })
      );
    });

    await act(async () => {
      await agent.publish(
        AGENTIC_EVENT_PAYLOAD_KIND,
        agenticPublication(
          invocationCompleted("call-eval", {
            toolCallId: "call-eval",
            toolName: "eval",
            details: { input: { code: "read('skills/onboarding/SKILL.md')" } },
            content: [{ type: "text", text: "docs" }],
          })
        )
      );
    });

    await waitFor(() => {
      expect(latest!.messages).toContainEqual(
        expect.objectContaining({
          id: "invocation:call-eval",
          contentType: "invocation",
          complete: true,
          invocation: expect.objectContaining({
            id: "call-eval",
            name: "eval",
            arguments: { code: "read('skills/onboarding/SKILL.md')" },
            execution: expect.objectContaining({ status: "complete" }),
          }),
        })
      );
    });

    panel.close();
    agent.close();
  });

  it("projects agent messages and invocations published through the GAD channel log backend", async () => {
    const harness = await createTranscriptHarness("transcript-pipeline-gad-publications");
    const panel = harness.connectParticipant({
      id: "panel:chat",
      name: "User",
      type: "panel",
      handle: "alice",
    });

    let latest: UseChannelMessagesResult | undefined;
    render(
      <Probe
        client={panel}
        onValue={(value) => {
          latest = value;
        }}
      />
    );

    await act(async () => {
      await panel.ready();
    });

    await act(async () => {
      await appendTrajectoryEventsAndBroadcast(harness, [
        assistantMessage("assistant-from-gad", "This message came from GAD publication."),
        invocationStarted("call-title", "set_title", { title: "Welcome" }),
        invocationCompleted("call-title", {
          toolCallId: "call-title",
          toolName: "set_title",
          details: { input: { title: "Welcome" } },
          content: [{ type: "text", text: "ok" }],
        }),
      ]);
    });

    await waitFor(() => {
      expect(latest!.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "assistant-from-gad",
            content: "This message came from GAD publication.",
            complete: true,
          }),
          expect.objectContaining({
            id: "invocation:call-title",
            contentType: "invocation",
            complete: true,
            invocation: expect.objectContaining({
              id: "call-title",
              name: "set_title",
              arguments: { title: "Welcome" },
              execution: expect.objectContaining({ status: "complete" }),
            }),
          }),
        ])
      );
    });

    panel.close();
  });
});
