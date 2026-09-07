import { describe, expect, it } from "vitest";
import type { SqlStorage } from "@workspace/runtime/worker";
import { createInMemorySql } from "@workspace/runtime/worker/test-utils";
import type { UiFeedbackPayload } from "@workspace/agentic-protocol";
import { FeedbackIngest } from "./feedback-ingest.js";

const feedback = (occurrenceKey: string): UiFeedbackPayload => ({
  protocol: "agentic.trajectory.v1",
  target: { kind: "agent", id: "agent:test", participantId: "agent:test" },
  category: "render_failed",
  occurrenceKey,
  error: { message: "Renderer crashed" },
});

describe("FeedbackIngest", () => {
  it("queues new feedback for the target channel and deduplicates repeats", async () => {
    const sql = (await createInMemorySql()) as unknown as SqlStorage;
    const ingest = new FeedbackIngest(sql, () => 1_000);

    ingest.ingest("channel-a", feedback("render:1"));
    ingest.ingest("channel-a", feedback("render:1"));

    expect(ingest.consume("channel-b")).toEqual([]);
    expect(ingest.consume("channel-a")).toEqual([
      "[ui-feedback] A UI component you published failed to render.\n" +
        "Error: Renderer crashed\n" +
        "Fix the underlying problem or tell the user what went wrong; do not ignore this.",
    ]);
    expect(ingest.consume("channel-a")).toEqual([]);
  });
});
