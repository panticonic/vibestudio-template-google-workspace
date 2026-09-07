// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PubSubClient } from "@workspace/pubsub";

import { useChannelSignals, type ChannelSignal } from "./useChannelSignals";

function createClient(events: unknown[]): PubSubClient {
  return {
    events: vi.fn(async function* () {
      for (const event of events) yield event;
    }),
  } as unknown as PubSubClient;
}

function Probe({
  client,
  onValue,
}: {
  client: PubSubClient;
  onValue: (value: ReadonlyArray<ChannelSignal>) => void;
}) {
  const value = useChannelSignals(client, { ttlMs: 60_000 });
  onValue(value);
  return null;
}

describe("useChannelSignals", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("suppresses cleanup-only working signals", async () => {
    let latest: ReadonlyArray<ChannelSignal> = [];
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const client = createClient([
      {
        delivery: "signal",
        type: "signal",
        contentType: "vibestudio-ext-working",
        content: JSON.stringify({ message: null }),
        ts: 1,
      },
    ]);

    render(<Probe client={client} onValue={(value) => { latest = value; }} />);

    await waitFor(() => {
      expect(client.events).toHaveBeenCalledWith({ includeSignals: true });
    });
    expect(latest).toEqual([]);
    expect(debug).toHaveBeenCalledWith(
      "[useChannelSignals] suppressed transient signal",
      expect.objectContaining({
        contentType: "vibestudio-ext-working",
        content: JSON.stringify({ message: null }),
      })
    );
  });

  it("keeps substantive transient working signals visible", async () => {
    let latest: ReadonlyArray<ChannelSignal> = [];
    const client = createClient([
      {
        delivery: "signal",
        type: "signal",
        contentType: "vibestudio-ext-working",
        content: JSON.stringify({ message: "Checking credentials" }),
        ts: 1,
      },
    ]);

    render(<Probe client={client} onValue={(value) => { latest = value; }} />);

    await waitFor(() => {
      expect(latest).toEqual([
        expect.objectContaining({
          contentType: "vibestudio-ext-working",
          content: "Checking credentials",
        }),
      ]);
    });
  });

  it("does not surface inline UI payloads as transient signal pills", async () => {
    let latest: ReadonlyArray<ChannelSignal> = [];
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const client = createClient([
      {
        delivery: "signal",
        type: "signal",
        contentType: "inline_ui",
        content: JSON.stringify({ id: "ui-1", source: { type: "code", code: "export default null" } }),
        ts: 1,
      },
    ]);

    render(<Probe client={client} onValue={(value) => { latest = value; }} />);

    await waitFor(() => {
      expect(client.events).toHaveBeenCalledWith({ includeSignals: true });
    });
    expect(latest).toEqual([]);
    expect(debug).toHaveBeenCalledWith(
      "[useChannelSignals] suppressed transient signal",
      expect.objectContaining({
        contentType: "inline_ui",
      })
    );
  });

  it("does not surface fork head-change signals as transient signal pills", async () => {
    let latest: ReadonlyArray<ChannelSignal> = [];
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const client = createClient([
      {
        delivery: "signal",
        type: "signal",
        contentType: "fork.head_changed",
        content: JSON.stringify({ channelId: "chat-1", headSeq: 13 }),
        ts: 1,
      },
    ]);

    render(<Probe client={client} onValue={(value) => { latest = value; }} />);

    await waitFor(() => {
      expect(client.events).toHaveBeenCalledWith({ includeSignals: true });
    });
    expect(latest).toEqual([]);
    expect(debug).toHaveBeenCalledWith(
      "[useChannelSignals] suppressed transient signal",
      expect.objectContaining({
        contentType: "fork.head_changed",
      })
    );
  });
});
