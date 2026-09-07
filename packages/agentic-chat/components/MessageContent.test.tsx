// @vitest-environment jsdom

import { Theme } from "@radix-ui/themes";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MessageContent } from "./MessageContent";

afterEach(cleanup);

describe("MessageContent rich-renderer selection", () => {
  it("renders finalized GFM autolink literals as links", async () => {
    const { container } = render(
      <Theme>
        <MessageContent content="See https://example.com/docs for details." isStreaming={false} />
      </Theme>
    );

    await waitFor(
      () => {
        expect(container.querySelector('a[href="https://example.com/docs"]')).toBeTruthy();
      },
      { timeout: 5_000 }
    );
  });

  it("keeps ordinary streaming text, including an unfinished URL, on the synchronous path", () => {
    const { container } = render(
      <Theme>
        <MessageContent content="Loading https://example.com/part" isStreaming />
      </Theme>
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("https://example.com/part");
  });
});
