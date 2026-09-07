// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { makeTestCatalogEntry } from "@workspace/model-catalog/testing";
import { ModelSetupStatus } from "./ModelSetupStatus";

vi.mock("@radix-ui/themes", async () => {
  const React = await import("react");
  const element =
    (tag: string) =>
    ({ children, loading: _loading, ...props }: Record<string, unknown>) =>
      React.createElement(tag, props, children as ReactNode);
  const Button = ({ children, loading: _loading, variant, ...props }: Record<string, unknown>) =>
    React.createElement(
      "button",
      { ...props, "data-variant": variant ?? "solid" },
      children as ReactNode
    );
  return {
    Badge: element("span"),
    Box: element("div"),
    Button,
    Callout: {
      Root: element("div"),
      Icon: element("span"),
      Text: element("div"),
    },
    Card: element("div"),
    Flex: element("div"),
    Heading: element("h3"),
    Progress: element("progress"),
    Spinner: element("span"),
    Text: element("span"),
  };
});

describe("ModelSetupStatus", () => {
  it("does not narrate deferred credential acquisition for a launchable remote model", () => {
    const model = makeTestCatalogEntry({
      ref: "openai-codex:gpt-5.6-sol",
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      availability: { state: "needs-setup", detail: "no-credential" },
    });

    render(
      <ModelSetupStatus model={model} providerLabel="GPT Codex" pending={false} />
    );
    expect(screen.queryByText(/connect gpt codex/i)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
