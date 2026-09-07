/**
 * useInlineUi — Inline UI component compilation + cleanup.
 *
 * Compiles inline UI messages (TSX components) and cleans up
 * compiled components when messages are trimmed.
 */

import { useState, useEffect, useRef } from "react";
import { CONTENT_TYPE_INLINE_UI } from "@workspace/pubsub";
import type { LoadSourceFile, SandboxOptions } from "@workspace/eval";
import { parseInlineUiData } from "../../components/InlineUiMessage";
import type { ChatMessage, InlineUiComponentEntry } from "../../types";

interface UseInlineUiOptions {
  messages: ChatMessage[];
  loadSourceFile?: LoadSourceFile;
  loadImport?: SandboxOptions["loadImport"];
}

export interface InlineUiState {
  inlineUiComponents: Map<string, InlineUiComponentEntry>;
}

type InlineUiDescriptor =
  | NonNullable<ChatMessage["inlineUi"]>
  | NonNullable<ReturnType<typeof parseInlineUiData>>;

function canonicalImports(
  imports: Record<string, string> | undefined,
): [string, string][] {
  return Object.entries(imports ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function renderRevisionKey(data: InlineUiDescriptor): string {
  return JSON.stringify([
    data.source,
    canonicalImports(data.imports),
    data.renderedAt ?? null,
  ]);
}

function compiledSourceKey(
  sourceCode: string,
  sourcePath: string | undefined,
  imports: Record<string, string> | undefined,
): string {
  return JSON.stringify([
    sourcePath ?? null,
    canonicalImports(imports),
    sourceCode,
  ]);
}

export function useInlineUi({
  messages,
  loadSourceFile,
  loadImport,
}: UseInlineUiOptions): InlineUiState {
  const [inlineUiComponents, setInlineUiComponents] = useState<
    Map<string, InlineUiComponentEntry>
  >(new Map());
  const entriesRef = useRef(inlineUiComponents);
  const observedRevisionsRef = useRef(new Map<string, string>());
  const compiledSourcesRef = useRef(new Map<string, string>());
  const compilationQueuesRef = useRef(new Map<string, Promise<void>>());
  const loadersRef = useRef({ loadSourceFile, loadImport });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Compile inline UI messages
  useEffect(() => {
    if (
      loadersRef.current.loadSourceFile !== loadSourceFile ||
      loadersRef.current.loadImport !== loadImport
    ) {
      loadersRef.current = { loadSourceFile, loadImport };
      observedRevisionsRef.current.clear();
    }

    const publishEntry = (id: string, entry: InlineUiComponentEntry) => {
      const updated = new Map(entriesRef.current);
      updated.set(id, entry);
      entriesRef.current = updated;
      setInlineUiComponents(updated);
    };

    const isCurrent = (id: string, revision: string) =>
      mountedRef.current && observedRevisionsRef.current.get(id) === revision;

    const compileInlineUi = async (
      data: InlineUiDescriptor,
      revision: string,
    ) => {
      if (!isCurrent(data.id, revision)) return;
      try {
        const sourceCode =
          data.source.type === "file"
            ? await loadSourceFile?.(data.source.path)
            : data.source.code;
        if (!sourceCode)
          throw new Error(`Unable to load inline UI source for ${data.id}`);
        if (!isCurrent(data.id, revision)) return;

        const sourcePath =
          data.source.type === "file" ? data.source.path : undefined;
        const sourceKey = compiledSourceKey(
          sourceCode,
          sourcePath,
          data.imports,
        );
        const existing = entriesRef.current.get(data.id);
        if (
          existing?.Component &&
          compiledSourcesRef.current.get(data.id) === sourceKey
        )
          return;

        publishEntry(data.id, { cacheKey: sourceKey });
        const { compileComponent } = await import("@workspace/eval/sandbox");
        const result = await compileComponent<
          NonNullable<InlineUiComponentEntry["Component"]>
        >(sourceCode, {
          imports: data.imports,
          sourcePath,
          loadSourceFile,
          loadImport,
          consoleCapacity: 100,
        });
        if (!isCurrent(data.id, revision)) return;
        if (result.success) {
          compiledSourcesRef.current.set(data.id, sourceKey);
          publishEntry(data.id, {
            Component: result.Component!,
            cacheKey: result.cacheKey!,
            runtime: result.runtime,
          });
        } else {
          compiledSourcesRef.current.delete(data.id);
          console.error(
            `[InlineUiMessage] Component "${data.id}" compilation failed` +
              (data.source.type === "file" ? ` (${data.source.path})` : ""),
            result.errorStack ?? result.error,
          );
          publishEntry(data.id, {
            cacheKey: sourceKey,
            error: result.error,
            errorStack: result.errorStack,
            runtime: result.runtime,
          });
        }
      } catch (err) {
        if (!isCurrent(data.id, revision)) return;
        compiledSourcesRef.current.delete(data.id);
        console.error(
          `[InlineUiMessage] Component "${data.id}" source loading failed` +
            (data.source.type === "file" ? ` (${data.source.path})` : ""),
          err,
        );
        publishEntry(data.id, {
          cacheKey: revision,
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof Error && err.stack
            ? { errorStack: err.stack }
            : {}),
        });
      }
    };

    const enqueueCompilation = (data: InlineUiDescriptor, revision: string) => {
      // Compilation mutates the shared sandbox module registry. Serialize
      // revisions of one stable card so a slow superseded build cannot finish
      // last and restore an older package version behind the current UI.
      const previous =
        compilationQueuesRef.current.get(data.id) ?? Promise.resolve();
      const next = previous.then(() => compileInlineUi(data, revision));
      compilationQueuesRef.current.set(data.id, next);
      void next.finally(() => {
        if (compilationQueuesRef.current.get(data.id) === next) {
          compilationQueuesRef.current.delete(data.id);
        }
      });
    };

    const referencedUiIds = new Set<string>();
    for (const msg of messages) {
      if (msg.contentType !== CONTENT_TYPE_INLINE_UI) continue;
      const data = msg.inlineUi ?? parseInlineUiData(msg.content);
      if (!data) continue;
      referencedUiIds.add(data.id);
      const revision = renderRevisionKey(data);
      if (observedRevisionsRef.current.get(data.id) === revision) continue;
      observedRevisionsRef.current.set(data.id, revision);
      enqueueCompilation(data, revision);
    }

    for (const id of observedRevisionsRef.current.keys()) {
      if (!referencedUiIds.has(id)) {
        observedRevisionsRef.current.delete(id);
        compiledSourcesRef.current.delete(id);
      }
    }

    const updated = new Map(entriesRef.current);
    let removed = false;
    for (const id of updated.keys()) {
      if (!referencedUiIds.has(id)) {
        updated.delete(id);
        removed = true;
      }
    }
    if (removed) {
      entriesRef.current = updated;
      setInlineUiComponents(updated);
    }
  }, [messages, loadSourceFile, loadImport]);

  return { inlineUiComponents };
}
