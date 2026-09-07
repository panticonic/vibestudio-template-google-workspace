import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PubSubClient } from "@workspace/pubsub";
import {
  compileMessageTypeModule,
  type ChatMessage,
  type MessageTypeDefinition,
} from "@workspace/agentic-core";
import type { LoadSourceFile, SandboxOptions } from "@workspace/eval";
import type { MessageTypeComponentEntry, MessageTypeLoadingStage } from "../../types";

interface UseMessageTypeRegistryOptions {
  client: PubSubClient | null;
  messages: ChatMessage[];
  definitions: MessageTypeDefinition[];
  loadSourceFile?: LoadSourceFile;
  loadImport?: SandboxOptions["loadImport"];
}

export interface MessageTypeRegistryState {
  messageTypeComponents: Map<string, MessageTypeComponentEntry>;
}

/**
 * Compiles registered message-type renderers and keeps them fresh.
 *
 * Failure handling: every error entry carries a `retry()` so the UI can offer
 * recovery, and entries record the registration seq they failed at — a newer
 * `messageType.registered` (higher updatedAtSeq) automatically recompiles, so
 * a type that becomes available later is picked up without a reload.
 */
export function useMessageTypeRegistry({
  client,
  messages,
  definitions,
  loadSourceFile,
  loadImport,
}: UseMessageTypeRegistryOptions): MessageTypeRegistryState {
  const [entries, setEntries] = useState<Map<string, MessageTypeComponentEntry>>(new Map());
  const [fetchedDefinitions, setFetchedDefinitions] = useState<Map<string, MessageTypeDefinition>>(new Map());
  // Bumping the epoch invalidates negative caches and re-runs fetch/compile.
  const [registryEpoch, setRegistryEpoch] = useState(0);
  const entriesRef = useRef(new Map<string, MessageTypeComponentEntry>());
  const definitionsRef = useRef(new Map<string, MessageTypeDefinition>());
  const pendingFetchesRef = useRef(new Set<string>());
  const pendingCompilesRef = useRef(new Set<string>());
  const fetchedInitialRef = useRef<{ client: PubSubClient; epoch: number } | null>(null);

  const retry = useCallback(() => setRegistryEpoch((epoch) => epoch + 1), []);

  // Diagnostic trail: a card pill stuck on a spinner means a typeId never
  // reached "ready"/"error" — these logs say which stage stalled (definition
  // fetch, source load, compile). Cheap and high-signal; keep until the
  // registry has first-class status surfacing in the UI.
  const trace = useCallback((stage: string, typeId: string, detail?: unknown) => {
    console.info(`[useMessageTypeRegistry] ${stage} type=${typeId}`, detail ?? "");
  }, []);

  const allDefinitions = useMemo(() => {
    const map = new Map(fetchedDefinitions);
    for (const definition of definitions) map.set(definition.typeId, definition);
    return Array.from(map.values());
  }, [definitions, fetchedDefinitions]);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    const next = new Map(definitionsRef.current);
    for (const definition of allDefinitions) {
      next.set(definition.typeId, definition);
    }
    definitionsRef.current = next;
  }, [allDefinitions]);

  // Unmount guard for detached compile completions. Compiles are NOT tied to
  // the triggering effect's lifetime: the effect re-runs on every definitions
  // identity change (each new registration), and an effect-scoped `cancelled`
  // flag silently discarded in-flight compile results while pendingCompilesRef
  // still marked them in flight — a permanent "compiling" spinner whenever
  // several types registered in quick succession.
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const cancelled = () => !mountedRef.current;

    function setError(
      typeId: string,
      message: string,
      updatedAtSeq?: number,
      definition?: MessageTypeDefinition
    ): void {
      setEntries((prev) => {
        const current = prev.get(typeId);
        if (current?.status === "error" && current.message === message) return prev;
        const next = new Map(prev);
        next.set(typeId, { status: "error", message, updatedAtSeq, definition, retry });
        return next;
      });
    }

    function setLoadingStage(
      typeId: string,
      stage: MessageTypeLoadingStage,
      definition?: MessageTypeDefinition
    ): void {
      setEntries((prev) => {
        const next = new Map(prev);
        next.set(typeId, { status: "loading", stage, startedAt: Date.now(), definition });
        return next;
      });
    }

    async function compileDefinition(definition: MessageTypeDefinition): Promise<void> {
      if (definition.cleared) {
        setError(
          definition.typeId,
          `Message type ${definition.typeId} was cleared`,
          definition.updatedAtSeq
        );
        return;
      }
      if (!definition.source) {
        setError(
          definition.typeId,
          `Message type ${definition.typeId} has no source`,
          definition.updatedAtSeq
        );
        return;
      }
      const compileKey = `${definition.typeId}:${definition.updatedAtSeq}:${registryEpoch}`;
      const existing = entriesRef.current.get(definition.typeId);
      if (
        existing?.status === "ready" &&
        existing.definition.updatedAtSeq === definition.updatedAtSeq
      ) {
        return;
      }
      // A failed compile of this same registration stays failed until retry()
      // bumps the epoch or a newer registration arrives.
      if (
        existing?.status === "error" &&
        existing.updatedAtSeq !== undefined &&
        existing.updatedAtSeq >= definition.updatedAtSeq
      ) {
        return;
      }
      if (pendingCompilesRef.current.has(compileKey)) return;
      pendingCompilesRef.current.add(compileKey);

      try {
        trace("compile.start", definition.typeId, {
          source: definition.source.type === "file" ? definition.source.path : "inline",
          updatedAtSeq: definition.updatedAtSeq,
        });
        setLoadingStage(definition.typeId, "loading-source", definition);
        const sourceCode = definition.source.type === "file"
          ? await loadSourceFile?.(definition.source.path)
          : definition.source.code;
        if (!sourceCode) throw new Error(`Unable to load source for message type ${definition.typeId}`);
        trace("compile.source-loaded", definition.typeId, { bytes: sourceCode.length });
        setLoadingStage(definition.typeId, "compiling", definition);
        const result = await compileMessageTypeModule(sourceCode, {
          imports: definition.imports,
          sourcePath: definition.source.type === "file" ? definition.source.path : undefined,
          loadSourceFile,
          loadImport,
        });
        if (cancelled()) return;
        trace(
          result.success ? "compile.ready" : "compile.error",
          definition.typeId,
          result.success ? undefined : result.error
        );
        if (result.success && result.module) {
          const module = result.module;
          setEntries((prev) => {
            const next = new Map(prev);
            next.set(definition.typeId, {
              status: "ready",
              definition,
              module,
              cacheKey: result.cacheKey ?? `${definition.typeId}:${definition.updatedAtSeq}`,
            });
            return next;
          });
        } else {
          setError(
            definition.typeId,
            result.error ?? `Failed to compile message type ${definition.typeId}`,
            definition.updatedAtSeq,
            definition
          );
        }
      } catch (err) {
        if (cancelled()) return;
        setError(
          definition.typeId,
          err instanceof Error ? err.message : String(err),
          definition.updatedAtSeq,
          definition
        );
      } finally {
        pendingCompilesRef.current.delete(compileKey);
      }
    }

    for (const definition of allDefinitions) {
      void compileDefinition(definition);
    }
  }, [allDefinitions, loadSourceFile, loadImport, registryEpoch, retry, trace]);

  // Initial (and retried) registry fetch. A fetch failure produces no entries,
  // so per-type on-demand fetches below still get their chance; retry() also
  // re-runs this path because it keys on the epoch.
  useEffect(() => {
    if (!client) return;
    const marker = fetchedInitialRef.current;
    if (marker && marker.client === client && marker.epoch === registryEpoch) return;
    fetchedInitialRef.current = { client, epoch: registryEpoch };
    void client.getMessageTypes().then((remoteDefinitions) => {
      setFetchedDefinitions((prev) => {
        const next = new Map(prev);
        for (const definition of remoteDefinitions) next.set(definition.typeId, definition);
        return next;
      });
    }).catch((err) => {
      console.warn("[useMessageTypeRegistry] failed to fetch message type registry:", err);
    });
  }, [client, registryEpoch]);

  // On-demand fetch for types referenced by messages but not yet known.
  useEffect(() => {
    if (!client) return;
    for (const msg of messages) {
      if (msg.contentType !== "custom" || !msg.custom) continue;
      const typeId = msg.custom.typeId;
      if (definitionsRef.current.has(typeId) || pendingFetchesRef.current.has(typeId)) continue;
      // Existing entries block a refetch; retry() bumps the epoch, which
      // deletes error entries (below) and lets the fetch run again.
      if (entriesRef.current.has(typeId)) continue;
      pendingFetchesRef.current.add(typeId);
      trace("fetch.start", typeId);
      setEntries((prev) => {
        const next = new Map(prev);
        next.set(typeId, { status: "loading", stage: "fetching-definition", startedAt: Date.now() });
        return next;
      });
      void client.getMessageType(typeId).then((definition) => {
        trace("fetch.resolved", typeId, { found: Boolean(definition) });
        if (!definition) {
          setEntries((prev) => {
            const next = new Map(prev);
            next.set(typeId, {
              status: "error",
              message: `Message type ${typeId} is not registered`,
              retry,
            });
            return next;
          });
          return;
        }
        setFetchedDefinitions((prev) => new Map(prev).set(typeId, definition));
      }).catch((err) => {
        setEntries((prev) => {
          const next = new Map(prev);
          next.set(typeId, {
            status: "error",
            message: err instanceof Error ? err.message : String(err),
            retry,
          });
          return next;
        });
      }).finally(() => {
        pendingFetchesRef.current.delete(typeId);
      });
    }
  }, [client, messages, registryEpoch, retry, trace]);

  // An epoch bump clears error entries so loading states show again and
  // negative caches ("not registered") are forgotten.
  useEffect(() => {
    if (registryEpoch === 0) return;
    setEntries((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [typeId, entry] of prev) {
        if (entry.status === "error") {
          next.delete(typeId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [registryEpoch]);

  return { messageTypeComponents: entries };
}
