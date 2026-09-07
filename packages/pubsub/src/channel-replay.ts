import type { ChannelReplayAfterRequest, ChannelReplayEnvelope } from "./types.js";

export type ChannelReplayPageReader = (
  request: ChannelReplayAfterRequest
) => Promise<ChannelReplayEnvelope>;

/**
 * Iterate one stable forward snapshot through bounded replay RPCs.
 *
 * The first page establishes the high-water mark. Continuation pages retain
 * it, so concurrent appends belong to a later read rather than making this
 * iterator chase a moving tail. Invalid or non-advancing page metadata fails
 * loudly instead of truncating history or looping forever.
 */
export async function* iterateChannelReplayAfterPages(
  readPage: ChannelReplayPageReader,
  request: ChannelReplayAfterRequest
): AsyncGenerator<ChannelReplayEnvelope, void, void> {
  let after = request.after;
  let throughSeq = request.throughSeq;
  for (;;) {
    const page = await readPage({
      after,
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
      ...(throughSeq !== undefined ? { throughSeq } : {}),
    });
    throughSeq ??= page.ready.snapshotLastSeq;
    yield page;
    if (!page.ready.hasMoreAfter) return;
    const next = page.ready.replayToId;
    if (next === undefined || next <= after || throughSeq === undefined) {
      throw new Error("channel replay page claims more history without a forward cursor");
    }
    after = next;
  }
}
