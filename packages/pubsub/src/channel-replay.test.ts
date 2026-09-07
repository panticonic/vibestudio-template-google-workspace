import { describe, expect, it } from "vitest";
import { iterateChannelReplayAfterPages } from "./channel-replay.js";
import type { ChannelReplayAfterRequest, ChannelReplayEnvelope } from "./types.js";

function replayPage(ids: number[], ready: ChannelReplayEnvelope["ready"]): ChannelReplayEnvelope {
  return {
    mode: "after",
    logEvents: ids.map((id) => ({
      id,
      messageId: `env-${id}`,
      type: "message",
      payload: { id },
      senderId: "agent:one",
      ts: id,
    })),
    snapshots: [],
    ready,
  };
}

describe("iterateChannelReplayAfterPages", () => {
  it("pins continuation reads to the first page high-water mark", async () => {
    const requests: ChannelReplayAfterRequest[] = [];
    const readPage = async (request: ChannelReplayAfterRequest) => {
      requests.push(request);
      return request.after === 0
        ? replayPage([1, 2], {
            totalCount: 4,
            envelopeCount: 4,
            replayFromId: 1,
            replayToId: 2,
            snapshotLastSeq: 4,
            hasMoreAfter: true,
          })
        : replayPage([3, 4], {
            totalCount: 4,
            envelopeCount: 4,
            replayFromId: 3,
            replayToId: 4,
            snapshotLastSeq: 4,
            hasMoreAfter: false,
          });
    };

    const ids: number[] = [];
    for await (const page of iterateChannelReplayAfterPages(readPage, {
      after: 0,
      limit: 2,
    })) {
      ids.push(...page.logEvents.map((event) => event.id ?? 0));
    }

    expect(ids).toEqual([1, 2, 3, 4]);
    expect(requests).toEqual([
      { after: 0, limit: 2 },
      { after: 2, limit: 2, throughSeq: 4 },
    ]);
  });

  it("rejects continuation without a stable advancing cursor", async () => {
    const pages = iterateChannelReplayAfterPages(
      async () =>
        replayPage([1], {
          totalCount: 2,
          envelopeCount: 2,
          replayToId: 1,
          hasMoreAfter: true,
        }),
      { after: 0 }
    );

    await expect(async () => {
      for await (const _page of pages) {
        // Consume the iterator so continuation validation runs.
      }
    }).rejects.toThrow("without a forward cursor");
  });
});
