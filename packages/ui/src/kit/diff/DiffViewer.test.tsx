// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import { DiffViewer, type DiffViewerProps } from "./DiffViewer";
import type { DiffContentFetcher, DiffReviewEntry } from "./types";

function renderViewer(
  entry: DiffReviewEntry,
  fetchContent: DiffContentFetcher,
  extra?: Partial<DiffViewerProps>
) {
  return render(
    <Theme>
      <DiffViewer entry={entry} fetchContent={fetchContent} {...extra} />
    </Theme>
  );
}

const CHANGED_ENTRY: DiffReviewEntry = {
  repoPath: "packages/demo",
  oldState: "state:aaa",
  newState: "state:bbb",
  diffStat: { filesChanged: 1, insertions: 1, deletions: 1 },
  changedFiles: [
    { path: "src/util.txt", kind: "changed", oldHash: "old-hash", newHash: "new-hash" },
  ],
};

describe("DiffViewer", () => {
  it("renders a unified diff from the two fetched blobs on expand", async () => {
    const fetchContent = vi.fn<DiffContentFetcher>(async (hash) =>
      hash === "old-hash" ? "a\nb\nc\n" : "a\nB\nc\n"
    );
    renderViewer(CHANGED_ENTRY, fetchContent);

    // Nothing fetched until the reviewer expands the file.
    expect(fetchContent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /src\/util\.txt/ }));

    const body = await screen.findByText("B");
    const row = body.closest("tr");
    expect(row?.getAttribute("data-diff-row")).toBe("added");
    // The removed original line is present too.
    expect(screen.getByText("b").closest("tr")?.getAttribute("data-diff-row")).toBe("removed");
  });

  it("fetches ONLY the hashes present in the payload", async () => {
    const fetchContent = vi.fn<DiffContentFetcher>(async () => "x\n");
    renderViewer(CHANGED_ENTRY, fetchContent);
    fireEvent.click(screen.getByRole("button", { name: /src\/util\.txt/ }));

    await waitFor(() => expect(fetchContent).toHaveBeenCalled());
    const requested = fetchContent.mock.calls.map((c) => c[0]).sort();
    expect(requested).toEqual(["new-hash", "old-hash"]);
  });

  it("falls back to plain text when no grammar matches the extension", async () => {
    // `.txt` has no shiki grammar → highlight returns null → plain text, but the
    // diff still renders fully.
    const fetchContent = vi.fn<DiffContentFetcher>(async (hash) =>
      hash === "old-hash" ? "one\n" : "two\n"
    );
    renderViewer(CHANGED_ENTRY, fetchContent);
    fireEvent.click(screen.getByRole("button", { name: /src\/util\.txt/ }));

    expect(await screen.findByText("two")).toBeTruthy();
    // No syntax-color spans were layered for a plain-text file.
    const addedRow = screen.getByText("two").closest("tr");
    expect(within(addedRow as HTMLElement).queryByText("two")?.tagName).toBe("TD");
  });

  it("degrades binary and oversized files to diffstat-only with an escape hatch", async () => {
    const onOpenInWorkspaceHistory = vi.fn();
    const fetchContent = vi.fn<DiffContentFetcher>(async () => "");
    const entry: DiffReviewEntry = {
      repoPath: "packages/demo",
      oldState: "state:a",
      newState: "state:b",
      diffStat: { filesChanged: 2, insertions: 0, deletions: 0 },
      changedFiles: [
        { path: "logo.png", kind: "changed", oldHash: "o", newHash: "n", binary: true },
        { path: "huge.log", kind: "added", newHash: "big", tooLarge: true },
      ],
    };
    renderViewer(entry, fetchContent, { onOpenInWorkspaceHistory });

    // Degraded rows never fetch content.
    expect(fetchContent).not.toHaveBeenCalled();
    expect(screen.getByText(/Binary file/)).toBeTruthy();
    expect(screen.getByText(/too large/i)).toBeTruthy();

    // The header buttons for degraded files are disabled (cannot expand).
    const pngHeader = screen.getByRole("button", { name: /logo\.png/ });
    expect((pngHeader as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getAllByRole("button", { name: /Open in Workspace History/ })[0]!);
    expect(onOpenInWorkspaceHistory).toHaveBeenCalledTimes(1);
    expect(onOpenInWorkspaceHistory.mock.calls[0]?.[0].path).toBe("logo.png");
  });

  it("offers a quiet secondary escape hatch on normal file headers", () => {
    const onOpenInWorkspaceHistory = vi.fn();
    const fetchContent = vi.fn<DiffContentFetcher>(async () => "x\n");
    renderViewer(CHANGED_ENTRY, fetchContent, { onOpenInWorkspaceHistory });

    // The secondary action is present without expanding, and fetches nothing.
    const openButton = screen.getByRole("button", {
      name: /Open src\/util\.txt in Workspace History/,
    });
    fireEvent.click(openButton);
    expect(fetchContent).not.toHaveBeenCalled();
    expect(onOpenInWorkspaceHistory).toHaveBeenCalledTimes(1);
    expect(onOpenInWorkspaceHistory.mock.calls[0]?.[0].path).toBe("src/util.txt");
    expect(onOpenInWorkspaceHistory.mock.calls[0]?.[1].repoPath).toBe("packages/demo");
  });

  it("omits the secondary escape hatch when no handler is supplied", () => {
    const fetchContent = vi.fn<DiffContentFetcher>(async () => "x\n");
    renderViewer(CHANGED_ENTRY, fetchContent);
    expect(screen.queryByRole("button", { name: /in Workspace History/ })).toBeNull();
  });

  it("keeps rendering (never throws) while a fetch is still pending", async () => {
    const resolvers: ((v: string) => void)[] = [];
    const fetchContent = vi.fn<DiffContentFetcher>(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );
    renderViewer(CHANGED_ENTRY, fetchContent);
    fireEvent.click(screen.getByRole("button", { name: /src\/util\.txt/ }));

    // Loading state shows; the surface is interactive (host decision controls,
    // rendered outside this component, are unaffected).
    expect(await screen.findByText(/Loading diff/)).toBeTruthy();

    // Resolve both payload-hash fetches (a "changed" file fetches old + new).
    await act(async () => {
      for (const resolve of resolvers) resolve("done\n");
      await Promise.resolve();
    });
    expect(await screen.findByText("done")).toBeTruthy();
  });

  it("pre-expands the files named in initialExpanded (deep-link into a diff)", async () => {
    const fetchContent = vi.fn<DiffContentFetcher>(async (hash) =>
      hash === "old-hash" ? "a\nb\nc\n" : "a\nB\nc\n"
    );
    renderViewer(CHANGED_ENTRY, fetchContent, { initialExpanded: ["src/util.txt"] });

    // Expanded on first render → the diff fetches without any click.
    await waitFor(() => {
      const requested = fetchContent.mock.calls.map((c) => c[0]).sort();
      expect(requested).toEqual(["new-hash", "old-hash"]);
    });
    expect(await screen.findByText("B")).toBeTruthy();
  });

  it("ignores initialExpanded for degraded (unexpandable) files", () => {
    const fetchContent = vi.fn<DiffContentFetcher>(async () => "");
    const entry: DiffReviewEntry = {
      repoPath: "packages/demo",
      oldState: "state:a",
      newState: "state:b",
      diffStat: { filesChanged: 1, insertions: 0, deletions: 0 },
      changedFiles: [
        { path: "logo.png", kind: "changed", oldHash: "o", newHash: "n", binary: true },
      ],
    };
    renderViewer(entry, fetchContent, { initialExpanded: ["logo.png"] });
    // A binary file can't expand, so no content is fetched.
    expect(fetchContent).not.toHaveBeenCalled();
    expect(screen.getByText(/Binary file/)).toBeTruthy();
  });

  it("expand-all opens every inline file at once", async () => {
    const fetchContent = vi.fn<DiffContentFetcher>(async () => "line\n");
    const entry: DiffReviewEntry = {
      repoPath: "packages/demo",
      oldState: "state:a",
      newState: "state:b",
      diffStat: { filesChanged: 2, insertions: 2, deletions: 0 },
      changedFiles: [
        { path: "a.txt", kind: "added", newHash: "ha" },
        { path: "b.txt", kind: "added", newHash: "hb" },
      ],
    };
    renderViewer(entry, fetchContent);
    fireEvent.click(screen.getByRole("button", { name: /Expand all/ }));
    await waitFor(() => {
      expect(fetchContent).toHaveBeenCalledWith("ha");
      expect(fetchContent).toHaveBeenCalledWith("hb");
    });
  });
});
