import type { CredentialClient } from "@vibestudio/credential-client";

/**
 * The slice of the extension runtime `ctx` the git-bridge actually uses,
 * declared once for the activation entry (`index.ts`) and the upstream engine
 * (`upstream.ts`). Structural on purpose: the runtime's real context is a
 * superset, and tests substitute in-memory fakes.
 */
export interface ExtensionContextLike {
  readonly name: string;
  workspace: {
    getInfo(): Promise<{ path: string; statePath: string; id: string; name: string }>;
  };
  workers: {
    resolveService(query: string, objectKey?: string | null): Promise<unknown>;
  };
  rpc: {
    call<T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T>;
    on?(eventName: string, cb: (event: { payload: unknown }) => void): () => void;
  };
  subscriptions?: Array<{ dispose(): void }>;
  storage: {
    readonly root: string;
    mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
    readFile(path: string, encoding?: BufferEncoding): Promise<string | Buffer>;
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
    rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  };
  credentials: CredentialClient;
  notifications: {
    show(input: {
      id?: string;
      type: "info" | "success" | "warning" | "error" | "consent";
      title: string;
      message?: string;
      ttl?: number;
      actions?: Array<{
        id?: string;
        label: string;
        variant?: "solid" | "soft" | "ghost";
        invoke?: { kind: "extension"; extension: string; method: string; args?: unknown[] };
      }>;
    }): Promise<string> | string;
  };
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn?(message: string, fields?: Record<string, unknown>): void;
  };
  health?: {
    report(
      state: "healthy" | "degraded" | "unhealthy",
      detail?: { summary: string; reasons?: string[] }
    ): void;
    healthy(detail?: { summary: string; reasons?: string[] }): void;
  };
}
