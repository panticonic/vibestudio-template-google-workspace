import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Theme } from "@radix-ui/themes";
import { MermaidDiagram } from "@workspace/ui/diagram";
import { MessageContent } from "./MessageContent";

// Real-browser test (vitest.browser.config.ts): loads the actual mermaid
// renderer, which needs real SVG layout (getBBox etc.) that jsdom lacks.

afterEach(cleanup);

describe("MermaidDiagram (browser)", () => {
  it("renders a flowchart to themed SVG", async () => {
    const { container } = render(
      <Theme>
        <MermaidDiagram code={"flowchart TD\n  A[Start] --> B[Done]"} />
      </Theme>
    );

    await waitFor(
      () => {
        expect(container.querySelector(".ns-diagram svg")).toBeTruthy();
      },
      { timeout: 20000 }
    );
    expect(container.textContent).toContain("Start");
    expect(container.textContent).toContain("Done");
    expect(container.querySelector(".ns-diagram-error")).toBeNull();
  });

  it("falls back to source plus error note on invalid syntax", async () => {
    const badSource = "flowchart TD\n  A[Unclosed --> ???";
    const { container } = render(
      <Theme>
        <MermaidDiagram code={badSource} />
      </Theme>
    );

    await waitFor(
      () => {
        expect(screen.getByText("Diagram failed to render")).toBeTruthy();
      },
      { timeout: 20000 }
    );
    // The source stays visible so the user (or agent) can fix it
    expect(container.querySelector(".ns-diagram-source")?.textContent).toContain("flowchart TD");
    // No stray mermaid scratch elements leak into the document
    expect(document.querySelectorAll("[id^='dns-mermaid-']").length).toBe(0);
  });
});

describe("MessageContent diagram integration (browser)", () => {
  const message = "Here is the flow:\n\n```mermaid\nsequenceDiagram\n  Alice->>Bob: Hello\n```\n";

  it("renders the diagram once the message is complete", async () => {
    const { container } = render(
      <Theme>
        <MessageContent content={message} isStreaming={false} />
      </Theme>
    );
    await waitFor(
      () => {
        expect(container.querySelector(".ns-diagram svg")).toBeTruthy();
      },
      { timeout: 20000 }
    );
  });

  it("keeps the fence as a plain code block while streaming", () => {
    const { container } = render(
      <Theme>
        <MessageContent content={message} isStreaming />
      </Theme>
    );
    expect(container.querySelector(".ns-diagram-frame")).toBeNull();
    expect(container.querySelector(".ns-codeblock")?.textContent).toContain("sequenceDiagram");
  });
});
