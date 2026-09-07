import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Card, Theme } from "@radix-ui/themes";
import { SurfaceFrame } from "../../tool-ui/src/components/SurfaceFrame";
import "@radix-ui/themes/styles.css";
import "../styles.css";

afterEach(cleanup);

function paintedCardColor(element: Element): string {
  return getComputedStyle(element, "::before").backgroundColor;
}

describe("chat surface hierarchy", () => {
  for (const appearance of ["light", "dark"] as const) {
    it(`keeps agent, player, and interactive surfaces distinct in ${appearance} mode`, () => {
      render(
        <Theme appearance={appearance}>
          <div
            className="agentic-chat-root"
            data-testid="transcript"
            style={{ display: "grid", gap: 12, padding: 20, width: 760 }}
          >
            <Card className="message-card" data-testid="agent-message">
              Agent
            </Card>
            <Card className="message-card message-card-client" data-testid="player-message">
              Player
            </Card>
            <SurfaceFrame title="Interactive UI" tone="blue">
              Tool content
            </SurfaceFrame>
          </div>
        </Theme>
      );

      const transcript = screen.getByTestId("transcript");
      const agent = screen.getByTestId("agent-message");
      const player = screen.getByTestId("player-message");
      const tool = transcript.querySelector('[data-part="tool-surface"]');
      expect(tool).not.toBeNull();

      const transcriptColor = getComputedStyle(transcript).backgroundColor;
      const agentColor = paintedCardColor(agent);
      const playerColor = paintedCardColor(player);
      const toolColor = paintedCardColor(tool!);

      expect(agentColor).not.toBe(transcriptColor);
      if (appearance === "light") {
        expect(playerColor).not.toBe(agentColor);
        expect(toolColor).not.toBe(agentColor);
        expect(toolColor).not.toBe(playerColor);
      } else {
        expect(playerColor).toBe(agentColor);
        expect(toolColor).toBe(agentColor);
        expect(getComputedStyle(tool!).borderTopColor).not.toBe(
          getComputedStyle(agent).borderTopColor
        );
      }
    });
  }
});
