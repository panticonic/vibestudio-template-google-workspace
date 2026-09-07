// @vitest-environment jsdom

import { Theme } from "@radix-ui/themes";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DocsOpenResult, DocsSearchResult, renderDocsToolResult } from "./DocsResult";

const entry = {
  id: "service:blobstore.getText",
  surface: "service",
  qualifiedName: "blobstore.getText",
  title: "blobstore.getText",
  description: "Full UTF-8 text of a blob, or null if absent.",
  access: { sensitivity: "read", callers: ["panel", "do"] },
  argsSchema: { type: "array", items: [{ type: "string", pattern: "^[0-9a-f]{64}$" }] },
  returnsSchema: { type: "string", nullable: true },
  examples: [{ args: ["e3b0c4"] }],
};

describe("DocsResult", () => {
  it("renders a catalog entry as a card with description + sensitivity", () => {
    render(
      <Theme>
        <DocsOpenResult entry={entry} />
      </Theme>
    );
    expect(screen.getByText("blobstore.getText")).toBeTruthy();
    expect(screen.getByText("Full UTF-8 text of a blob, or null if absent.")).toBeTruthy();
    expect(screen.getByText("read")).toBeTruthy();
  });

  it("renders search hits as a list with a count", () => {
    render(
      <Theme>
        <DocsSearchResult
          hits={[
            {
              id: "service:blobstore.putText",
              surface: "service",
              qualifiedName: "blobstore.putText",
              title: "blobstore.putText",
            },
          ]}
        />
      </Theme>
    );
    expect(screen.getByText("service:blobstore.putText")).toBeTruthy();
    expect(screen.getByText("1 result")).toBeTruthy();
  });

  it("dispatches by tool name + result shape, ignoring non-docs tools and bad shapes", () => {
    expect(renderDocsToolResult("docs_open", { details: entry })).not.toBeNull();
    expect(renderDocsToolResult("docs_search", { details: [entry] })).not.toBeNull();
    expect(renderDocsToolResult("eval", { details: entry })).toBeNull();
    expect(renderDocsToolResult("docs_open", { details: { foo: "bar" } })).toBeNull();
    expect(renderDocsToolResult("docs_open", "plain text")).toBeNull();
  });
});
