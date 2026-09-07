import { describe, expect, it } from "vitest";
import { FeedbackFormArgsSchema } from "./protocol-schemas.js";

const baseFeedbackForm = {
  title: "Confirm",
  fields: [
    { key: "choice", label: "Choice", type: "string" },
  ],
};

describe("FeedbackFormArgsSchema", () => {
  it("accepts supported feedback form arguments", () => {
    const parsed = FeedbackFormArgsSchema.safeParse({
      ...baseFeedbackForm,
      values: { choice: "yes" },
      submitLabel: "Continue",
      cancelLabel: "Cancel",
      severity: "info",
      hideSubmit: false,
      hideCancel: false,
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts free-text choice configuration", () => {
    const parsed = FeedbackFormArgsSchema.safeParse({
      title: "Choose",
      fields: [
        {
          key: "choice",
          label: "Choice",
          type: "segmented",
          variant: "cards",
          allowFreeText: true,
          freeTextLabel: "Something else",
          freeTextPlaceholder: "Describe it",
          freeTextKey: "choiceOther",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("Expected feedback schema to parse");
    expect(parsed.data.fields[0]?.variant).toBe("cards");
  });

  it("accepts cross-field warning conditions advertised to agents", () => {
    const parsed = FeedbackFormArgsSchema.safeParse({
      title: "Choose access",
      fields: [
        {
          key: "accessLevel",
          label: "Access",
          type: "select",
          options: [{ value: "broad", label: "Broad" }],
        },
        {
          key: "acknowledgement",
          label: "Acknowledgement",
          type: "boolean",
          warnings: [
            {
              when: { field: "accessLevel", operator: "eq", value: "broad" },
              message: "Broad access grants extensive repository permissions.",
              severity: "warning",
            },
          ],
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects timeout arguments", () => {
    const parsed = FeedbackFormArgsSchema.safeParse({
      ...baseFeedbackForm,
      timeout: 10_000,
      timeoutAction: "submit",
    });

    expect(parsed.success).toBe(false);
  });
});
