import { describe, expect, it } from "vitest";
import type { FieldDefinition } from "@vibestudio/types";
import { getFieldWarning } from "../formSchema.js";

describe("getFieldWarning", () => {
  it("evaluates a cross-field warning against the complete form", () => {
    const field: FieldDefinition = {
      key: "acknowledgement",
      label: "Acknowledgement",
      type: "boolean",
      warnings: [
        {
          when: { field: "accessLevel", operator: "eq", value: "broad" },
          message: "Broad access grants extensive repository permissions.",
        },
      ],
    };

    expect(getFieldWarning(field, { accessLevel: "limited" })).toBeNull();
    expect(getFieldWarning(field, { accessLevel: "broad" })?.message).toBe(
      "Broad access grants extensive repository permissions."
    );
  });

  it("preserves terse predicates over the warned field's own value", () => {
    const field: FieldDefinition = {
      key: "accessLevel",
      label: "Access",
      type: "select",
      warnings: [{ when: ["broad", "admin"], message: "Elevated access." }],
    };

    expect(getFieldWarning(field, { accessLevel: "limited" })).toBeNull();
    expect(getFieldWarning(field, { accessLevel: "broad" })?.message).toBe("Elevated access.");
  });
});
