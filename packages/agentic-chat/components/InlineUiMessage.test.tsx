// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConsoleCapture } from "@workspace/eval";

const chatContext = vi.hoisted(() => ({
  browserHandoffCaller: { id: "panel:chat", kind: "panel" },
  chat: {
    send: vi.fn(async () => undefined),
    publish: vi.fn(async () => undefined),
    callMethod: vi.fn(async () => undefined),
    rpc: { call: vi.fn(async () => undefined) },
    contextId: "context:test",
    channelId: "channel:test",
  },
  scope: {},
  scopes: {
    save: vi.fn(async () => undefined),
    push: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
  },
  scopeManager: {
    persist: vi.fn(async () => undefined),
    onChange: vi.fn(() => () => undefined),
  },
  selfId: "panel:chat",
}));

vi.mock("../context/ChatContext", () => ({
  useChatContext: () => chatContext,
}));

import { InlineUiMessage } from "./InlineUiMessage";

afterEach(() => {
  vi.restoreAllMocks();
  chatContext.chat.send.mockReset().mockResolvedValue(undefined);
});

describe("InlineUiMessage", () => {
  it("clears a component failure when the same stable id receives a new render revision", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    function BrokenComponent(): React.ReactNode {
      throw new Error("broken renderer");
    }

    function RepairedComponent() {
      return <div>renderer recovered</div>;
    }

    const data = {
      id: "stable-card",
      source: {
        type: "code" as const,
        code: "export default function Card() {}",
      },
      props: { unchanged: true },
      renderedAt: "first-revision",
    };
    const view = render(
      <InlineUiMessage
        data={data}
        messageId="inline-ui:agent:stable-card"
        compiledComponent={BrokenComponent}
      />,
    );

    await waitFor(() =>
      expect(view.getAllByText(/broken renderer/).length).toBeGreaterThan(0),
    );

    view.rerender(
      <InlineUiMessage
        data={{ ...data, renderedAt: "second-revision" }}
        messageId="inline-ui:agent:stable-card"
        compiledComponent={RepairedComponent}
      />,
    );

    await waitFor(() =>
      expect(view.getByText("renderer recovered")).toBeTruthy(),
    );
    expect(view.queryAllByText(/broken renderer/)).toHaveLength(0);
  });

  it("shows bounded, copyable console output scoped to the exact inline UI message", async () => {
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const capture = createConsoleCapture({ capacity: 2 });
    capture.proxy.log("discard me");
    capture.proxy.warn("template epoch", 58);
    capture.proxy.error("template epoch", 59);

    const data = {
      id: "onboarding-overview",
      source: {
        type: "code" as const,
        code: "export default function Card() {}",
      },
    };
    const view = render(
      <InlineUiMessage
        data={data}
        messageId="inline-ui:onboarding-agent:onboarding-overview"
        compiledComponent={() => <div>setup</div>}
        runtime={{ console: capture }}
      />,
    );

    const consoleRegion = view.getByRole("region", {
      name: "Console output for inline UI onboarding-overview",
    });
    expect(consoleRegion.getAttribute("data-message-id")).toBe(
      "inline-ui:onboarding-agent:onboarding-overview",
    );
    expect(consoleRegion.textContent).toContain("template epoch 58");
    expect(consoleRegion.textContent).toContain("template epoch 59");
    expect(consoleRegion.textContent).toContain("1 older entry omitted");
    expect(consoleRegion.textContent).not.toContain("discard me");

    fireEvent.click(
      view.getByRole("button", {
        name: "Copy console for inline UI onboarding-overview",
      }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = JSON.parse(writeText.mock.calls[0]![0] as string) as Record<
      string,
      unknown
    >;
    expect(copied).toMatchObject({
      kind: "inline-ui-console",
      componentId: "onboarding-overview",
      messageId: "inline-ui:onboarding-agent:onboarding-overview",
      capacity: 2,
      dropped: 1,
    });

    capture.proxy.info("after interaction");
    await waitFor(() =>
      expect(consoleRegion.textContent).toContain("after interaction"),
    );
    expect(consoleRegion.textContent).toContain("2 older entries omitted");
  });

  it("surfaces and copies a structured render error with its message identity", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const data = {
      id: "broken-card",
      source: { type: "file" as const, path: "skills/setup/BrokenCard.tsx" },
    };
    const Broken = () => {
      throw new Error("renderer exploded");
    };
    const view = render(
      <InlineUiMessage
        data={data}
        messageId="inline-ui:setup-agent:broken-card"
        compiledComponent={Broken}
      />,
    );

    await waitFor(() =>
      expect(view.getAllByText(/renderer exploded/).length).toBeGreaterThan(0),
    );
    const callout = view.container.querySelector(
      '[data-inline-ui-error="broken-card"]',
    );
    expect(callout?.getAttribute("data-message-id")).toBe(
      "inline-ui:setup-agent:broken-card",
    );
    fireEvent.click(
      view.getByRole("button", {
        name: "Copy error details for inline UI broken-card",
      }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(JSON.parse(writeText.mock.calls[0]![0] as string)).toMatchObject({
      kind: "inline-ui-error",
      phase: "render",
      componentId: "broken-card",
      messageId: "inline-ui:setup-agent:broken-card",
      source: "skills/setup/BrokenCard.tsx",
      message: "renderer exploded",
    });
  });

  it("surfaces an event-handler failure as an interaction error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const data = {
      id: "interactive-card",
      source: {
        type: "code" as const,
        code: "export default function Card() {}",
      },
    };
    function Interactive() {
      return (
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(
              new ErrorEvent("error", {
                error: new Error("template registry rejected"),
              }),
            );
          }}
        >
          Load templates
        </button>
      );
    }
    const view = render(
      <InlineUiMessage
        data={data}
        messageId="inline-ui:setup-agent:interactive-card"
        compiledComponent={Interactive}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Load templates" }));

    await waitFor(() =>
      expect(
        view.getAllByText(/template registry rejected/).length,
      ).toBeGreaterThan(0),
    );
    fireEvent.click(view.getByText("Technical details"));
    expect(view.getByText(/Phase: interaction/)).toBeTruthy();
    expect(
      view.getByText(/Message: inline-ui:setup-agent:interactive-card/),
    ).toBeTruthy();
  });
});
