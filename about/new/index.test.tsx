// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AboutPanelRoot from "./index";

const mocks = vi.hoisted(() => ({
  getHistory: vi.fn(),
  searchHistory: vi.fn(),
  getPageFavicon: vi.fn(),
  reopen: vi.fn(),
  sourceTree: vi.fn(),
  listServices: vi.fn(),
  sourceUsage: vi.fn(),
  roots: vi.fn(),
  children: vi.fn(),
  focus: vi.fn(),
  archive: vi.fn(),
  onFocus: vi.fn(),
}));

vi.mock("@workspace/runtime", () => ({
  browserData: {
    getHistory: mocks.getHistory,
    searchHistoryForAutocomplete: mocks.searchHistory,
    getPageFavicon: mocks.getPageFavicon,
  },
  buildPanelLink: (source: string) => `/${source}/`,
  panel: {
    onFocus: mocks.onFocus,
    onChildCreationError: () => () => {},
    reopen: mocks.reopen,
  },
  panelTree: {
    self: () => ({ archive: mocks.archive }),
    sourceUsage: mocks.sourceUsage,
    roots: mocks.roots,
    children: mocks.children,
  },
  workspace: { sourceTree: mocks.sourceTree },
  workers: { listServices: mocks.listServices },
}));

vi.mock("@workspace/react/responsive", () => ({
  useIsMobile: () => false,
  useViewportHeight: () => 800,
}));
vi.mock("../../packages/about-shared/ui", () => ({
  AboutThemeRoot: ({ children }: { children: ReactNode }) => <>{children}</>,
  AboutPage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  Section: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
}));

const historyRow = {
  id: 1,
  url: "https://example.com/docs",
  title: "Example Docs",
  visit_count: 12,
  typed_count: 3,
  first_visit: 1,
  last_visit: 100,
};

/** Rows render their destination as the title line, so match that node only. */
const findRow = (title: string) =>
  screen.findByText(title, { selector: ".launcher-title" });

let storageValues: Map<string, string>;
let panelFocusCallback: () => void;

describe("new panel launcher", () => {
  beforeEach(() => {
    storageValues = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storageValues.get(key) ?? null,
        setItem: (key: string, value: string) => storageValues.set(key, value),
      },
    });
    mocks.listServices
      .mockReset()
      .mockResolvedValue([{ name: "browser.data" }]);
    mocks.getHistory.mockReset().mockResolvedValue([historyRow]);
    mocks.searchHistory.mockReset().mockResolvedValue([historyRow]);
    mocks.getPageFavicon.mockReset().mockResolvedValue(null);
    mocks.reopen
      .mockReset()
      .mockResolvedValue({ id: "slot-1", title: "Example" });
    mocks.sourceUsage.mockReset().mockResolvedValue([]);
    mocks.roots
      .mockReset()
      .mockResolvedValue({ entries: [], nextCursor: null, revision: 1 });
    mocks.children
      .mockReset()
      .mockResolvedValue({ entries: [], nextCursor: null, revision: 1 });
    mocks.focus.mockReset().mockResolvedValue({ phase: "ready" });
    mocks.archive.mockReset().mockResolvedValue({ phase: "archived" });
    mocks.onFocus.mockReset().mockImplementation((callback: () => void) => {
      panelFocusCallback = callback;
      return () => {};
    });
    mocks.sourceTree.mockReset().mockResolvedValue({
      children: [
        {
          name: "panels",
          path: "panels",
          isUnit: false,
          children: [
            {
              name: "chat",
              path: "panels/chat",
              isUnit: true,
              children: [],
              launchable: { type: "app", title: "Chat" },
            },
            {
              name: "terminal",
              path: "panels/terminal",
              isUnit: true,
              children: [],
              launchable: { type: "app", title: "Terminal" },
            },
          ],
        },
        {
          name: "about",
          path: "about",
          isUnit: false,
          children: [
            {
              name: "about",
              path: "about/about",
              isUnit: true,
              children: [],
              launchable: { type: "app", title: "About Vibestudio" },
            },
          ],
        },
      ],
    });
  });

  it("offers local panels without querying personal services absent from this workspace", async () => {
    mocks.listServices.mockResolvedValue([]);
    render(<AboutPanelRoot />);
    await waitFor(() => expect(mocks.listServices).toHaveBeenCalled());
    await waitFor(() => expect(mocks.sourceTree).toHaveBeenCalled());
    expect(mocks.getHistory).not.toHaveBeenCalled();
    expect(mocks.searchHistory).not.toHaveBeenCalled();
    expect(mocks.getPageFavicon).not.toHaveBeenCalled();
    expect(screen.queryByText(/history unavailable/i)).toBeNull();
  });

  it("shows panel and usage-ranked browser history suggestions in one list", async () => {
    render(<AboutPanelRoot />);

    expect(await screen.findByText("Terminal")).toBeTruthy();
    expect(await screen.findByText("Example Docs")).toBeTruthy();
    expect(screen.getAllByRole("option").length).toBeGreaterThanOrEqual(3);
  });

  it("shows about pages after workspace panels and keeps them searchable", async () => {
    render(<AboutPanelRoot />);

    expect(await findRow("Terminal")).toBeTruthy();
    expect(await findRow("About Vibestudio")).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "about" },
    });
    expect(await findRow("About Vibestudio")).toBeTruthy();
  });

  it("treats an empty canonical history as a normal empty result", async () => {
    mocks.getHistory.mockResolvedValue([]);

    render(<AboutPanelRoot />);

    expect(await screen.findByText("Terminal")).toBeTruthy();
    await waitFor(() => expect(mocks.getHistory).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/History suggestions couldn/)).toBeNull();
  });

  it("quietly reconciles history after the workspace review resolves", async () => {
    mocks.getHistory.mockRejectedValueOnce(
      Object.assign(new Error("workspace review pending"), {
        code: "EREVIEWPENDING",
      }),
    );

    render(<AboutPanelRoot />);

    await waitFor(() => expect(mocks.getHistory).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/History suggestions couldn/)).toBeNull();
    act(() => panelFocusCallback());

    expect(await screen.findByText("Example Docs")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByText(/History suggestions couldn/)).toBeNull(),
    );
    expect(mocks.getHistory).toHaveBeenCalledTimes(2);
  });

  it("renders a warm catalog before any revalidation API completes", () => {
    storageValues.set(
      "vibestudio:new-panel-catalog",
      JSON.stringify({
        version: 2,
        groups: {
          panels: [{ path: "panels/terminal", title: "Terminal" }],
          about: [],
        },
      }),
    );
    mocks.sourceTree.mockReturnValue(new Promise(() => {}));
    mocks.sourceUsage.mockReturnValue(new Promise(() => {}));
    mocks.roots.mockReturnValue(new Promise(() => {}));

    render(<AboutPanelRoot />);

    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.getByRole("combobox").getAttribute("disabled")).toBeNull();
  });

  it("publishes a cold source catalog without waiting for open-panel traversal", async () => {
    mocks.roots.mockReturnValue(new Promise(() => {}));

    render(<AboutPanelRoot />);

    expect(await screen.findByText("Terminal")).toBeTruthy();
    await waitFor(() => expect(mocks.roots).toHaveBeenCalledTimes(1));
  });

  it("uses the tree revision to avoid repeating a deep traversal on focus", async () => {
    mocks.roots.mockResolvedValue({
      revision: 7,
      nextCursor: null,
      entries: [
        {
          node: { slotId: "parent", childCount: 1 },
          handle: { id: "parent", source: "panels/chat", kind: "workspace" },
        },
      ],
    });
    mocks.children.mockResolvedValue({
      revision: 7,
      nextCursor: null,
      entries: [],
    });
    render(<AboutPanelRoot />);
    await waitFor(() => expect(mocks.children).toHaveBeenCalledTimes(1));

    act(() => panelFocusCallback());
    await waitFor(() => expect(mocks.roots).toHaveBeenCalledTimes(2));
    expect(mocks.children).toHaveBeenCalledTimes(1);
    expect(mocks.sourceTree).toHaveBeenCalledTimes(1);
  });

  it("moves the active suggestion with arrows", async () => {
    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "docs" } });

    await findRow("Start a new Agentic Chat");
    await findRow("Example Docs");
    await waitFor(() =>
      expect(
        screen.getAllByRole("option")[0]?.getAttribute("aria-selected"),
      ).toBe("true"),
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() =>
      expect(
        screen.getAllByRole("option")[1]?.getAttribute("aria-selected"),
      ).toBe("true"),
    );
  });

  it("preserves a keyboard selection while asynchronous history reshuffles results", async () => {
    let resolveHistory!: (rows: (typeof historyRow)[]) => void;
    mocks.searchHistory.mockReturnValue(
      new Promise<(typeof historyRow)[]>((resolve) => {
        resolveHistory = resolve;
      }),
    );
    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "docs" } });
    const chat = await findRow("Start a new Agentic Chat");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    resolveHistory([historyRow]);
    await screen.findByText("Example Docs");
    await waitFor(() =>
      expect(
        chat.closest('[role="option"]')?.getAttribute("aria-selected"),
      ).toBe("true"),
    );
  });

  it("opens the selected address suggestion with Enter", async () => {
    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "example.com" } });

    await findRow("https://example.com/");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.reopen).toHaveBeenCalledWith({
      source: "https://example.com/",
    });
  });

  it("grows into an agent prompt composer and preserves Shift+Enter for newlines", async () => {
    mocks.searchHistory.mockResolvedValue([]);
    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox") as HTMLTextAreaElement;
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      value: 96,
    });

    fireEvent.input(input, {
      target: {
        value: "Please investigate this issue and explain the best next step",
      },
    });

    await findRow("Start a new Agentic Chat");
    await waitFor(() => expect(input.style.height).toBe("96px"));
    expect(input.tagName).toBe("TEXTAREA");
    expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(
      true,
    );
    expect(mocks.reopen).not.toHaveBeenCalled();
  });

  it("accepts the highlighted inline completion with Tab", async () => {
    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "@term" } });
    await screen.findByText("Terminal");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("@Terminal");
    expect(mocks.reopen).not.toHaveBeenCalled();
  });

  it("keeps opening a new panel as the primary action when an instance exists", async () => {
    mocks.roots.mockResolvedValue({
      revision: 1,
      nextCursor: null,
      entries: [
        {
          node: { slotId: "slot-terminal", childCount: 0 },
          handle: {
            id: "slot-terminal",
            title: "Terminal · API server",
            source: "panels/terminal",
            kind: "workspace",
            parentId: null,
            focus: mocks.focus,
          },
        },
      ],
    });
    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "terminal" } });
    const badge = await screen.findByText("1 open");
    const title = await findRow("Terminal");
    await waitFor(() =>
      expect(
        title.closest('[role="option"]')?.getAttribute("aria-selected"),
      ).toBe("true"),
    );

    const row = title.closest('[role="option"]');
    expect(row?.tagName).toBe("A");
    expect(row?.getAttribute("href")).toBe("/panels/terminal/");
    expect(screen.getByRole("button", { name: /Open new/u })).toBeTruthy();
    expect(badge.closest("button")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(screen.queryByText("Terminal · API server")).toBeNull();
    expect(await screen.findByText("Terminal · API server")).toBeTruthy();

    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(mocks.focus).not.toHaveBeenCalled();
    requestFrame.mockRestore();
  });

  it("does not unfold instances while the keyboard is moving through rows", async () => {
    mocks.roots.mockResolvedValue({
      revision: 1,
      nextCursor: null,
      entries: [
        {
          node: { slotId: "slot-terminal", childCount: 0 },
          handle: {
            id: "slot-terminal",
            title: "Long-running shell",
            source: "panels/terminal",
            kind: "workspace",
            parentId: null,
            focus: mocks.focus,
          },
        },
      ],
    });

    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "terminal" } });
    await screen.findByText("1 open");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.queryByText("Long-running shell")).toBeNull();
  });

  it("expands every open instance and retires New Panel after choosing one", async () => {
    const focusFirst = vi.fn().mockResolvedValue({ phase: "ready" });
    const focusSecond = vi.fn().mockResolvedValue({ phase: "ready" });
    mocks.roots.mockResolvedValue({
      revision: 1,
      nextCursor: null,
      entries: [
        {
          node: { slotId: "slot-chat-a", childCount: 0 },
          handle: {
            id: "slot-chat-a",
            title: "Release planning",
            source: "panels/chat",
            kind: "workspace",
            parentId: null,
            focus: focusFirst,
          },
        },
        {
          node: { slotId: "slot-chat-b", childCount: 0 },
          handle: {
            id: "slot-chat-b",
            title: "Bug triage",
            source: "panels/chat",
            kind: "workspace",
            parentId: "slot-project",
            focus: focusSecond,
          },
        },
      ],
    });

    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "chat" } });

    const disclosure = await screen.findByRole("button", {
      name: /Show 2 open Chat panels/u,
    });
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(await screen.findByText("Release planning")).toBeTruthy();
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    await waitFor(() =>
      expect(screen.queryByText("Release planning")).toBeNull(),
    );

    fireEvent.click(disclosure);
    expect(await screen.findByText("Release planning")).toBeTruthy();
    expect(screen.getByText("Top-level panel")).toBeTruthy();
    expect(screen.getByText("Nested panel")).toBeTruthy();

    fireEvent.click(screen.getByText("Bug triage").closest("button")!);
    await waitFor(() => expect(focusSecond).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.archive).toHaveBeenCalledTimes(1));
    expect(focusFirst).not.toHaveBeenCalled();
    expect(mocks.reopen).not.toHaveBeenCalled();
    expect(focusSecond.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.archive.mock.invocationCallOrder[0]!,
    );
  });

  it("renders panel destinations as addressable links", async () => {
    render(<AboutPanelRoot />);
    const row = (await findRow("Terminal")).closest('[role="option"]');
    expect(row?.tagName).toBe("A");
    expect(row?.getAttribute("href")).toBe("/panels/terminal/");
  });

  it("scopes results from the mode chips without losing the typed query", async () => {
    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "chat" } });
    await findRow("Chat");

    fireEvent.click(screen.getByRole("button", { name: /Go to/ }));
    await waitFor(() => expect(input.value).toBe("@chat"));
    // `@` is destinations of every kind — it must not drop the agent prompt's
    // neighbours the way the old history-only scope did, and it must not offer
    // the two things that are not destinations (a literal URL, a chat prompt).
    await waitFor(() =>
      expect(
        screen
          .queryAllByRole("group")
          .map((group) => group.textContent?.slice(0, 6)),
      ).toEqual(["Panels"]),
    );

    fireEvent.click(screen.getByRole("button", { name: /Go to/ }));
    await waitFor(() => expect(input.value).toBe("chat"));
  });

  it("routes the retired `>` prefix into the go-to scope and says so", async () => {
    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: ">example" } });

    // The deprecation notice is the whole point of keeping `>` parseable.
    await screen.findByText(/is now/);
    // `>` used to mean panels only; it now searches history too.
    await findRow("Example Docs");

    fireEvent.click(screen.getByRole("button", { name: "Use @" }));
    await waitFor(() => expect(input.value).toBe("@example"));
    expect(screen.queryByText(/is now/)).toBeNull();
  });
});
