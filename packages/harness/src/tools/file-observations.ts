import { canonicalizeWorkspaceFilePath } from "@vibestudio/shared/runtime/entitySpec";
import { toVcsPath } from "./tool-vcs.js";

export interface WorkspaceFileObservationPersistence {
  get(path: string): string | null;
  set(path: string, contentHash: string): void;
  delete(path: string): void;
}

/**
 * Trusted, channel-scoped file observations. Content hashes are an internal
 * compare-and-swap detail: model-facing tools deal only in paths and content.
 */
export interface WorkspaceFileObservationStore {
  get(path: string): string | null;
  record(path: string, contentHash: string): void;
  forget(path: string): void;
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;

export function createWorkspaceFileObservationStore(
  persistence: WorkspaceFileObservationPersistence
): WorkspaceFileObservationStore {
  return {
    get(path) {
      const value = persistence.get(path);
      return value && SHA256_HEX.test(value) ? value : null;
    },
    record(path, contentHash) {
      if (!SHA256_HEX.test(contentHash)) {
        throw new Error(`Invalid internal content hash for ${path}`);
      }
      persistence.set(path, contentHash);
    },
    forget(path) {
      persistence.delete(path);
    },
  };
}

export function createMemoryWorkspaceFileObservationStore(): WorkspaceFileObservationStore {
  const values = new Map<string, string>();
  return createWorkspaceFileObservationStore({
    get: (path) => values.get(path) ?? null,
    set: (path, contentHash) => values.set(path, contentHash),
    delete: (path) => values.delete(path),
  });
}

export function canonicalObservationPath(path: string, cwd: string): string {
  return canonicalizeWorkspaceFilePath(toVcsPath(path, cwd));
}
