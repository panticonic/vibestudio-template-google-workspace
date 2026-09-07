import React, { useMemo, useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Theme } from "@radix-ui/themes";
import { CommandPalette, type CommandItem } from "./CommandPalette";

// Real-browser test (vitest.browser.config.ts): the CommandPalette renders in a
// Radix Dialog, whose portal can't mount under jsdom here. The pure section
// grouping is covered in CommandPalette.test.tsx; this exercises the rendered
// behaviour - keyboard nav, modifier forwarding, mousedown select, the
// labelNode/hintNode/trailing overrides, and the empty/search-icon affordances.

afterEach(cleanup);

function Harness<T>(props: {
  items: CommandItem<T>[];
  onSelect: (item: CommandItem<T>, mods: { shift: boolean; mod: boolean; alt: boolean }) => void;
  searchIcon?: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  return (
    <Theme>
      <CommandPalette<T>
        open
        onOpenChange={() => {}}
        query={query}
        onQueryChange={setQuery}
        items={props.items}
        onSelect={props.onSelect}
        searchIcon={props.searchIcon}
      />
    </Theme>
  );
}

function FilteringHarness<T>(props: {
  items: CommandItem<T>[];
  onSelect: (item: CommandItem<T>, mods: { shift: boolean; mod: boolean; alt: boolean }) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => props.items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())),
    [props.items, query]
  );
  return (
    <Theme>
      <CommandPalette<T>
        open
        onOpenChange={() => {}}
        query={query}
        onQueryChange={setQuery}
        items={filtered}
        onSelect={props.onSelect}
      />
    </Theme>
  );
}

const ITEMS: CommandItem<string>[] = [
  { id: "a", label: "Apple", section: "Fruit", value: "a" },
  { id: "b", label: "Banana", section: "Fruit", value: "b" },
  { id: "c", label: "Carrot", section: "Veg", value: "c" },
];

describe("CommandPalette (browser)", () => {
  it("renders sectioned items inside the opened dialog", async () => {
    render(<Harness items={ITEMS} onSelect={() => {}} />);
    expect(await screen.findByText("Apple")).toBeTruthy();
    expect(screen.getByText("Carrot")).toBeTruthy();
    expect(screen.getByText("Fruit")).toBeTruthy();
    expect(screen.getByText("Veg")).toBeTruthy();
  });

  it("Enter selects the active row and forwards keyboard modifiers", async () => {
    const onSelect = vi.fn();
    render(<Harness items={ITEMS} onSelect={onSelect} />);
    const input = await screen.findByRole("textbox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [item, mods] = onSelect.mock.calls[0]!;
    expect(item.id).toBe("b");
    expect(mods).toMatchObject({ mod: true });
  });

  it("resets the active row to the top filtered result when the query changes", async () => {
    const onSelect = vi.fn();
    render(
      <FilteringHarness
        items={[
          { id: "alpha", label: "Alpha" },
          { id: "bravo", label: "Bravo" },
          { id: "charlie", label: "Charlie" },
          { id: "apex", label: "Apex" },
          { id: "april", label: "April" },
        ]}
        onSelect={onSelect}
      />
    );
    const input = await screen.findByRole("textbox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });

    fireEvent.change(input, { target: { value: "ap" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0].id).toBe("apex");
  });

  it("clicking a row selects it via mousedown", async () => {
    const onSelect = vi.fn();
    render(<Harness items={ITEMS} onSelect={onSelect} />);
    fireEvent.mouseDown(await screen.findByText("Carrot"));
    expect(onSelect.mock.calls[0]![0].id).toBe("c");
  });

  it("renders labelNode/hintNode overrides and an active-aware trailing", async () => {
    const items: CommandItem<string>[] = [
      {
        id: "x",
        label: "plain",
        labelNode: <mark>highlighted</mark>,
        hint: "fallback hint",
        trailing: ({ active }) => <span>{active ? "ON" : "OFF"}</span>,
        value: "x",
      },
    ];
    render(<Harness items={items} onSelect={() => {}} />);
    expect(await screen.findByText("highlighted")).toBeTruthy();
    expect(screen.getByText("fallback hint")).toBeTruthy();
    expect(screen.getByText("ON")).toBeTruthy();
  });

  it("shows the empty message and a search icon", async () => {
    render(<Harness items={[]} onSelect={() => {}} searchIcon={<span data-testid="ic" />} />);
    expect(await screen.findByText("No matches")).toBeTruthy();
    expect(screen.getByTestId("ic")).toBeTruthy();
  });
});
