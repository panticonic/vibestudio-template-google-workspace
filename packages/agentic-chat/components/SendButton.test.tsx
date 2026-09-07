// @vitest-environment jsdom

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Theme } from "@radix-ui/themes";
import { SendButton } from "./SendButton";

function renderWithTheme(ui: React.ReactElement) {
  return render(<Theme>{ui}</Theme>);
}

// The primary button is icon-only; its intent is exposed via aria-label
// ("Send (…)" / "Steer (…)" / "Queue after turn (…)"). The chevron's label is
// "Send options", so `/^Send \(/` matches the primary, not the chevron.
describe("SendButton", () => {
  it("primary intent tracks Send → Steer → Queue after turn (via aria-label)", () => {
    const noop = () => {};
    const { rerender } = renderWithTheme(
      <SendButton intent="send" agentBusy={false} onSend={noop} onSendAfterTurn={noop} />
    );
    expect(screen.getByLabelText(/^Send \(/)).toBeTruthy();

    rerender(
      <Theme>
        <SendButton intent="steer" agentBusy onSend={noop} onSendAfterTurn={noop} />
      </Theme>
    );
    expect(screen.getByLabelText(/^Steer \(/)).toBeTruthy();

    rerender(
      <Theme>
        <SendButton intent="queue" agentBusy onSend={noop} onSendAfterTurn={noop} />
      </Theme>
    );
    expect(screen.getByLabelText(/^Queue after turn \(/)).toBeTruthy();
  });

  it("primary button click fires the default send", () => {
    const onSend = vi.fn();
    renderWithTheme(
      <SendButton intent="send" agentBusy={false} onSend={onSend} onSendAfterTurn={vi.fn()} />
    );
    fireEvent.click(screen.getByLabelText(/^Send \(/));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("the chevron carries an accent dot only when an agent is busy", () => {
    const { container, rerender } = renderWithTheme(
      <SendButton intent="send" agentBusy={false} onSend={vi.fn()} onSendAfterTurn={vi.fn()} />
    );
    expect(container.querySelector(".send-button-accent-dot")).toBeNull();

    rerender(
      <Theme>
        <SendButton intent="steer" agentBusy onSend={vi.fn()} onSendAfterTurn={vi.fn()} />
      </Theme>
    );
    expect(container.querySelector(".send-button-accent-dot")).toBeTruthy();
  });

  it("disables the control when there is nothing to send", () => {
    renderWithTheme(
      <SendButton intent="send" agentBusy={false} disabled onSend={vi.fn()} onSendAfterTurn={vi.fn()} />
    );
    const primary = screen.getByLabelText(/^Send \(/).closest("button");
    expect(primary?.hasAttribute("disabled")).toBe(true);
  });

  it("can keep the options menu available while primary send is disabled", () => {
    renderWithTheme(
      <SendButton
        intent="send"
        agentBusy={false}
        disabled
        optionsDisabled={false}
        onSend={vi.fn()}
        onSendAfterTurn={vi.fn()}
        onAttach={vi.fn()}
      />
    );
    const primary = screen.getByLabelText(/^Send \(/).closest("button");
    const options = screen.getByLabelText("Send options").closest("button");
    expect(primary?.hasAttribute("disabled")).toBe(true);
    expect(options?.hasAttribute("disabled")).toBe(false);
  });

});
