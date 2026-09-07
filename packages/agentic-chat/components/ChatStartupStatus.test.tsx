// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatStartupStatus } from "./ChatStartupStatus";

describe("ChatStartupStatus", () => {
  it.each([
    ["conversation", "Loading your conversation", "Conversation"],
    ["models", "Preparing model choices", "Model"],
    ["agent", "Preparing your agent", "Agent"],
  ] as const)("presents the %s phase in the shared startup progression", (phase, title, step) => {
    render(<ChatStartupStatus phase={phase} />);

    expect(screen.getByRole("status").textContent).toContain(title);
    expect(screen.getByRole("status").textContent).toContain(step);
  });

  it("uses the concrete workspace review message", () => {
    render(<ChatStartupStatus phase="review" detail="Review the imported workspace" />);

    expect(screen.getByRole("status").textContent).toContain("Waiting for workspace review");
    expect(screen.getByRole("status").textContent).toContain("Review the imported workspace");
  });
});
