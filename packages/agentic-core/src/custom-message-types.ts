import type { ComponentType } from "react";
import { jsonSchemaToZod } from "@workspace/agentic-protocol";
import { compileModule, type CompileComponentOptions } from "@workspace/eval";

export interface CustomMessageComponentProps {
  messageId: string;
  typeId: string;
  state: unknown;
  expanded: boolean;
  displayMode: "inline" | "row";
  chat: Record<string, unknown>;
}

export interface MessageTypeModule {
  default?: ComponentType<CustomMessageComponentProps>;
  /** Optional compact renderer for the collapsed inline view (expanded === false). */
  Pill?: ComponentType<CustomMessageComponentProps>;
  reduce?: (state: unknown, update: unknown) => unknown;
  [key: string]: unknown;
}

export async function compileMessageTypeModule(
  code: string,
  options: CompileComponentOptions = {},
) {
  return compileModule<MessageTypeModule>(code, options);
}

export function foldCustomMessageState(
  initialState: unknown,
  updates: Array<{ update: unknown; seq: number }>,
  reducer?: (state: unknown, update: unknown) => unknown,
): unknown {
  if (!reducer) {
    return updates.length > 0 ? updates[updates.length - 1]?.update : initialState;
  }
  // A throwing reducer must not blank the whole card: keep the last good state,
  // warn, and continue folding the remaining updates.
  return updates.reduce((state, item) => {
    try {
      return reducer(state, item.update);
    } catch (err) {
      console.warn("[custom-message] reducer threw; keeping prior state", err);
      return state;
    }
  }, initialState);
}

/**
 * Validate state against a registered JSON Schema document. Schemas are data
 * carried in the message-type registration, so the same document is enforced
 * at agent emission time and at the panel render boundary. Returns a list of
 * human-readable error messages, or null when valid / no schema.
 */
export function validateCustomState(
  schema: Record<string, unknown> | undefined,
  state: unknown,
): string[] | null {
  if (!schema) return null;
  try {
    const parsed = jsonSchemaToZod(schema).safeParse(state);
    if (parsed.success) return null;
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    });
    return issues.length ? issues : ["schema validation failed"];
  } catch (err) {
    return [`schema validation threw: ${err instanceof Error ? err.message : String(err)}`];
  }
}
