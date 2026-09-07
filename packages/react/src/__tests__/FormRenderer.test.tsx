// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import type { FieldDefinition, FieldValue } from "@vibestudio/types";
import { FormRenderer } from "../FormRenderer";

function renderControlledForm(schema: FieldDefinition[], options: { onSubmit?: () => void } = {}) {
  const onChange = vi.fn<(key: string, value: FieldValue) => void>();

  function Harness() {
    const [values, setValues] = React.useState<Record<string, FieldValue>>({});
    return (
      <Theme>
        <FormRenderer
          schema={schema}
          values={values}
          onChange={(key, value) => {
            onChange(key, value);
            setValues((prev) => ({ ...prev, [key]: value }));
          }}
          onSubmit={options.onSubmit}
        />
      </Theme>
    );
  }

  render(<Harness />);
  return { onChange };
}

describe("FormRenderer", () => {
  it("renders multi-select bulk actions without selecting the free-text choice", () => {
    const { onChange } = renderControlledForm([
      {
        key: "items",
        label: "Items",
        type: "multiSelect",
        allowFreeText: true,
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(onChange).toHaveBeenLastCalledWith("items", ["a", "b"]);

    fireEvent.click(screen.getByRole("button", { name: "Deselect all" }));
    expect(onChange).toHaveBeenLastCalledWith("items", []);
  });

  it("submits predefined segmented choices but waits for free-text choices", async () => {
    const onSubmit = vi.fn();
    renderControlledForm(
      [
        {
          key: "answer",
          label: "Answer",
          type: "segmented",
          allowFreeText: true,
          submitOnSelect: true,
          options: [{ value: "a", label: "A" }],
        },
      ],
      { onSubmit }
    );

    fireEvent.click(screen.getByRole("radio", { name: "Other" }));
    expect(screen.getByPlaceholderText("Type your answer...")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: "A" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({ answer: "a" });
  });
});
