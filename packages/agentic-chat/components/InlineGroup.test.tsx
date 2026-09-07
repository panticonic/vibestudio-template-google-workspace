// @vitest-environment jsdom

import React from "react";
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InlineGroup, type InlineItem } from "./InlineGroup";

// Radix Themes components (DropdownMenu et al.) require a Theme provider.
const render = (ui: React.ReactElement) => rtlRender(<Theme>{ui}</Theme>);
import { CustomMessageCard } from "./CustomMessage";
import type { MessageTypeComponentEntry } from "../types";
import type { InvocationCardPayload } from "@workspace/agentic-core";

type CustomInlineItem = Extract<InlineItem, { type: "custom" }>;
type ReadyMessageTypeComponentEntry = Extract<MessageTypeComponentEntry, { status: "ready" }>;

afterEach(() => {
  vi.restoreAllMocks();
});

function customItem(): CustomInlineItem {
  return {
    type: "custom",
    id: "custom-msg-1",
    payload: {
      messageId: "custom-msg-1",
      typeId: "weather",
      displayMode: "inline",
      initialState: { city: "Berlin" },
      updates: [],
      lastSeq: 1,
    },
  };
}

function customEntry(): ReadyMessageTypeComponentEntry {
  return {
    status: "ready",
    definition: {
      typeId: "weather",
      displayMode: "inline",
      source: { type: "code", code: "" },
      updatedAtSeq: 1,
    },
    cacheKey: "weather:1",
    module: {
      default: ({ expanded, displayMode }) => (
        <span>{expanded ? `expanded ${displayMode}` : `collapsed ${displayMode}`}</span>
      ),
    },
  };
}

function invocationItem(): Extract<InlineItem, { type: "invocation" }> {
  return {
    type: "invocation",
    id: "invocation-1",
    senderId: "agent-1",
    complete: true,
    invocation: {
      id: "invocation-1",
      name: "game_action",
      arguments: { move: "north" },
      execution: { status: "complete", description: "Move the player", result: { ok: true } },
    } satisfies InvocationCardPayload,
  };
}

describe("InlineGroup custom messages", () => {
  it("lets a host replace or elide individual invocation presentation", () => {
    const renderInvocation = vi.fn(({ payload, expanded, onToggle }) => (
      <button type="button" onClick={onToggle}>
        {expanded ? "expanded" : "collapsed"} {payload.name}
      </button>
    ));
    const { container } = render(
      <InlineGroup items={[invocationItem()]} renderInvocation={renderInvocation} />
    );

    expect(screen.getByText("collapsed game_action")).toBeTruthy();
    expect(container.querySelector('[data-testid="invocation-pill"]')).toBeNull();

    fireEvent.click(screen.getByText("collapsed game_action"));
    expect(screen.getByText("expanded game_action")).toBeTruthy();
    expect(renderInvocation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expanded: true,
        payload: expect.objectContaining({ name: "game_action" }),
      }),
      expect.anything()
    );

    const hidden = render(<InlineGroup items={[invocationItem()]} renderInvocation={() => null} />);
    expect(hidden.container.querySelector('[data-invocation-name="game_action"]')).toBeNull();
  });

  it("lets the host toggle custom renderers between collapsed and expanded views", () => {
    render(
      <InlineGroup
        items={[customItem()]}
        messageTypeComponents={new Map([["weather", customEntry()]])}
      />
    );

    const collapsed = screen.getByText("collapsed inline");
    expect(collapsed).toBeTruthy();

    fireEvent.click(collapsed);

    expect(screen.queryByText("collapsed inline")).toBeNull();
    expect(screen.getByText("expanded inline")).toBeTruthy();
  });

  it("expands collapsed custom messages with Enter and Space", () => {
    const first = render(
      <InlineGroup
        items={[customItem()]}
        messageTypeComponents={new Map([["weather", customEntry()]])}
      />
    );

    fireEvent.keyDown(screen.getByRole("button", { expanded: false }), { key: "Enter" });
    expect(screen.getByText("expanded inline")).toBeTruthy();
    first.unmount();

    render(
      <InlineGroup
        items={[customItem()]}
        messageTypeComponents={new Map([["weather", customEntry()]])}
      />
    );

    fireEvent.keyDown(screen.getByRole("button", { expanded: false }), { key: " " });
    expect(screen.getByText("expanded inline")).toBeTruthy();
  });

  it("isolates render errors in custom messages to a local fallback", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const entry = customEntry();
    entry.module.default = () => {
      throw new Error("renderer exploded");
    };

    render(<CustomMessageCard payload={customItem().payload} entry={entry} chat={{}} />);

    expect(screen.getByText("Custom message error: weather")).toBeTruthy();
    expect(screen.getByText("renderer exploded")).toBeTruthy();
  });

  it("publishes ui.feedback targeted at the card owner when a renderer crashes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const publish = vi.fn().mockResolvedValue(undefined);
    const entry = customEntry();
    entry.definition.source = {
      type: "code",
      code: "export default function Renderer() { return null; }",
    };
    entry.module.default = () => {
      throw new Error("renderer exploded");
    };
    const item = customItem();
    item.payload.by = {
      kind: "agent",
      id: "weather-agent",
      participantId: "do:workers/agent:WeatherAgent:weather-1",
    };

    render(<CustomMessageCard payload={item.payload} entry={entry} chat={{ publish }} />);

    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        "agentic.trajectory.v1/event",
        expect.objectContaining({
          kind: "ui.feedback",
          payload: expect.objectContaining({
            target: expect.objectContaining({
              kind: "agent",
              id: "weather-agent",
              participantId: "do:workers/agent:WeatherAgent:weather-1",
            }),
            to: [
              {
                kind: "participant",
                participantId: "do:workers/agent:WeatherAgent:weather-1",
              },
            ],
            category: "render_failed",
            refs: expect.objectContaining({ messageId: "custom-msg-1", typeId: "weather" }),
            error: expect.objectContaining({ message: "renderer exploded" }),
            occurrenceKey: "render_failed:custom-msg-1:1",
          }),
        }),
        expect.objectContaining({
          idempotencyKey: "ui-feedback:render_failed:custom-msg-1:1",
        })
      )
    );
  });

  it("keeps prior state when a reducer throws instead of blanking the card", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const item = customItem();
    item.payload.updates = [{ seq: 2, update: { city: "Paris" } }];
    item.payload.lastSeq = 2;
    const entry = customEntry();
    // Render the folded state's city so we can prove the prior state survived.
    entry.module.default = ({ state }) => (
      <span>city: {(state as { city?: string })?.city ?? "none"}</span>
    );
    entry.module.reduce = () => {
      throw new Error("reduce exploded");
    };

    render(<CustomMessageCard payload={item.payload} entry={entry} chat={{}} />);

    // No error fallback; the seed state (Berlin) is preserved, Paris dropped.
    expect(screen.queryByText("Custom message error: weather")).toBeNull();
    expect(screen.getByText("city: Berlin")).toBeTruthy();
  });

  it("renders a dedicated Pill export for the collapsed inline view", () => {
    const entry = customEntry();
    entry.module.Pill = ({ expanded }) => <span>pill {expanded ? "open" : "closed"}</span>;

    render(
      <InlineGroup items={[customItem()]} messageTypeComponents={new Map([["weather", entry]])} />
    );

    // Collapsed bead uses Pill, not the default component.
    expect(screen.getByText("pill closed")).toBeTruthy();
    expect(screen.queryByText("collapsed inline")).toBeNull();

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    // Expanded view falls back to the default component.
    expect(screen.getByText("expanded inline")).toBeTruthy();
  });

  it("expands a stuck-loading pill into an inspectable diagnostic card", () => {
    const loadingEntry: MessageTypeComponentEntry = {
      status: "loading",
      stage: "loading-source",
      startedAt: Date.now() - 5000,
      definition: {
        typeId: "weather",
        displayMode: "inline",
        source: { type: "file", path: "skills/weather/renderer.tsx" },
        updatedAtSeq: 7,
        cleared: false,
      },
    };
    render(
      <InlineGroup
        items={[customItem()]}
        messageTypeComponents={new Map([["weather", loadingEntry]])}
      />
    );

    // The spinner pill is clickable and self-describing.
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getAllByText(/Loading renderer source file/).length).toBeGreaterThan(0);
    // Copy details now lives behind the card actions ("⋯") menu — the popper
    // content can't open in jsdom (duplicate React under @floating-ui), so
    // assert the menu trigger by its accessible name.
    expect(screen.getByLabelText("Card actions")).toBeTruthy();
    fireEvent.click(screen.getByText(/Details/));
    expect(screen.getByText("skills/weather/renderer.tsx")).toBeTruthy();
  });

  it("expands a pill in place, splitting its sibling row above and below", () => {
    const items: InlineItem[] = [
      { type: "thinking", id: "t1", content: "Alpha", complete: true },
      { type: "thinking", id: "t2", content: "Bravo", complete: true },
      { type: "thinking", id: "t3", content: "Charlie", complete: true },
    ];
    const { container } = render(<InlineGroup items={items} />);

    // Collapsed: a single wrapping pill row, nothing expanded.
    expect(container.querySelectorAll(".inline-expanded-item").length).toBe(0);
    expect(container.querySelectorAll(".inline-pill-row").length).toBe(1);

    fireEvent.click(screen.getByLabelText("Thinking: Bravo"));

    // The middle pill's detail is hoisted between the surrounding pill rows:
    // [pills: Alpha] [expanded: Bravo] [pills: Charlie] — not dumped below all.
    const body = container.querySelector(".inline-group-body")!;
    const segments = Array.from(body.children).map((el) => el.className);
    expect(segments).toEqual([
      expect.stringContaining("inline-pill-row"),
      expect.stringContaining("inline-expanded-item"),
      expect.stringContaining("inline-pill-row"),
    ]);
    expect(body.children[1]!.textContent).toContain("Bravo");
  });

  it("keeps multiple pills expanded at the same time", () => {
    const items: InlineItem[] = [
      { type: "thinking", id: "t1", content: "Alpha", complete: true },
      { type: "thinking", id: "t2", content: "Bravo", complete: true },
    ];
    const { container } = render(<InlineGroup items={items} />);

    fireEvent.click(screen.getByLabelText("Thinking: Alpha"));
    fireEvent.click(screen.getByLabelText("Thinking: Bravo"));

    // Both open at once — no single-expansion limit.
    expect(container.querySelectorAll(".inline-expanded-item").length).toBe(2);
    expect(container.querySelectorAll(".inline-pill-row").length).toBe(0);
  });

  it("collapses an expanded pill back into its row", () => {
    const items: InlineItem[] = [{ type: "thinking", id: "t1", content: "Alpha", complete: true }];
    render(<InlineGroup items={items} />);

    fireEvent.click(screen.getByLabelText("Thinking: Alpha"));
    expect(screen.getByText("Thinking")).toBeTruthy(); // expanded header
    fireEvent.click(screen.getByText("Thinking")); // header toggles collapse
    expect(screen.getByLabelText("Thinking: Alpha")).toBeTruthy(); // pill is back
  });

  it("surfaces a validation callout when the schema rejects state", () => {
    const entry = customEntry();
    entry.definition.stateSchema = {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    };
    const item = customItem();
    item.payload.initialState = {}; // no city -> invalid

    render(<CustomMessageCard payload={item.payload} entry={entry} chat={{}} />);

    expect(screen.getByText("Invalid weather state")).toBeTruthy();
    expect(screen.getByText("city: Required")).toBeTruthy();
  });
});
