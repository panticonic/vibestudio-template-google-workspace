import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Theme } from "@radix-ui/themes";
import { SendButton } from "./SendButton";

// Runs in a real browser (vitest.browser.config.ts) so the Radix DropdownMenu
// portal actually opens — impossible under jsdom here (see vitest.browser.config).

afterEach(cleanup);

function renderWithTheme(ui: React.ReactElement) {
  return render(<Theme>{ui}</Theme>);
}

describe("SendButton (browser)", () => {
  it("opens the split menu and offers Send + Send after turn (no interrupt)", async () => {
    renderWithTheme(
      <SendButton intent="steer" agentBusy onSend={vi.fn()} onSendAfterTurn={vi.fn()} />
    );
    fireEvent.keyDown(screen.getByLabelText("Send options"), { key: "Enter" });
    expect(await screen.findByText("Send after turn")).toBeTruthy();
    // The "Send & interrupt" choice was removed (replaced by the flush control).
    expect(screen.queryByText("Send & interrupt")).toBeNull();
  });

  it("enables 'Send after turn' only while an agent is busy", async () => {
    renderWithTheme(
      <SendButton intent="send" agentBusy={false} onSend={vi.fn()} onSendAfterTurn={vi.fn()} />
    );
    fireEvent.keyDown(screen.getByLabelText("Send options"), { key: "Enter" });
    const idleRow = (await screen.findByText("Send after turn")).closest('[role="menuitem"]');
    expect(idleRow?.getAttribute("aria-disabled")).toBe("true");
    cleanup();

    renderWithTheme(
      <SendButton intent="steer" agentBusy onSend={vi.fn()} onSendAfterTurn={vi.fn()} />
    );
    fireEvent.keyDown(screen.getByLabelText("Send options"), { key: "Enter" });
    const busyRow = (await screen.findByText("Send after turn")).closest('[role="menuitem"]');
    expect(busyRow?.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("selecting 'Send after turn' from the opened menu fires its handler", async () => {
    const onSendAfterTurn = vi.fn();
    renderWithTheme(
      <SendButton intent="steer" agentBusy onSend={vi.fn()} onSendAfterTurn={onSendAfterTurn} />
    );
    fireEvent.keyDown(screen.getByLabelText("Send options"), { key: "Enter" });
    const row = (await screen.findByText("Send after turn")).closest('[role="menuitem"]')!;
    fireEvent.click(row);
    expect(onSendAfterTurn).toHaveBeenCalledTimes(1);
  });

  it("offers 'Attach image' in the menu and fires onAttach", async () => {
    const onAttach = vi.fn();
    renderWithTheme(
      <SendButton intent="send" agentBusy={false} onSend={vi.fn()} onSendAfterTurn={vi.fn()} onAttach={onAttach} />
    );
    fireEvent.keyDown(screen.getByLabelText("Send options"), { key: "Enter" });
    const attach = (await screen.findByText(/Attach image/i)).closest('[role="menuitem"]')!;
    fireEvent.click(attach);
    expect(onAttach).toHaveBeenCalledTimes(1);
  });

  it("shows the attached-image count on the menu item", async () => {
    renderWithTheme(
      <SendButton intent="send" agentBusy={false} onSend={vi.fn()} onSendAfterTurn={vi.fn()} onAttach={vi.fn()} attachmentCount={2} />
    );
    fireEvent.keyDown(screen.getByLabelText("Send options"), { key: "Enter" });
    expect(await screen.findByText(/Images attached \(2\)/i)).toBeTruthy();
  });
});
