import type { CredentialClient } from "@vibestudio/credential-client";

export interface ExtensionContextLike {
  readonly name: string;
  storage: { readonly root: string };
  workspace: {
    getInfo(): Promise<{
      path: string;
      statePath: string;
      id: string;
      name: string;
      config?: unknown;
    }>;
  };
  rpc: {
    call<T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T>;
  };
  credentials: CredentialClient;
  emit(event: string, payload: unknown): void;
  extensions: {
    invoke<T = unknown>(extension: string, method: string, args?: unknown[]): Promise<T>;
  };
  invocation: {
    current(): {
      caller: {
        callerKind: string;
        callerId: string;
        callerTitle?: string;
        contextId?: string;
      };
      chainCaller?: { contextId?: string };
    } | null;
  };
  approvals: {
    request(input: {
      subject: { id: string; label: string };
      title: string;
      summary: string;
      warning?: string;
      details?: Array<{ label: string; value: string }>;
      severity?: "standard" | "dangerous";
      defaultAction?: "deny";
      promptOptions?: "scoped";
    }): Promise<
      | { kind: "uncallable"; reason: string }
      | { kind: "dismissed" }
      | { kind?: string; choice?: string }
    >;
  };
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn?(message: string, fields?: Record<string, unknown>): void;
  };
}
