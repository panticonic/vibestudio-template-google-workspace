// @vitest-environment jsdom

import React from "react";
import { createRoot } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  getTheme: vi.fn(() => "dark" as const),
  onThemeChange: vi.fn(() => vi.fn()),
  onConnectionError: vi.fn(() => vi.fn()),
}));

vi.mock("@workspace/runtime", () => runtime);

import { createReactPanelMount } from "../reactPanel";

interface PanelRenderErrorDiagnosticRequest {
  surfaceName?: string;
  errorMessage: string;
  componentStack?: string;
}

interface PanelErrorDiagnosticLauncherGlobal {
  __vibestudioPanelErrorDiagnostics?: (
    request: PanelRenderErrorDiagnosticRequest
  ) => Promise<{ panelId: string; title: string; prompt: string }>;
}

function ThrowingPanel(): React.ReactElement {
  throw new Error("auto mount failed");
}

describe("createReactPanelMount render error boundary", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
  });

  afterEach(() => {
    delete (globalThis as typeof globalThis & PanelErrorDiagnosticLauncherGlobal)
      .__vibestudioPanelErrorDiagnostics;
    vi.restoreAllMocks();
  });

  it("wraps auto-mounted React panels with diagnostic child-chat recovery", async () => {
    const launcher = vi.fn<
      NonNullable<PanelErrorDiagnosticLauncherGlobal["__vibestudioPanelErrorDiagnostics"]>
    >(async () => ({
      panelId: "debug-chat",
      title: "Agentic Chat",
      prompt: "debug",
    }));
    (globalThis as typeof globalThis & PanelErrorDiagnosticLauncherGlobal)
      .__vibestudioPanelErrorDiagnostics = launcher;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const mount = createReactPanelMount(React, createRoot);
    mount(ThrowingPanel);

    fireEvent.click(await screen.findByRole("button", { name: "Debug with Agent" }));

    await waitFor(() => expect(launcher).toHaveBeenCalledTimes(1));
    const request = launcher.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      surfaceName: "panel",
      errorMessage: "auto mount failed",
    });
    expect(request?.componentStack).toContain("ThrowingPanel");
  });
});
