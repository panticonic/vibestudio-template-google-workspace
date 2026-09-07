// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ChatLayout } from "./ChatLayout";

vi.mock("./ChatHeader", () => ({
  ChatHeader: () => <div data-testid="stock-header">Stock header</div>,
}));
vi.mock("./ChatConnectionErrorBanner", () => ({ ChatConnectionErrorBanner: () => null }));
vi.mock("./ChatDirtyRepoWarnings", () => ({ ChatDirtyRepoWarnings: () => null }));
vi.mock("./LazyChatActionBar", () => ({
  LazyChatActionBar: () => <div data-testid="action-bar" />,
}));
vi.mock("./ChatMessageArea", () => ({
  ChatMessageArea: (props: {
    renderMessage?: unknown;
    renderInlineGroup?: unknown;
    renderInvocation?: unknown;
    renderEmptyState?: unknown;
    features: { inlineUi: boolean };
  }) => (
    <div
      data-testid="message-area"
      data-inline-ui={String(props.features.inlineUi)}
      data-render-message={String(props.renderMessage !== undefined)}
      data-render-inline-group={String(props.renderInlineGroup !== undefined)}
      data-render-invocation={String(props.renderInvocation !== undefined)}
      data-render-empty-state={String(props.renderEmptyState !== undefined)}
    />
  ),
}));
vi.mock("./LazyChatFeedbackArea", () => ({
  LazyChatFeedbackArea: () => <div data-testid="feedback-area" />,
}));
vi.mock("./Outbox", () => ({ Outbox: () => <div data-testid="stock-outbox" /> }));
vi.mock("./PendingDeliveryQueue", () => ({
  PendingDeliveryQueue: () => <div data-testid="stock-pending-delivery" />,
}));
vi.mock("./ChatDebugConsole", () => ({ ChatDebugConsole: () => null }));
vi.mock("./ChatInput", () => ({
  ChatInput: (props: {
    placeholder?: string;
    defaultMentions?: readonly string[];
    disabled?: boolean;
  }) => (
    <div
      data-testid="composer"
      data-placeholder={props.placeholder}
      data-default-mentions={props.defaultMentions?.join(",")}
      data-disabled={String(props.disabled)}
    />
  ),
}));

describe("ChatLayout sizing", () => {
  const fullFeatures = {
    feedback: true,
    inlineUi: true,
    actionBar: true,
    clientEval: true,
  } as const;

  it("fills its AgenticChat host so embedded composers remain visible", () => {
    const { container, getByTestId } = render(<ChatLayout features={fullFeatures} />);
    const root = container.querySelector<HTMLElement>(".agentic-chat-root");
    expect(root?.style.height).toBe("100%");
    expect(getByTestId("composer")).toBeTruthy();
  });

  it("mounts every explicitly selected browser-owned UI surface", () => {
    const { getByTestId } = render(<ChatLayout features={fullFeatures} />);

    expect(getByTestId("action-bar")).toBeTruthy();
    expect(getByTestId("feedback-area")).toBeTruthy();
    expect(getByTestId("message-area").dataset["inlineUi"]).toBe("true");
  });

  it("omits unselected UI surfaces and forwards transcript renderers", () => {
    const renderMessage = vi.fn();
    const renderInlineGroup = vi.fn();
    const renderInvocation = vi.fn();
    const renderEmptyState = vi.fn();
    const renderHeader = vi.fn((defaultContent: ReactNode) => (
      <div data-testid="product-header">{defaultContent}</div>
    ));
    const renderDeliveryStatus = vi.fn((defaultContent: ReactNode) => (
      <div data-testid="product-delivery-status">{defaultContent}</div>
    ));
    const renderComposer = vi.fn((defaultContent: ReactNode) => (
      <div data-testid="product-composer">{defaultContent}</div>
    ));
    const { getByTestId, queryByTestId } = render(
      <ChatLayout
        features={{ feedback: false, inlineUi: false, actionBar: false, clientEval: false }}
        renderMessage={renderMessage}
        renderInlineGroup={renderInlineGroup}
        renderInvocation={renderInvocation}
        renderEmptyState={renderEmptyState}
        renderHeader={renderHeader}
        renderDeliveryStatus={renderDeliveryStatus}
        renderComposer={renderComposer}
        composerPlaceholder="Issue a bridge directive…"
        composerDefaultMentions={["engineering", "navigation"]}
        composerDisabled
      />
    );

    expect(queryByTestId("action-bar")).toBeNull();
    expect(queryByTestId("feedback-area")).toBeNull();
    expect(getByTestId("message-area")).toMatchObject({
      dataset: expect.objectContaining({
        inlineUi: "false",
        renderMessage: "true",
        renderInlineGroup: "true",
        renderInvocation: "true",
        renderEmptyState: "true",
      }),
    });
    expect(getByTestId("composer").dataset["placeholder"]).toBe("Issue a bridge directive…");
    expect(getByTestId("composer").dataset["defaultMentions"]).toBe("engineering,navigation");
    expect(getByTestId("composer").dataset["disabled"]).toBe("true");
    expect(getByTestId("product-header").contains(getByTestId("stock-header"))).toBe(true);
    expect(
      getByTestId("product-delivery-status").contains(getByTestId("stock-pending-delivery"))
    ).toBe(true);
    expect(getByTestId("product-delivery-status").contains(getByTestId("stock-outbox"))).toBe(true);
    expect(getByTestId("product-composer").contains(getByTestId("composer"))).toBe(true);
    expect(renderHeader).toHaveBeenCalledOnce();
    expect(renderDeliveryStatus).toHaveBeenCalledOnce();
    expect(renderComposer).toHaveBeenCalledOnce();
  });

  it("lets products elide delivery status and the composer without changing capabilities", () => {
    const { queryByTestId, getByTestId } = render(
      <ChatLayout
        features={fullFeatures}
        renderDeliveryStatus={() => null}
        renderComposer={() => null}
      />
    );

    expect(getByTestId("message-area")).toBeTruthy();
    expect(getByTestId("feedback-area")).toBeTruthy();
    expect(queryByTestId("stock-pending-delivery")).toBeNull();
    expect(queryByTestId("stock-outbox")).toBeNull();
    expect(queryByTestId("composer")).toBeNull();
  });
});
