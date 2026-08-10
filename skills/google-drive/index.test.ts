import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredCredentialSummary } from "@workspace/runtime";

const runtimeMock = vi.hoisted(() => ({
  credentials: {
    listStoredCredentials: vi.fn(),
    fetch: vi.fn(),
    resolveCredential: vi.fn(),
  },
}));

const googleWorkspaceMock = vi.hoisted(() => ({
  getGoogleOnboardingStatus: vi.fn(),
}));

const driveClientMock = vi.hoisted(() => ({
  createDriveClient: vi.fn(),
}));

vi.mock("@workspace/runtime", () => runtimeMock);
vi.mock("@workspace-skills/google-workspace", () => googleWorkspaceMock);
vi.mock("@workspace/google-workspace", () => driveClientMock);

import {
  createGoogleDriveClient,
  formatGoogleDriveOnboardingStatus,
  getGoogleDriveOnboardingStatus,
  type GoogleDriveOnboardingStatus,
  verifyGoogleDriveAccess,
} from "./index.js";

const googleWorkspaceStatus: GoogleDriveOnboardingStatus["googleWorkspace"] = {
  stage: "verified",
  configured: true,
  readyToConnect: true,
  connected: true,
  credentialId: "cred-google",
  email: "user@example.com",
  credentials: [],
  nextActions: [],
  warnings: [],
};

const googleCredential: StoredCredentialSummary = {
  id: "cred-google",
  label: "Google Workspace",
  accountIdentity: {
    email: "user@example.com",
    providerUserId: "user-1",
  },
  audience: [{ url: "https://www.googleapis.com/", match: "origin" }],
  injection: {
    type: "header",
    name: "authorization",
    valueTemplate: "Bearer {token}",
  },
  scopes: ["https://www.googleapis.com/auth/drive"],
  lifecycle: { state: "active", canRefresh: true },
  metadata: {
    providerId: "google-workspace",
  },
};

describe("google-drive skill facade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMock.credentials.listStoredCredentials.mockResolvedValue([googleCredential]);
    runtimeMock.credentials.fetch.mockResolvedValue(
      new Response(JSON.stringify({ email: "user@example.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    runtimeMock.credentials.resolveCredential.mockResolvedValue(googleCredential);
    googleWorkspaceMock.getGoogleOnboardingStatus.mockResolvedValue(googleWorkspaceStatus);
    driveClientMock.createDriveClient.mockReturnValue({
      handle: vi.fn().mockResolvedValue({ credentialId: "cred-google", fetch: vi.fn() }),
      about: vi.fn().mockResolvedValue({ user: { emailAddress: "user@example.com" } }),
    });
  });

  it("reports needs-google-workspace until the upstream Google credential is verified", async () => {
    googleWorkspaceMock.getGoogleOnboardingStatus.mockResolvedValue({
      ...googleWorkspaceStatus,
      stage: "ready-to-connect",
      connected: false,
      readyToConnect: true,
    });

    const status = await getGoogleDriveOnboardingStatus();

    expect(status.stage).toBe("needs-google-workspace");
    expect(status.connected).toBe(false);
    expect(status.nextActions.join(" ")).toContain("Google Workspace onboarding");
  });

  it("reports ready when Google Workspace is verified", async () => {
    const status = await getGoogleDriveOnboardingStatus({ verify: true });

    expect(status.stage).toBe("ready");
    expect(status.connected).toBe(true);
    expect(status.verified).toBe(true);
    expect(status.credentialId).toBe("cred-google");
  });

  it("creates a Drive client from the runtime credentials", () => {
    createGoogleDriveClient({ credentialId: "cred-google" });

    expect(driveClientMock.createDriveClient).toHaveBeenCalledWith(runtimeMock.credentials, {
      credentialId: "cred-google",
    });
  });

  it("verifies Drive access with a live about call", async () => {
    const result = await verifyGoogleDriveAccess({ credentialId: "cred-google" });

    expect(result).toMatchObject({
      valid: true,
      credentialId: "cred-google",
      email: "user@example.com",
    });
    expect(result).not.toHaveProperty("rootFolderId");
  });

  it("reports an error status when live Drive verification fails", async () => {
    driveClientMock.createDriveClient.mockReturnValueOnce({
      handle: vi.fn().mockResolvedValue({ credentialId: "cred-google", fetch: vi.fn() }),
      about: vi
        .fn()
        .mockRejectedValue(
          new Error("Google Drive API 400 Bad Request: Invalid field selection rootFolderId")
        ),
    });

    const status = await getGoogleDriveOnboardingStatus({ verify: true });

    expect(status.stage).toBe("error");
    expect(status.connected).toBe(true);
    expect(status.verified).toBe(false);
    expect(status.credentialId).toBe("cred-google");
    expect(status.drive).toMatchObject({
      valid: false,
      error: "Google Drive API 400 Bad Request: Invalid field selection rootFolderId",
    });
    expect(status.error).toBe(
      "Google Drive API 400 Bad Request: Invalid field selection rootFolderId"
    );
    expect(status.warnings).toEqual([
      "Google Drive verification failed: Google Drive API 400 Bad Request: Invalid field selection rootFolderId",
    ]);
    expect(status.nextActions.join(" ")).toContain(
      "Fix the reported Google Workspace or Drive verification error"
    );
    expect(status.nextActions.join(" ")).not.toContain("start browsing or syncing files");
  });

  it("formats onboarding status compactly", () => {
    const status: GoogleDriveOnboardingStatus = {
      stage: "ready",
      connected: true,
      verified: true,
      credentialId: "cred-google",
      email: "user@example.com",
      drive: { valid: true },
      googleWorkspace: googleWorkspaceStatus,
      credentials: [googleCredential],
      nextActions: ["Use createGoogleDriveClient()"],
      warnings: [],
    };

    expect(formatGoogleDriveOnboardingStatus(status)).toContain("Google Drive stage: ready");
  });
});
