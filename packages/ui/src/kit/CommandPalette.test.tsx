import { describe, expect, it } from "vitest";
import { groupCommandSections, type CommandItem } from "./CommandPalette";

// NOTE: the CommandPalette renders inside a Radix Dialog (a portaled overlay).
// Opening any Radix overlay in jsdom currently crashes on a duplicate-React
// instance pulled in via `react-remove-scroll` (a pnpm hoist/hardlink quirk
// that vitest's alias/dedupe cannot reconcile), so the primitive's behaviour is
// covered here at the pure-logic level - the section grouping - and end-to-end
// at runtime. See the chat-delivery status note for the infra follow-up.

const item = (id: string, section?: string): CommandItem<string> => ({ id, label: id, section, value: id });

describe("groupCommandSections", () => {
  it("groups consecutive items that share a section under one header", () => {
    const sections = groupCommandSections([
      item("a", "Fruit"),
      item("b", "Fruit"),
      item("c", "Veg"),
    ]);
    expect(sections.map((s) => s.label)).toEqual(["Fruit", "Veg"]);
    expect(sections[0]!.items.map((x) => x.item.id)).toEqual(["a", "b"]);
    expect(sections[1]!.items.map((x) => x.item.id)).toEqual(["c"]);
  });

  it("preserves the original flat index so keyboard nav stays aligned", () => {
    const sections = groupCommandSections([
      item("a", "Fruit"),
      item("b", "Veg"),
      item("c", "Fruit"),
    ]);
    // Same label appearing non-contiguously starts a fresh group (no merge).
    expect(sections.map((s) => s.label)).toEqual(["Fruit", "Veg", "Fruit"]);
    expect(sections.flatMap((s) => s.items.map((x) => x.index))).toEqual([0, 1, 2]);
  });

  it("treats missing sections as one contiguous null-labelled run", () => {
    const sections = groupCommandSections([item("a"), item("b"), item("c", "X")]);
    expect(sections.map((s) => s.label)).toEqual([null, "X"]);
    expect(sections[0]!.items).toHaveLength(2);
  });

  it("returns nothing for an empty list", () => {
    expect(groupCommandSections([])).toEqual([]);
  });
});
