import { describe, expect, it } from "vitest";
import { BashArgsSchema } from "./tool-types.js";

describe("BashArgsSchema", () => {
  it("accepts supported bash arguments", () => {
    const parsed = BashArgsSchema.safeParse({
      command: "pnpm test",
      description: "Run tests",
      run_in_background: false,
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects timeout arguments", () => {
    const parsed = BashArgsSchema.safeParse({
      command: "pnpm test",
      timeout: 10_000,
    });

    expect(parsed.success).toBe(false);
  });
});
