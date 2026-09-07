// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

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

function ThrowingChild(): React.ReactElement {
  throw new Error("render exploded");
}

describe("ErrorBoundary", () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & PanelErrorDiagnosticLauncherGlobal)
      .__vibestudioPanelErrorDiagnostics;
    vi.restoreAllMocks();
  });

  it("opens a diagnostic child chat from the render fallback", async () => {
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

    render(
      <ErrorBoundary surfaceName="test panel">
        <ThrowingChild />
      </ErrorBoundary>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Debug with Agent" }));

    await waitFor(() => expect(launcher).toHaveBeenCalledTimes(1));
    const request = launcher.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      surfaceName: "test panel",
      errorMessage: "render exploded",
    });
    expect(request?.componentStack).toContain("ThrowingChild");
    await screen.findByRole("button", { name: "Debug Chat Opened" });
  });
});
