import type { CredentialClient, UrlCredentialHandle } from "@workspace/runtime/credentials";
import { bindingAudience, googleWorkspaceCredential } from "./providers.js";

export class GoogleApiError extends Error {
  status: number;

  statusText: string;

  body: string;

  constructor(service: string, status: number, statusText: string, body: string) {
    super(`${service} API ${status} ${statusText}: ${body}`);
    this.name = "GoogleApiError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

export function createGoogleWorkspaceCredentialHandle(
  credentials: CredentialClient,
  opts: { bindingId?: string; credentialId?: string } = {}
): () => Promise<UrlCredentialHandle> {
  let handlePromise: Promise<UrlCredentialHandle> | null = null;
  return () => {
    if (!handlePromise) {
      const descriptor = opts.bindingId
        ? bindingAudience(googleWorkspaceCredential, opts.bindingId, opts)
        : {
            ...googleWorkspaceCredential,
            label: googleWorkspaceCredential.displayName,
            ...(opts.credentialId ? { credentialId: opts.credentialId } : {}),
          };
      const p = credentials.forAudience({
        ...descriptor,
      });
      p.catch(() => {
        if (handlePromise === p) handlePromise = null;
      });
      handlePromise = p;
    }
    return handlePromise;
  };
}

export function createGoogleApiFetcher(opts: {
  baseUrl: string;
  serviceName: string;
  handle: () => Promise<UrlCredentialHandle>;
}): <T>(path: string, init?: RequestInit) => Promise<T> {
  return async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const auth = await opts.handle();
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const response = await auth.fetch(`${opts.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      throw new GoogleApiError(
        opts.serviceName,
        response.status,
        response.statusText,
        await response.text()
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };
}
