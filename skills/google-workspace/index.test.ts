import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredCredentialSummary } from "@workspace/runtime";

const runtimeMock = vi.hoisted(() => ({
  credentials: {
    connect: vi.fn(),
    configureClient: vi.fn(),
    getClientConfigStatus: vi.fn(),
    listStoredCredentials: vi.fn(),
    revokeCredential: vi.fn(),
    fetch: vi.fn(),
  },
}));

vi.mock("@workspace/runtime", () => runtimeMock);

import {
  configureGoogleOAuthClient,
  connectGoogle,
  getGoogleOnboardingStatus,
  verifyGoogleCredential,
} from "./index.js";

const googleCredential: StoredCredentialSummary = {
  id: "cred-google",
  label: "Google Workspace",
  accountIdentity: {
    email: "user@example.com",
    providerUserId: "user-1",
  },
  audience: [
    { url: "https://gmail.googleapis.com/", match: "origin" },
    { url: "https://www.googleapis.com/", match: "origin" },
  ],
  injection: {
    type: "header",
    name: "authorization",
    valueTemplate: "Bearer {token}",
  },
  scopes: [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
  ],
  lifecycle: { state: "active", canRefresh: true },
  metadata: {
    providerId: "google-workspace",
  },
};

describe("google-workspace skill facade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMock.credentials.listStoredCredentials.mockResolvedValue([]);
    runtimeMock.credentials.getClientConfigStatus.mockResolvedValue({
      configId: "google-workspace",
      configured: false,
      fields: {
        clientId: { configured: false, type: "text" },
        clientSecret: { configured: false, type: "secret" },
      },
    });
    runtimeMock.credentials.configureClient.mockResolvedValue({
      configId: "google-workspace",
      configured: true,
      fields: {
        clientId: { configured: true, type: "text" },
        clientSecret: { configured: true, type: "secret" },
      },
    });
    runtimeMock.credentials.connect.mockResolvedValue(googleCredential);
    runtimeMock.credentials.fetch.mockResolvedValue(
      new Response(JSON.stringify({ email: "user@example.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  });

  it("reports needs-setup when no client or Google credential exists", async () => {
    const status = await getGoogleOnboardingStatus();

    expect(status.stage).toBe("needs-setup");
    expect(status.configured).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.nextActions.join(" ")).toContain("GoogleWorkspaceSetup.tsx");
    expect(status.nextActions.join(" ")).toContain("inline_ui");
  });

  it("reports needs-setup when only a Google client id is configured", async () => {
    runtimeMock.credentials.getClientConfigStatus.mockResolvedValue({
      configId: "google-workspace",
      configured: false,
      fields: {
        clientId: { configured: true, type: "text" },
        clientSecret: { configured: false, type: "secret" },
      },
    });

    const status = await getGoogleOnboardingStatus();

    expect(status.stage).toBe("needs-setup");
    expect(status.configured).toBe(false);
    expect(status.readyToConnect).toBe(false);
  });

  it("reports ready-to-connect when Google client id and secret are configured", async () => {
    runtimeMock.credentials.getClientConfigStatus.mockResolvedValue({
      configId: "google-workspace",
      configured: true,
      fields: {
        clientId: { configured: true, type: "text" },
        clientSecret: { configured: true, type: "secret" },
      },
    });

    const status = await getGoogleOnboardingStatus();

    expect(status.stage).toBe("ready-to-connect");
    expect(status.configured).toBe(true);
    expect(status.readyToConnect).toBe(true);
  });

  it("reports connected when a stored Google credential exists", async () => {
    runtimeMock.credentials.listStoredCredentials.mockResolvedValue([googleCredential]);

    const status = await getGoogleOnboardingStatus();

    expect(status.stage).toBe("connected");
    expect(status.connected).toBe(true);
    expect(status.connectionId).toBe("cred-google");
    expect(status.email).toBe("user@example.com");
  });

  it("reports verified after a live Google userinfo check succeeds", async () => {
    runtimeMock.credentials.listStoredCredentials.mockResolvedValue([googleCredential]);

    const status = await getGoogleOnboardingStatus({ verify: true });

    expect(status.stage).toBe("verified");
    expect(status.verification).toMatchObject({
      valid: true,
      credentialId: "cred-google",
      email: "user@example.com",
    });
  });

  it("normalizes unavailable credential RPC failures into structured onboarding errors", async () => {
    runtimeMock.credentials.listStoredCredentials.mockImplementation(async () => {
      const rpc = undefined as unknown as { call(): unknown };
      return rpc.call();
    });

    const status = await getGoogleOnboardingStatus();

    expect(status.stage).toBe("error");
    expect(status.error).toContain("Vibestudio credential runtime is unavailable");
    expect(status.error).toContain("Original error");
  });

  it("requests Google client material through privileged client config UI", async () => {
    await configureGoogleOAuthClient();

    expect(runtimeMock.credentials.configureClient).toHaveBeenCalledWith(
      expect.objectContaining({
        configId: "google-workspace",
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        fields: expect.arrayContaining([
          expect.objectContaining({ name: "clientId", type: "text", required: true }),
          expect.objectContaining({ name: "clientSecret", type: "secret", required: true }),
        ]),
      })
    );
  });

  it("connectGoogle uses host-owned connection with Google scopes and URL-bound audiences", async () => {
    runtimeMock.credentials.getClientConfigStatus.mockResolvedValue({
      configId: "google-workspace",
      configured: true,
      fields: {
        clientId: { configured: true, type: "text" },
        clientSecret: { configured: true, type: "secret" },
      },
    });

    await connectGoogle();

    expect(runtimeMock.credentials.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: expect.objectContaining({
          type: "oauth2-auth-code-pkce",
          clientConfigId: "google-workspace",
          scopes: expect.arrayContaining([
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/documents",
            "https://www.googleapis.com/auth/spreadsheets",
          ]),
          accountValidation: {
            userinfo: expect.objectContaining({
              url: "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
              idField: "id",
              emailField: "email",
            }),
          },
          extraAuthorizeParams: {
            access_type: "offline",
            prompt: "consent",
          },
          persistRefreshToken: true,
        }),
        credential: expect.objectContaining({
          metadata: expect.objectContaining({
            providerId: "google-workspace",
            upstreamAccessMode: "google-workspace-broad",
            localBindingCatalog: "google-workspace:v1",
          }),
          audience: expect.arrayContaining([
            { url: "https://gmail.googleapis.com/gmail/v1/users/me/", match: "path-prefix" },
            { url: "https://www.googleapis.com/calendar/v3/", match: "path-prefix" },
            { url: "https://docs.googleapis.com/v1/", match: "path-prefix" },
          ]),
          bindings: expect.arrayContaining([
            expect.objectContaining({ id: "google-gmail", label: "Google Gmail" }),
            expect.objectContaining({ id: "google-calendar", label: "Google Calendar" }),
            expect.objectContaining({ id: "google-drive", label: "Google Drive" }),
            expect.objectContaining({ id: "google-people", label: "Google People" }),
          ]),
        }),
      })
    );
  });

  it("connectGoogle reuses an already verified Google credential instead of launching OAuth again", async () => {
    runtimeMock.credentials.listStoredCredentials.mockResolvedValue([googleCredential]);

    const result = await connectGoogle();

    expect(result).toMatchObject({
      success: true,
      credentialId: "cred-google",
      email: "user@example.com",
    });
    expect(runtimeMock.credentials.connect).not.toHaveBeenCalled();
  });

  it("warns when a stored Google credential cannot renew itself", async () => {
    runtimeMock.credentials.listStoredCredentials.mockResolvedValue([
      {
        ...googleCredential,
        lifecycle: { state: "active", canRefresh: false },
      },
    ]);

    const status = await getGoogleOnboardingStatus();

    expect(status.stage).toBe("connected");
    expect(status.warnings.join(" ")).toContain("has no stored refresh token");
  });

  it("returns structured verification failure when the credential proxy reports expiry", async () => {
    runtimeMock.credentials.fetch.mockRejectedValue(new Error("credential-expired"));

    const result = await verifyGoogleCredential("cred-google");

    expect(result).toMatchObject({
      valid: false,
      credentialId: "cred-google",
    });
    expect(result.error).toContain("Reconnect Google Workspace");
  });

  it("connectGoogle returns a setup error instead of starting connection without client config", async () => {
    const result = await connectGoogle();

    expect(result.success).toBe(false);
    expect(result.error).toContain("client material is not configured");
    expect(runtimeMock.credentials.connect).not.toHaveBeenCalled();
  });

  it("connectGoogle uses stored client config without exposing client secret to userland", async () => {
    runtimeMock.credentials.getClientConfigStatus.mockResolvedValue({
      configId: "google-workspace",
      configured: true,
      fields: {
        clientId: { configured: true, type: "text" },
        clientSecret: { configured: true, type: "secret" },
      },
    });

    const result = await connectGoogle();

    expect(result.success).toBe(true);
    expect(runtimeMock.credentials.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: expect.objectContaining({ clientConfigId: "google-workspace" }),
      })
    );
  });

  it("verifyGoogleCredential returns scopes from the stored credential", async () => {
    runtimeMock.credentials.listStoredCredentials.mockResolvedValue([googleCredential]);

    const result = await verifyGoogleCredential("cred-google");

    expect(result).toMatchObject({
      valid: true,
      credentialId: "cred-google",
      email: "user@example.com",
      scopes: googleCredential.scopes,
    });
  });
});
