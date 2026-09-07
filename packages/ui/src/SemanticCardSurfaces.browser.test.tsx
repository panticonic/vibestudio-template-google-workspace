import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Card, Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "./foundation.css";

afterEach(cleanup);

function paintedCardColor(element: Element): string {
  return getComputedStyle(element, "::before").backgroundColor;
}

function paintedCardBorder(element: Element): string {
  return getComputedStyle(element, "::after").boxShadow;
}

describe("semantic card surfaces", () => {
  for (const appearance of ["light", "dark"] as const) {
    it(`paints every state above the default Card layer in ${appearance} mode`, () => {
      const tones = ["selected", "info", "success", "warning", "error"] as const;
      render(
        <Theme appearance={appearance}>
          <Card data-testid="default">Default</Card>
          {tones.map((tone) => (
            <Card key={tone} data-testid={tone} data-surface-tone={tone}>
              {tone}
            </Card>
          ))}
        </Theme>
      );

      const defaultColor = paintedCardColor(screen.getByTestId("default"));
      const defaultBorder = paintedCardBorder(screen.getByTestId("default"));
      const cards = tones.map((tone) => screen.getByTestId(tone));
      const stateColors = cards.map(paintedCardColor);
      const stateBorders = cards.map(paintedCardBorder);

      for (const color of stateColors) expect(color).not.toBe(defaultColor);
      for (const border of stateBorders) expect(border).not.toBe(defaultBorder);
      expect(new Set(stateColors)).toHaveLength(tones.length);
      expect(new Set(stateBorders)).toHaveLength(tones.length);
    });
  }
});
