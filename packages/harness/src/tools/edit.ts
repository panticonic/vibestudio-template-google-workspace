/** Ergonomic targeted-text facade over the canonical mutation engine. */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";
import {
  mutateFiles,
  mutationResultText,
  type SemanticFileMutationDetails,
} from "./file-mutation.js";
import type { WorkspaceFileObservationStore } from "./file-observations.js";
import type { RuntimeFs } from "./runtime-fs.js";
import type { ToolEditingVcs, ToolMutationContext } from "./tool-vcs.js";

const editSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description:
        "Text file to change. Managed source paths must be inside an existing workspace repository; .tmp paths use context-local scratch storage.",
    }),
    oldText: Type.String({
      minLength: 1,
      description:
        "Text identifying exactly one site. Exact bytes are preferred; when absent, one normalized match may bridge line endings, trailing whitespace, smart punctuation, Unicode spaces, and BOM-preserving text.",
    }),
    newText: Type.String({ description: "Replacement text." }),
    intent: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Purpose not already evident from the request. Stored as stated semantic VCS intent for managed files.",
      })
    ),
  },
  { additionalProperties: false }
);

export type EditToolInput = Static<typeof editSchema>;
export type EditToolDetails = SemanticFileMutationDetails;

export function createEditTool(
  cwd: string,
  vcs: ToolEditingVcs,
  context: ToolMutationContext,
  fs?: Pick<RuntimeFs, "readFile" | "writeFile">,
  observations?: WorkspaceFileObservationStore
): AgentTool<typeof editSchema, EditToolDetails> {
  return {
    name: "edit",
    label: "Edit file",
    description:
      'Replace one uniquely identifiable text span. Matching is deterministic and shared with apply_patch: one exact occurrence wins; only when exact bytes are absent may one normalized occurrence match across line endings, trailing whitespace, smart punctuation, Unicode spaces, and BOM-preserving text. Ambiguous, missing, binary, or stale input returns a structured conflict and changes nothing. Managed edits author a semantic VCS work unit tied to this invocation and optional stated intent; .tmp edits are explicitly scratch. Include unchanged surrounding text when a short anchor is ambiguous. Undo a named semantic change with vcs({ operation: "revert", changeIds: [...] }) rather than writing old bytes as unrelated intent.',
    parameters: editSchema,
    cancellationMode: "settle",
    execute: async (_toolCallId, input, signal): Promise<AgentToolResult<EditToolDetails>> => {
      const { path, oldText, newText } = input;
      if (typeof path !== "string" || typeof oldText !== "string" || typeof newText !== "string") {
        throw Object.assign(new Error("edit requires path, oldText, and newText"), {
          code: "InvalidFileMutation",
        });
      }
      const details = await mutateFiles(
        cwd,
        vcs,
        context,
        {
          operations: [
            {
              kind: "replace",
              path,
              replacements: [{ oldText, newText }],
            },
          ],
          ...(input.intent ? { intent: input.intent } : {}),
        },
        signal,
        fs,
        observations
      );
      return { content: [{ type: "text", text: mutationResultText(details) }], details };
    },
  };
}
