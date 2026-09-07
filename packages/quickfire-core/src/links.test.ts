import { describe, expect, it } from "vitest";
import { classifyQuickfireLink, isOpenableLink } from "./links";
import { parseInline } from "./markdown";

describe("link policy", () => {
  it("treats a workspace panel link as a panel, not as text", () => {
    expect(classifyQuickfireLink("panels/editor")).toEqual({
      kind: "panel-source",
      source: "panels/editor",
    });
    expect(classifyQuickfireLink("about/help")).toMatchObject({ kind: "panel-source" });
  });

  it("keeps web destinations for a browser panel", () => {
    expect(classifyQuickfireLink("https://example.com/a")).toEqual({
      kind: "browser-url",
      url: "https://example.com/a",
    });
  });

  it("hands only genuinely external schemes to the OS", () => {
    expect(classifyQuickfireLink("mailto:someone@example.com")).toMatchObject({
      kind: "external",
    });
  });

  it("refuses what it would not open, and never guesses", () => {
    // A refused scheme, a relative document path, and prose all resolve to
    // nothing — the address grammar would turn the last two into a web search,
    // which is right for a typed address and wrong for a written link.
    expect(classifyQuickfireLink("javascript:evil()")).toBeNull();
    expect(classifyQuickfireLink("./notes.md")).toBeNull();
    expect(classifyQuickfireLink("some words")).toBeNull();
    expect(isOpenableLink("")).toBe(false);
  });

  it("is the same policy the Markdown projection linkifies with", () => {
    expect(parseInline("[the editor](panels/editor)")).toEqual([
      {
        kind: "link",
        href: "panels/editor",
        children: [{ kind: "text", text: "the editor" }],
      },
    ]);
    // Words survive; the destination does not become a link.
    expect(parseInline("[do not run](javascript:evil)")).toEqual([
      { kind: "text", text: "do not run" },
    ]);
  });
});
