import { describe, expect, it } from "vitest";
import {
  channelEnvelopePageInfo,
  normalizeChannelEnvelopePageRequest,
} from "@vibestudio/shared/channelEnvelopePaging";
import { ChannelLog } from "./log-store.js";

describe("ChannelLog paging", () => {
  it("rejects oversized initial and backward replay pages", async () => {
    const log = new ChannelLog({ call: async () => null as never }, "channel-1");
    await expect(log.replayInitial(501, {})).rejects.toThrow(/between 0 and 500/i);
    await expect(log.replayBefore(10, 501, {})).rejects.toThrow(/between 1 and 500/i);
  });

  it("returns bounded forward pages under one stable reconnect watermark", async () => {
    const seqs = Array.from({ length: 1_201 }, (_, index) => index + 1);
    const targetId = "do:workers/workspace-source:GadWorkspaceDO:workspace";
    const calls: Array<[target: string, method: string, args: unknown[]]> = [];
    const rpc: ConstructorParameters<typeof ChannelLog>[0] = {
      async call<T = unknown>(target: string, method: string, args: unknown[]): Promise<T> {
        calls.push([target, method, args]);
        if (target === "main" && method === "workers.resolveService") {
          return {
            kind: "durable-object",
            source: "vibestudio/internal",
            className: "GadWorkspaceDO",
            objectKey: "workspace",
            targetId,
          } as T;
        }
        if (target === targetId && method === "readChannelEnvelopes") {
          const request = normalizeChannelEnvelopePageRequest(args[0] as never);
          const after = request.window.kind === "after" ? request.window.seq : 0;
          const returned = seqs.filter((seq) => seq > after).slice(0, request.limit);
          return {
            items: returned.map((seq) => ({
              envelopeId: `env-${seq}`,
              channelId: "channel-1",
              seq,
              from: { kind: "agent", id: "agent-1", participantId: "agent-1" },
              payload: { seq },
              payloadKind: "message",
              contentClass: "internal",
              externalKeys: [],
              publishedAt: new Date(seq).toISOString(),
            })),
            pageInfo: channelEnvelopePageInfo(
              request,
              { totalCount: seqs.length, firstSeq: 1, lastSeq: seqs.length },
              returned
            ),
          } as T;
        }
        throw new Error(`unexpected call ${target}.${method}`);
      },
    };

    const log = new ChannelLog(rpc, "channel-1");
    const first = await log.replayAfter({ after: 0 }, {});
    const watermark = first.ready.snapshotLastSeq!;
    const second = await log.replayAfter(
      { after: first.ready.replayToId!, throughSeq: watermark },
      {}
    );
    const third = await log.replayAfter(
      { after: second.ready.replayToId!, throughSeq: watermark },
      {}
    );

    expect([first.logEvents.length, second.logEvents.length, third.logEvents.length]).toEqual([
      500, 500, 201,
    ]);
    expect(first.ready).toMatchObject({
      replayFromId: 1,
      replayToId: 500,
      snapshotLastSeq: 1_201,
      hasMoreBefore: false,
      hasMoreAfter: true,
    });
    expect(third.ready).toMatchObject({
      replayFromId: 1_001,
      replayToId: 1_201,
      snapshotLastSeq: 1_201,
      hasMoreAfter: false,
    });
    const pageCalls = calls.filter(([, method]) => method === "readChannelEnvelopes");
    expect(pageCalls).toHaveLength(3);
    expect(pageCalls.map(([, , args]) => (args[0] as { limit: number }).limit)).toEqual([
      500, 500, 500,
    ]);
  });
});
