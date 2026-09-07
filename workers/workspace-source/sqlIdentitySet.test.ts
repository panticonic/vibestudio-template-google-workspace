// Builtin semantic-authority tests.
import { describe, expect, it } from "vitest";

import { sqlIdentitySet } from "./sqlIdentitySet.js";

describe("sqlIdentitySet", () => {
  it("binds large identity collections as one canonical set value", () => {
    const values = Array.from({ length: 2_000 }, (_, index) => `identity:${2_000 - index}`);
    const encoded = sqlIdentitySet([...values, values[0]!]);
    const decoded = JSON.parse(encoded) as string[];

    expect(decoded).toHaveLength(2_000);
    expect(new Set(decoded).size).toBe(2_000);
    expect(decoded).toEqual([...decoded].sort());
  });
});
