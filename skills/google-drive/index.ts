import { credentials } from "@workspace/runtime";
import type { StoredCredentialSummary } from "@workspace/runtime";
import { createDriveClient, type DriveAbout, type DriveClient } from "@workspace/google-workspace";
import {
  getGoogleOnboardingStatus,
  type GoogleOnboardingStatus,
} from "@workspace-skills/google-workspace";

type RuntimeCredentials = typeof credentials;

export type GoogleDriveOnboardingStage = "needs-google-workspace" | "ready" | "error";

export interface GoogleDriveVerificationResult {
  valid: boolean;
  credentialId?: string;
  email?: string;
  about?: DriveAbout;
  error?: string;
}

export interface GoogleDriveOnboardingStatus {
  stage: GoogleDriveOnboardingStage;
  connected: boolean;
  verified: boolean;
  credentialId?: string;
  email?: string;
  drive?: GoogleDriveVerificationResult;
  googleWorkspace: GoogleOnboardingStatus;
  credentials: StoredCredentialSummary[];
  nextActions: string[];
  warnings: string[];
  error?: string;
}

export interface GoogleDriveOnboardingStatusOptions {
  verify?: boolean;
}

export interface GoogleDriveClientOptions {
  credentialId?: string;
}

function getCredentialRuntime(): RuntimeCredentials {
  const api = credentials as Partial<RuntimeCredentials> | undefined;
  if (!api) {
    throw new Error(
      "Vibestudio credential runtime is unavailable: @workspace/runtime did not export credentials."
    );
  }
  for (const method of ["listStoredCredentials", "fetch", "resolveCredential"] as const) {
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
      "Google Drive helpers must run in a Vibestudio panel/eval/worker runtime with credentials initialized. " +
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

function getNextActions(
  status: Pick<GoogleDriveOnboardingStatus, "stage" | "connected" | "verified">
): string[] {
  switch (status.stage) {
    case "needs-google-workspace":
      return ["Complete Google Workspace onboarding and verify the Google credential first."];
    case "ready":
      return [
        "Create a Drive client with createGoogleDriveClient() and start browsing or syncing files.",
      ];
    case "error":
      return [
        "Fix the reported Google Workspace or Drive verification error, then rerun getGoogleDriveOnboardingStatus().",
      ];
  }
}

function buildStatus(input: {
  googleWorkspace: GoogleOnboardingStatus;
  credentials: StoredCredentialSummary[];
  verification?: GoogleDriveVerificationResult;
  warnings?: string[];
}): GoogleDriveOnboardingStatus {
  const connected = input.googleWorkspace.stage === "verified";
  const verified = input.verification?.valid === true;
  const stage: GoogleDriveOnboardingStage =
    input.googleWorkspace.stage === "error"
      ? "error"
      : input.googleWorkspace.stage !== "verified"
        ? "needs-google-workspace"
        : input.verification && !input.verification.valid
          ? "error"
          : "ready";

  const status: GoogleDriveOnboardingStatus = {
    stage,
    connected,
    verified,
    credentialId: input.verification?.credentialId ?? input.googleWorkspace.credentialId,
    email: input.verification?.email ?? input.googleWorkspace.email,
    drive: input.verification,
    googleWorkspace: input.googleWorkspace,
    credentials: input.credentials,
    nextActions: [],
    warnings: input.warnings ?? [],
    error:
      input.verification && !input.verification.valid
        ? input.verification.error
        : input.googleWorkspace.error,
  };
  status.nextActions = getNextActions(status);
  return status;
}

export function createGoogleDriveClient(opts: GoogleDriveClientOptions = {}): DriveClient {
  return createDriveClient(getCredentialRuntime(), opts);
}

export async function verifyGoogleDriveAccess(
  opts: GoogleDriveClientOptions = {}
): Promise<GoogleDriveVerificationResult> {
  try {
    const client = createGoogleDriveClient(opts);
    const about = await client.about();
    const handle = await client.handle();
    return {
      valid: true,
      credentialId: handle.credentialId,
      email: about.user?.emailAddress,
      about,
    };
  } catch (error) {
    return {
      valid: false,
      error: normalizeCredentialRuntimeError(error).message,
    };
  }
}

export async function getGoogleDriveOnboardingStatus(
  opts: GoogleDriveOnboardingStatusOptions = {}
): Promise<GoogleDriveOnboardingStatus> {
  const warnings: string[] = [];
  try {
    const googleWorkspace = await getGoogleOnboardingStatus({
      verify: opts.verify ?? true,
    });
    const credentials = googleWorkspace.credentials;

    if (googleWorkspace.stage !== "verified") {
      return buildStatus({ googleWorkspace, credentials, warnings });
    }

    const verification = opts.verify
      ? await verifyGoogleDriveAccess({ credentialId: googleWorkspace.credentialId })
      : undefined;

    if (verification && !verification.valid && verification.error) {
      warnings.push(`Google Drive verification failed: ${verification.error}`);
    }

    return buildStatus({
      googleWorkspace,
      credentials,
      verification,
      warnings,
    });
  } catch (error) {
    const normalized = normalizeCredentialRuntimeError(error);
    return {
      stage: "error",
      connected: false,
      verified: false,
      credentials: [],
      googleWorkspace: {
        stage: "error",
        configured: false,
        readyToConnect: false,
        connected: false,
        credentials: [],
        nextActions: [],
        warnings,
        error: normalized.message,
      },
      nextActions: getNextActions({
        stage: "error",
        connected: false,
        verified: false,
      }),
      warnings,
      error: normalized.message,
    };
  }
}

export function formatGoogleDriveOnboardingStatus(status: GoogleDriveOnboardingStatus): string {
  const lines = [
    `Google Drive stage: ${status.stage}`,
    `connected=${status.connected}`,
    `verified=${status.verified}`,
  ];
  if (status.credentialId) lines.push(`credentialId=${status.credentialId}`);
  if (status.email) lines.push(`email=${status.email}`);
  if (status.drive) lines.push(`drive=${status.drive.valid ? "valid" : "invalid"}`);
  if (status.error) lines.push(`error=${status.error}`);
  if (status.warnings.length) lines.push(`warnings=${status.warnings.join("; ")}`);
  if (status.nextActions.length) lines.push(`nextActions=${status.nextActions.join(" | ")}`);
  return lines.join("\n");
}
