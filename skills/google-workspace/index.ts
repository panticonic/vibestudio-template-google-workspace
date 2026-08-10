import { credentials } from "@workspace/runtime";
import type { StoredCredentialSummary } from "@workspace/runtime";
import {
  bearerTokenInjection,
  GOOGLE_WORKSPACE_BROAD_SCOPES,
  googleWorkspaceCredential,
} from "@workspace/google-workspace/providers";

const GOOGLE_PROVIDER_ID = "google-workspace";
const GOOGLE_OAUTH_CLIENT_CONFIG_ID = "google-workspace";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPES = [...GOOGLE_WORKSPACE_BROAD_SCOPES] as const;
const GOOGLE_AUDIENCE_ORIGINS = new Set(
  googleWorkspaceCredential.audiences.map((audience) => new URL(audience.url).origin)
);

type RuntimeCredentials = typeof credentials;

export type GoogleOnboardingStage =
  | "needs-setup"
  | "ready-to-connect"
  | "connected"
  | "verified"
  | "error";

export interface GoogleConnectionCheck {
  connected: boolean;
  connectionId?: string;
  credentialId?: string;
  email?: string;
  error?: string;
}

export interface GoogleConnectionResult {
  success: boolean;
  connectionId?: string;
  credentialId?: string;
  email?: string;
  error?: string;
}

export interface GoogleVerificationResult {
  valid: boolean;
  email?: string;
  scopes?: string[];
  credentialId?: string;
  error?: string;
}

export interface GoogleOnboardingStatus {
  stage: GoogleOnboardingStage;
  configured: boolean;
  readyToConnect: boolean;
  connected: boolean;
  connectionId?: string;
  credentialId?: string;
  email?: string;
  credentials: StoredCredentialSummary[];
  verification?: GoogleVerificationResult;
  nextActions: string[];
  warnings: string[];
  error?: string;
}

export interface GoogleOnboardingStatusOptions {
  verify?: boolean;
}

export interface ConnectGoogleOptions {
  scopes?: string[];
  force?: boolean;
}

function getDefaultScopes(scopes?: string[]): string[] {
  return scopes?.length ? scopes : [...GOOGLE_SCOPES];
}

function getCredentialRuntime(): RuntimeCredentials {
  const api = credentials as Partial<RuntimeCredentials> | undefined;
  if (!api) {
    throw new Error(
      "Vibestudio credential runtime is unavailable: @workspace/runtime did not export credentials."
    );
  }
  for (const method of [
    "connect",
    "configureClient",
    "getClientConfigStatus",
    "listStoredCredentials",
    "revokeCredential",
    "fetch",
  ] as const) {
    if (typeof api[method] !== "function") {
      throw new Error(
        `Vibestudio credential runtime is unavailable: credentials.${method} is missing.`
      );
    }
  }
  return api as RuntimeCredentials;
}

function normalizeCredentialRuntimeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const runtimeUnavailable =
    message.includes("undefined (reading 'call')") ||
    message.includes("Panel credentials have not been initialized") ||
    message.includes("Vibestudio transport bridge is not available") ||
    message.includes("__vibestudioTransport") ||
    message.includes("credential runtime is unavailable");
  if (!runtimeUnavailable) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(
    "Vibestudio credential runtime is unavailable in this context. " +
      "Google Workspace helpers must run in a Vibestudio panel/eval/worker runtime with credentials initialized. " +
      `Original error: ${message}`
  );
}

async function withCredentialRuntime<T>(fn: (api: RuntimeCredentials) => Promise<T>): Promise<T> {
  try {
    return await fn(getCredentialRuntime());
  } catch (error) {
    throw normalizeCredentialRuntimeError(error);
  }
}

function isGoogleCredential(credential: StoredCredentialSummary): boolean {
  if (credential.revokedAt) return false;
  if (credential.metadata?.["providerId"] === GOOGLE_PROVIDER_ID) return true;
  return credential.audience.some((audience) => {
    try {
      return GOOGLE_AUDIENCE_ORIGINS.has(new URL(audience.url).origin);
    } catch {
      return false;
    }
  });
}

function getPrimaryCredential(
  credentials: StoredCredentialSummary[]
): StoredCredentialSummary | undefined {
  return credentials.find((credential) => !credential.revokedAt);
}

function getCredentialEmail(credential: StoredCredentialSummary | undefined): string | undefined {
  return credential?.accountIdentity?.email;
}

function hasDurableRefreshToken(credential: StoredCredentialSummary | undefined): boolean {
  return credential?.lifecycle.canRefresh === true;
}

function explainGoogleCredentialError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("credential-expired")) {
    return (
      "credential-expired: the stored Google credential is expired and cannot be refreshed. " +
      "Reconnect Google Workspace so Vibestudio can store a durable offline refresh token."
    );
  }
  if (message.includes("client_not_authorized") || message.includes("oauth-refresh-failed")) {
    return (
      `${message}: Google rejected the stored refresh credential. ` +
      "Reconnect Google Workspace after confirming the OAuth app is published to Production."
    );
  }
  return message;
}

function getNextActions(
  status: Pick<GoogleOnboardingStatus, "stage" | "connected" | "configured">
): string[] {
  switch (status.stage) {
    case "needs-setup":
      return [
        "Render skills/google-workspace/GoogleWorkspaceSetup.tsx once with inline_ui.",
        "Use its Configure button to enter Desktop app details in the trusted approval UI.",
      ];
    case "ready-to-connect":
      return ["Use the setup component's Connect button."];
    case "connected":
      return ["Use the setup component's Verify button before declaring onboarding complete."];
    case "verified":
      return ["Continue onboarding with the verified Google Workspace credential."];
    case "error":
      return [
        "Fix the reported runtime or credential setup error, then rerun getGoogleOnboardingStatus().",
      ];
  }
}

function buildStatus(input: {
  configured: boolean;
  credentials: StoredCredentialSummary[];
  verification?: GoogleVerificationResult;
  warnings?: string[];
}): GoogleOnboardingStatus {
  const primary = getPrimaryCredential(input.credentials);
  const connected = !!primary;
  const verified = input.verification?.valid === true;
  const stage: GoogleOnboardingStage = verified
    ? "verified"
    : connected
      ? "connected"
      : input.configured
        ? "ready-to-connect"
        : "needs-setup";
  const status: GoogleOnboardingStatus = {
    stage,
    configured: input.configured,
    readyToConnect: input.configured && !connected,
    connected,
    connectionId: primary?.id,
    credentialId: primary?.id,
    email: input.verification?.email ?? getCredentialEmail(primary),
    credentials: input.credentials,
    verification: input.verification,
    nextActions: [],
    warnings: input.warnings ?? [],
  };
  if (primary && !hasDurableRefreshToken(primary)) {
    status.warnings.push(
      "This Google Workspace credential has no stored refresh token. " +
        "It may expire after restart or token expiry; reconnect Google Workspace with connectGoogle({ force: true })."
    );
  }
  status.nextActions = getNextActions(status);
  return status;
}

export async function configureGoogleOAuthClient() {
  return withCredentialRuntime((api) =>
    api.configureClient({
      configId: GOOGLE_OAUTH_CLIENT_CONFIG_ID,
      title: "Configure Google Workspace OAuth",
      description: "Save the Desktop app OAuth client material for Google Workspace.",
      authorizeUrl: GOOGLE_AUTH_URL,
      tokenUrl: GOOGLE_TOKEN_URL,
      fields: [
        {
          name: "clientId",
          label: "Client ID",
          type: "text",
          required: true,
          description: "Use installed.client_id from the downloaded Desktop app JSON.",
        },
        {
          name: "clientSecret",
          label: "Client secret",
          type: "secret",
          required: true,
          description: "Use installed.client_secret from the downloaded Desktop app JSON.",
        },
      ],
    })
  );
}

export async function getGoogleOAuthClientStatus() {
  return withCredentialRuntime((api) =>
    api.getClientConfigStatus({
      configId: GOOGLE_OAUTH_CLIENT_CONFIG_ID,
      fields: [
        { name: "clientId", label: "Client ID", type: "text", required: true },
        { name: "clientSecret", label: "Client secret", type: "secret", required: true },
      ],
    })
  );
}

export async function listGoogleCredentials(): Promise<StoredCredentialSummary[]> {
  return withCredentialRuntime(async (api) => {
    const all = await api.listStoredCredentials();
    return all.filter(isGoogleCredential);
  });
}

export async function revokeGoogleCredential(credentialId: string): Promise<void> {
  await withCredentialRuntime((api) => api.revokeCredential(credentialId));
}

export async function verifyGoogleCredential(
  credentialId: string
): Promise<GoogleVerificationResult> {
  try {
    return await withCredentialRuntime(async (api) => {
      const response = await api.fetch(
        "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
        undefined,
        { credentialId }
      );
      if (!response.ok) {
        return { valid: false, credentialId, error: `${response.status} ${response.statusText}` };
      }
      const body = (await response.json()) as { email?: string };
      const credential = (await listGoogleCredentials()).find(
        (candidate) => candidate.id === credentialId
      );
      return {
        valid: true,
        credentialId,
        email: body.email ?? getCredentialEmail(credential),
        scopes: credential?.scopes,
      };
    });
  } catch (error) {
    return {
      valid: false,
      credentialId,
      error: explainGoogleCredentialError(normalizeCredentialRuntimeError(error)),
    };
  }
}

export async function verifyGoogleConnection(
  connectionId: string
): Promise<GoogleVerificationResult> {
  return verifyGoogleCredential(connectionId);
}

export async function checkGoogleConnection(): Promise<GoogleConnectionCheck> {
  const status = await getGoogleOnboardingStatus();
  return {
    connected: status.connected,
    connectionId: status.connectionId,
    credentialId: status.credentialId,
    email: status.email,
    error: status.error,
  };
}

export async function getGoogleOnboardingStatus(
  opts: GoogleOnboardingStatusOptions = {}
): Promise<GoogleOnboardingStatus> {
  const warnings: string[] = [];
  try {
    let configured = false;
    try {
      configured = (await getGoogleOAuthClientStatus()).configured;
    } catch (error) {
      warnings.push(
        `Could not read Google client config: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const googleCredentials = await listGoogleCredentials();
    const primary = getPrimaryCredential(googleCredentials);
    const verification =
      opts.verify && primary ? await verifyGoogleCredential(primary.id) : undefined;

    if (verification && !verification.valid && verification.error) {
      warnings.push(`Google Workspace verification failed: ${verification.error}`);
    }

    return buildStatus({
      configured,
      credentials: googleCredentials,
      verification,
      warnings,
    });
  } catch (error) {
    const normalized = normalizeCredentialRuntimeError(error);
    const status: GoogleOnboardingStatus = {
      stage: "error",
      configured: false,
      readyToConnect: false,
      connected: false,
      credentials: [],
      nextActions: [],
      warnings,
      error: normalized.message,
    };
    status.nextActions = getNextActions(status);
    return status;
  }
}

export async function connectGoogle(
  opts: ConnectGoogleOptions = {}
): Promise<GoogleConnectionResult> {
  try {
    if (!opts.force) {
      const existing = await getGoogleOnboardingStatus({ verify: true });
      if (existing.stage === "verified" && existing.credentialId) {
        return {
          success: true,
          connectionId: existing.credentialId,
          credentialId: existing.credentialId,
          email: existing.email,
        };
      }
      if (existing.connected && existing.credentialId) {
        return {
          success: false,
          connectionId: existing.credentialId,
          credentialId: existing.credentialId,
          email: existing.email,
          error:
            existing.verification?.error ??
            "An existing Google Workspace credential is stored but could not be verified. Revoke it or call connectGoogle({ force: true }) to replace it.",
        };
      }
    }

    if (!(await getGoogleOAuthClientStatus()).configured) {
      return {
        success: false,
        error:
          "Google Workspace OAuth client material is not configured. " +
          "Run configureGoogleOAuthClient() before calling connectGoogle().",
      };
    }

    const scopes = getDefaultScopes(opts.scopes);
    const stored = await withCredentialRuntime((api) =>
      api.connect({
        flow: {
          type: "oauth2-auth-code-pkce",
          clientConfigId: GOOGLE_OAUTH_CLIENT_CONFIG_ID,
          scopes,
          persistRefreshToken: true,
          accountValidation: {
            userinfo: {
              url: "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
              idField: "id",
              emailField: "email",
              usernameField: "email",
            },
          },
          extraAuthorizeParams: {
            access_type: "offline",
            prompt: "consent",
          },
        },
        credential: {
          label: "Google Workspace",
          audience: googleWorkspaceCredential.audiences,
          injection: bearerTokenInjection,
          bindings: googleWorkspaceCredential.bindings,
          scopes,
          metadata: {
            providerId: GOOGLE_PROVIDER_ID,
            upstreamAccessMode: "google-workspace-broad",
            localBindingCatalog: "google-workspace:v1",
          },
        },
      })
    );
    const verification = await verifyGoogleCredential(stored.id);
    return {
      success: verification.valid,
      connectionId: stored.id,
      credentialId: stored.id,
      email: verification.email ?? getCredentialEmail(stored),
      error: verification.valid ? undefined : verification.error,
    };
  } catch (error) {
    const normalized = normalizeCredentialRuntimeError(error);
    return { success: false, error: normalized.message };
  }
}

export function formatGoogleOnboardingStatus(status: GoogleOnboardingStatus): string {
  const lines = [
    `Google Workspace stage: ${status.stage}`,
    `configured=${status.configured}`,
    `readyToConnect=${status.readyToConnect}`,
    `connected=${status.connected}`,
  ];
  if (status.connectionId) lines.push(`connectionId=${status.connectionId}`);
  if (status.email) lines.push(`email=${status.email}`);
  if (status.verification)
    lines.push(`verification=${status.verification.valid ? "valid" : "invalid"}`);
  if (status.error) lines.push(`error=${status.error}`);
  if (status.warnings.length) lines.push(`warnings=${status.warnings.join("; ")}`);
  if (status.nextActions.length) lines.push(`nextActions=${status.nextActions.join(" | ")}`);
  return lines.join("\n");
}
