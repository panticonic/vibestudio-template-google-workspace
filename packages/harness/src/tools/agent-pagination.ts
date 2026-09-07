import { Type } from "@sinclair/typebox";
import { canonicalJson, sha256HexSyncText } from "@vibestudio/content-addressing";

export const agentReferenceSchema = Type.String({
  pattern: "^@r[0-9a-z]+-[0-9a-f]{4}$",
  maxLength: 24,
  description:
    "Short exact reference advertised by a preceding tool result. Copy it unchanged; trusted code retains the underlying semantic identity and cursor.",
});

export interface AgentReferencePersistence {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface AgentReferenceStore {
  put(domain: string, value: unknown): string;
  get(domain: string, ref: string): unknown | null;
}

const AGENT_REFERENCE_CAPACITY = 256;

/**
 * Durable, channel-scoped references let a model carry a tiny checked token
 * while trusted code retains exact content-addressed identities and cursors.
 */
export function createAgentReferenceStore(
  persistence: AgentReferencePersistence
): AgentReferenceStore {
  return {
    put(domain, value) {
      const serialized = canonicalJson({ domain, value });
      const digest = sha256HexSyncText(serialized);
      const existing = persistence.get(`digest:${digest}`);
      if (existing && persistence.get(`entry:${existing}`) === serialized) return existing;

      const storedSequence = Number.parseInt(persistence.get("sequence") ?? "0", 10);
      const sequence =
        Number.isSafeInteger(storedSequence) && storedSequence >= 0 ? storedSequence + 1 : 1;
      const ref = `@r${sequence.toString(36)}-${digest.slice(0, 4)}`;
      persistence.set("sequence", String(sequence));
      persistence.set(`entry:${ref}`, serialized);
      persistence.set(`digest:${digest}`, ref);

      const expiredSequence = sequence - AGENT_REFERENCE_CAPACITY;
      if (expiredSequence > 0) {
        const expiredPrefix = `@r${expiredSequence.toString(36)}-`;
        const expired = persistence.get(`sequence-ref:${expiredSequence}`);
        if (expired?.startsWith(expiredPrefix)) {
          const expiredValue = persistence.get(`entry:${expired}`);
          if (expiredValue) {
            persistence.delete(`digest:${sha256HexSyncText(expiredValue)}`);
          }
          persistence.delete(`entry:${expired}`);
        }
        persistence.delete(`sequence-ref:${expiredSequence}`);
      }
      persistence.set(`sequence-ref:${sequence}`, ref);
      return ref;
    },
    get(domain, ref) {
      const serialized = persistence.get(`entry:${ref}`);
      if (!serialized) return null;
      try {
        const parsed = JSON.parse(serialized) as { domain?: unknown; value?: unknown };
        return parsed.domain === domain ? parsed.value : null;
      } catch {
        return null;
      }
    },
  };
}

export function createMemoryAgentReferenceStore(): AgentReferenceStore {
  const values = new Map<string, string>();
  return createAgentReferenceStore({
    get: (key) => values.get(key) ?? null,
    set: (key, value) => values.set(key, value),
    delete: (key) => values.delete(key),
  });
}

export class AgentReferenceUnavailableError extends Error {
  constructor(readonly ref: string) {
    super(`Agent reference ${ref} is unavailable`);
  }
}

export function loadAgentReference<T>(store: AgentReferenceStore, domain: string, ref: string): T {
  const value = store.get(domain, ref);
  if (value === null) throw new AgentReferenceUnavailableError(ref);
  return value as T;
}

export function isAgentReference(value: string): boolean {
  return /^@r[0-9a-z]+-[0-9a-f]{4}$/u.test(value);
}
