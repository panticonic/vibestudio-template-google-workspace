// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Theme } from "@radix-ui/themes";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents, streamingMarkdownComponents } from "./markdownComponents";

// Mock mermaid so the jsdom suite tests the fence-detection pipeline without
// the real renderer (which needs a real browser — see the .browser.test.tsx).
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, code: string) => ({
      svg: `<svg data-testid="mock-diagram-svg" aria-label="${code.split("\n")[0]}"></svg>`,
    })),
  },
}));

const MERMAID_MESSAGE = [
  "Before text",
  "",
  "```mermaid",
  "flowchart TD",
  "  A --> B",
  "```",
  "",
  "```ts",
  "const x = 1;",
  "```",
].join("\n");

function renderMarkdown(components: typeof markdownComponents) {
  return render(
    <Theme>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {MERMAID_MESSAGE}
      </ReactMarkdown>
    </Theme>
  );
}

describe("mermaid fence rendering", () => {
  it("renders a mermaid fence as a diagram frame, not a code block", async () => {
    const { container } = renderMarkdown(markdownComponents);

    // Diagram frame appears (loading state first, then the mocked SVG)
    expect(container.querySelector(".ns-diagram-frame")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("mock-diagram-svg")).toBeTruthy();
    });

    // The mermaid source must not be wrapped in a <pre> code block
    const codeblocks = Array.from(container.querySelectorAll(".ns-codeblock"));
    expect(codeblocks.some((el) => el.textContent?.includes("flowchart TD"))).toBe(false);

    // The regular ts fence still renders as a normal code block
    expect(codeblocks.some((el) => el.textContent?.includes("const x = 1;"))).toBe(true);
  });

  it("keeps mermaid fences as plain code blocks in the streaming component set", () => {
    const { container } = renderMarkdown(streamingMarkdownComponents);

    expect(container.querySelector(".ns-diagram-frame")).toBeNull();
    const codeblocks = Array.from(container.querySelectorAll(".ns-codeblock"));
    expect(codeblocks.some((el) => el.textContent?.includes("flowchart TD"))).toBe(true);
  });
});
