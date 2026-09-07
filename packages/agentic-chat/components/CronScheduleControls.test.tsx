// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import {
  CronScheduleDisplay,
  CronScheduleEditor,
} from "./CronScheduleControls.js";

describe("CronScheduleControls", () => {
  it("explains an advanced schedule while retaining its exact editable expression", () => {
    const onExpressionChange = vi.fn();
    render(
      <Theme>
        <CronScheduleEditor
          expression="*/15 9-17 * * MON-FRI"
          timezone="America/New_York"
          onExpressionChange={onExpressionChange}
          onTimezoneChange={vi.fn()}
        />
      </Theme>,
    );

    expect(
      (screen.getByLabelText("Cron expression") as HTMLInputElement).value,
    ).toBe("*/15 9-17 * * MON-FRI");
    expect(
      screen.getByText(
        /Every 15 minutes during hours 9 through 17 on Monday through Friday/,
      ),
    ).toBeTruthy();
    expect(screen.getByText("Next five runs")).toBeTruthy();
    expect(onExpressionChange).not.toHaveBeenCalled();
  });

  it("shows actionable validation while an advanced expression is incomplete", () => {
    render(
      <Theme>
        <CronScheduleEditor
          expression="not finished"
          timezone="America/New_York"
          onExpressionChange={vi.fn()}
          onTimezoneChange={vi.fn()}
        />
      </Theme>,
    );

    expect(screen.getByRole("alert").textContent).toMatch(/five-field/);
  });

  it("keeps raw syntax subordinate to the readable dashboard presentation", () => {
    render(
      <Theme>
        <CronScheduleDisplay
          expression="0 9 * * MON#2"
          timezone="Europe/Berlin"
          technical
        />
      </Theme>,
    );

    expect(screen.getByText(/second Monday.*9:00/)).toBeTruthy();
    const details = screen.getByText("0 9 * * MON#2").closest("details");
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText("Cron syntax"));
    expect(details?.open).toBe(true);
  });
});
