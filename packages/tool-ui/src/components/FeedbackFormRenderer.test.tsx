// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/react", async () => {
  const actual = await import("../../../react/src/FormRenderer");
  return { FormRenderer: actual.FormRenderer };
});

import { FeedbackFormRenderer } from "./FeedbackFormRenderer";

describe("FeedbackFormRenderer", () => {
  it("submits the selected required value instead of the previous render", async () => {
    const onSubmit = vi.fn();

    render(
      <Theme>
        <FeedbackFormRenderer
          title="Choose"
          fields={[
            {
              key: "answer",
              type: "segmented",
              label: "Answer",
              required: true,
              allowFreeText: false,
              submitOnSelect: true,
              options: [
                { value: "Accept", label: "Accept" },
                { value: "Decline", label: "Decline" },
              ],
            },
          ]}
          hideSubmit
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />
      </Theme>
    );

    fireEvent.click(screen.getByRole("radio", { name: "Accept" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ answer: "Accept" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a correctable validation error inside the open form", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    render(
      <Theme>
        <FeedbackFormRenderer
          title="Required answer"
          fields={[{ key: "answer", type: "string", label: "Answer", required: true }]}
          submitLabel="Send"
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      </Theme>
    );

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByRole("alert").textContent).toContain('Required field "Answer" is missing');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });
});
