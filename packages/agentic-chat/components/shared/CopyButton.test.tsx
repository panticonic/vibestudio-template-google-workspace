// @vitest-environment jsdom

import { Theme } from "@radix-ui/themes";
import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CopyButton } from "./CopyButton";

describe("CopyButton", () => {
  it("cancels its copied-state timer when it unmounts", async () => {
    const resetTimer = 1_200_001 as unknown as ReturnType<
      typeof window.setTimeout
    >;
    const realSetTimeout = window.setTimeout.bind(window);
    const captureResetTimer = ((handler: TimerHandler, timeout?: number) =>
      timeout === 1_200
        ? resetTimer
        : realSetTimeout(handler, timeout)) as typeof window.setTimeout;
    const setTimeout = vi
      .spyOn(window, "setTimeout")
      .mockImplementation(captureResetTimer);
    const realClearTimeout = window.clearTimeout.bind(window);
    const captureClear = ((
      timer?: Parameters<typeof window.clearTimeout>[0],
    ) => {
      if (timer !== resetTimer) realClearTimeout(timer);
    }) as typeof window.clearTimeout;
    const clearTimeout = vi
      .spyOn(window, "clearTimeout")
      .mockImplementation(captureClear);
    try {
      const { getByRole, unmount } = render(
        <Theme>
          <CopyButton value="details" label="Copy details" />
        </Theme>,
      );

      fireEvent.click(getByRole("button", { name: "Copy details" }));
      await act(async () => Promise.resolve());
      expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 1_200);

      unmount();

      expect(clearTimeout).toHaveBeenCalledWith(resetTimer);
    } finally {
      setTimeout.mockRestore();
      clearTimeout.mockRestore();
    }
  });
});
