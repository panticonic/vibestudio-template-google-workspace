import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "@vitest/browser/context";
import { Theme } from "@radix-ui/themes";
import GmailCompose from "./gmail-compose";
import "@radix-ui/themes/styles.css";

afterEach(cleanup);
it.each([320, 390, 1280])(
  "retains edits on a rejected save, restores the accepted draft, and preserves accepted send feedback at %i pixels",
  async (width) => {
    await page.viewport(width, 1000);
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error("Draft permission denied"))
      .mockResolvedValueOnce({ saved: true, draftId: "remote-owned-draft" })
      .mockResolvedValueOnce({
        sent: true,
        id: "accepted-message",
        warning: "Sent successfully; filing the receipt needs attention",
      });
    const chat = { callMethodByHandle: call };
    const base = {
      to: "recipient@example.test",
      subject: "A first draft",
      body: "Original body",
      status: "drafting" as const,
    };
    const view = render(
      <Theme>
        <GmailCompose
          expanded
          messageId="owned-compose"
          state={base}
          chat={chat}
        />
      </Theme>,
    );
    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "My edited subject" },
    });
    fireEvent.change(screen.getByLabelText("Message body"), {
      target: { value: "Keep this edited body" },
    });
    screen.getByRole("button", { name: "Save draft" }).focus();
    await act(() => userEvent.keyboard("{Enter}"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Draft permission denied",
    );
    expect(
      (screen.getByLabelText("Message body") as HTMLTextAreaElement).value,
    ).toBe("Keep this edited body");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[1]).toEqual([
      "gmail",
      "saveDraft",
      expect.objectContaining({
        messageId: "owned-compose",
        subject: "My edited subject",
        body: "Keep this edited body",
      }),
    ]);
    view.unmount();
    render(
      <Theme>
        <GmailCompose
          expanded
          messageId="owned-compose"
          state={{
            ...base,
            subject: "My edited subject",
            body: "Keep this edited body",
            draftId: "remote-owned-draft",
            status: "saved",
          }}
          chat={chat}
        />
      </Theme>,
    );
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe(
      "My edited subject",
    );
    const remove = screen.getByRole("button", {
      name: "Remove recipient@example.test from To",
    });
    remove.focus();
    await act(() => userEvent.keyboard("{Enter}"));
    expect(document.activeElement).toBe(screen.getByLabelText("To"));
    await act(() =>
      userEvent.fill(screen.getByLabelText("To"), "recipient@example.test"),
    );
    await act(() => userEvent.keyboard("{Enter}"));
    fireEvent.click(screen.getByRole("button", { name: "Review send" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm send" }));
    expect((await screen.findByRole("status")).textContent).toContain(
      "Sent successfully",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Sent")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Review send" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(call.mock.calls[2]).toEqual([
      "gmail",
      "gmail_send",
      expect.objectContaining({
        messageId: "owned-compose",
        draftId: "remote-owned-draft",
        body: "Keep this edited body",
      }),
    ]);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width + 1);
  },
);

it("retires a previous compose editor when the message identity changes", async () => {
  let finish!: (value: unknown) => void;
  const call = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const props = {
    expanded: true,
    chat: { callMethodByHandle: call },
    state: {
      to: "one@example.test",
      subject: "First",
      body: "First body",
      status: "drafting" as const,
    },
  };
  const view = render(
    <Theme>
      <GmailCompose {...props} messageId="first" />
    </Theme>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  view.rerender(
    <Theme>
      <GmailCompose
        {...props}
        messageId="second"
        state={{ ...props.state, subject: "Second", body: "Second body" }}
      />
    </Theme>,
  );
  expect(
    (screen.getByLabelText("Message body") as HTMLTextAreaElement).value,
  ).toBe("Second body");
  expect(
    (screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  await act(async () => finish({ warning: "Old editor receipt" }));
  expect(screen.queryByText("Old editor receipt")).toBeNull();
});
