import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "@vitest/browser/context";
import {
  GOOGLE_GMAIL_SCOPES,
  GOOGLE_DRIVE_SCOPES,
} from "@workspace/google-workspace/providers";
import type { GoogleOnboardingStatus } from "@workspace-skills/google-workspace";
const mock = vi.hoisted(() => ({
  status: vi.fn(),
  connect: vi.fn(),
  configure: vi.fn(),
  openExternal: vi.fn(),
  link: vi.fn((source: string, _options: unknown) => `panel://${source}`),
}));
vi.mock("@workspace/react/theme", () => ({
  usePanelTheme: () => "light",
  usePanelThemeConfig: () => ({ accentColor: "blue", grayColor: "slate" }),
}));
vi.mock("@workspace/react/responsive", () => ({
  useIsMobile: () => window.innerWidth < 640,
}));
vi.mock("@workspace/runtime", () => ({
  buildPanelLink: mock.link,
  panel: { slotId: "welcome" },
  openExternal: mock.openExternal,
  openPanel: vi.fn(),
}));
vi.mock("@workspace-skills/google-workspace", () => ({
  getGoogleOnboardingStatus: mock.status,
  connectGoogle: mock.connect,
  configureGoogleOAuthClient: mock.configure,
}));
import Welcome from "./index";
const status = (
  stage: GoogleOnboardingStatus["stage"],
  scopes?: readonly string[],
  error?: string,
): GoogleOnboardingStatus => ({
  stage,
  configured: stage !== "needs-setup",
  readyToConnect: stage !== "needs-setup",
  connected: stage === "verified" || stage === "connected",
  credentialId: "google-test",
  credentials: [],
  nextActions: [],
  warnings: [],
  ...(scopes
    ? { verification: { valid: stage === "verified", scopes: [...scopes] } }
    : {}),
  ...(error ? { error } : {}),
});
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mock.status.mockResolvedValue(status("needs-setup"));
});
it.each([320, 390, 1280])(
  "explains first-use prerequisites and keeps Gmail gated at %i pixels",
  async (width) => {
    await page.viewport(width, 1000);
    render(<Welcome />);
    await waitFor(() =>
      expect(mock.status).toHaveBeenCalledWith({ verify: true }),
    );
    expect(screen.getByText(/your own Google Cloud project/)).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Connect Google",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("Open Gmail").getAttribute("href")).toBeNull();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width + 1);
    const firstStep = screen.getAllByRole("button", {
      name: "Open this step",
    })[0] as HTMLButtonElement;
    await waitFor(() => expect(firstStep.disabled).toBe(false));
    fireEvent.click(firstStep);
    await waitFor(() =>
      expect(mock.openExternal).toHaveBeenCalledWith(
        "https://console.cloud.google.com/projectcreate",
      ),
    );
    await page.screenshot({
      path: `/home/werg/vibestudio/.cache/template-review/template-ui-google-${width}.png`,
    });
  },
);
it("does not mistake verified Drive access for Gmail access", async () => {
  mock.status.mockResolvedValue(status("verified", GOOGLE_DRIVE_SCOPES));
  render(<Welcome />);
  await screen.findByText("More permissions needed");
  expect(screen.getByText("Open Gmail").getAttribute("href")).toBeNull();
  mock.connect.mockResolvedValue({ success: true });
  mock.status.mockResolvedValue(status("verified", GOOGLE_GMAIL_SCOPES));
  fireEvent.click(screen.getByRole("button", { name: "Connect Google" }));
  await waitFor(() =>
    expect(
      screen.getByRole("link", { name: "Open Gmail" }).getAttribute("href"),
    ).toBe("panel://panels/chat"),
  );
  expect(mock.connect).toHaveBeenCalledWith({
    scopes: [...GOOGLE_GMAIL_SCOPES],
  });
  expect(mock.link).toHaveBeenLastCalledWith("panels/chat", {
    stateArgs: {
      channelName: "google-mail-welcome",
      agentConfig: { approvalLevel: 2 },
      installedAgents: [
        {
          agentId: "GmailAgentWorker",
          handle: "gmail",
          key: "gmail-google-mail-welcome",
          source: "workers/gmail-agent",
          className: "GmailAgentWorker",
          config: {
            handle: "gmail",
            name: "Gmail",
            googleCredentialId: "google-test",
          },
        },
      ],
      actionBarFile: "packages/gmail/src/action-bar.tsx",
    },
  });
});
it("shows the original verification failure without unlocking Gmail", async () => {
  mock.status.mockResolvedValue(
    status("connected", GOOGLE_GMAIL_SCOPES, "Google token was revoked"),
  );
  render(<Welcome />);
  await screen.findByText("Google token was revoked");
  expect(screen.getByText("Open Gmail").getAttribute("href")).toBeNull();
});
