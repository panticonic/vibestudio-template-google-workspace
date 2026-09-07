import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button, Grid, Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../styles.css";

afterEach(cleanup);

function NarrowInlineUi({ children }: { children: React.ReactNode }) {
  return (
    <Theme>
      <div className="agentic-chat-root" style={{ width: 320 }}>
        <div className="message-row message-row-agent message-row-inline-ui">
          <div className="inline-ui-frame">
            <div className="inline-ui-content" data-testid="inline-ui-content">
              {children}
            </div>
          </div>
        </div>
      </div>
    </Theme>
  );
}

describe("inline UI container responsiveness", () => {
  it("collapses viewport-responsive Radix grids to the panel width", () => {
    render(
      <NarrowInlineUi>
        <Grid
          columns={{ initial: "1", sm: "2" }}
          gap="2"
          data-testid="responsive-grid"
        >
          <Button>First choice with a long label</Button>
          <Button>Second choice with a long label</Button>
        </Grid>
      </NarrowInlineUi>,
    );

    const content = screen.getByTestId("inline-ui-content");
    const grid = screen.getByTestId("responsive-grid");
    const [first, second] = Array.from(grid.children).map((child) =>
      child.getBoundingClientRect(),
    );

    expect(second?.top).toBeGreaterThan(first?.top ?? 0);
    expect(second?.left).toBe(first?.left);
    expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth + 1);
  });
});
