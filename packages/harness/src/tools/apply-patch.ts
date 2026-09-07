/** Atomic multi-file authoring facade over the canonical semantic mutation engine. */

import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";
import {
  mutateSemanticFiles,
  mutationResultText,
  type SemanticFileMutationDetails,
  type SemanticFileMutationOperation,
} from "./file-mutation.js";
import type { WorkspaceFileObservationStore } from "./file-observations.js";
import type { ToolEditingVcs, ToolMutationContext } from "./tool-vcs.js";

const mode = Type.Optional(
  Type.Integer({
    minimum: 0,
    maximum: 0o777,
    description: "Resulting POSIX permission bits, for example 420 for 0644 or 493 for 0755.",
  })
);
const path = Type.String({
  minLength: 1,
  description: "Managed workspace file path inside an existing repository.",
});

const patchOperationSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("replace"),
      path,
      mode,
      replacements: Type.Array(
        Type.Object(
          {
            oldText: Type.String({
              minLength: 1,
              description:
                "Text identifying one site. Exact bytes are preferred; a unique normalized match is accepted when exact bytes are absent.",
            }),
            newText: Type.String(),
          },
          { additionalProperties: false }
        ),
        {
          minItems: 1,
          maxItems: 1_000,
          description:
            'Required replacement list. Example: {"kind":"replace","path":"packages/app/index.ts","replacements":[{"oldText":"before","newText":"after"}]}. oldText/newText are nested here, not fields of the operation.',
        }
      ),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("write"),
      path,
      createOnly: Type.Optional(Type.Boolean()),
      mode,
      content: Type.String(),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("write_binary"),
      path,
      createOnly: Type.Optional(Type.Boolean()),
      mode,
      base64: Type.String({ description: "Complete file bytes encoded as canonical base64." }),
    },
    { additionalProperties: false }
  ),
  Type.Object({ kind: Type.Literal("delete"), path }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal("chmod"),
      path,
      mode: Type.Integer({ minimum: 0, maximum: 0o777 }),
    },
    { additionalProperties: false }
  ),
]);

const applyPatchSchema = Type.Object(
  {
    operations: Type.Array(patchOperationSchema, {
      minItems: 1,
      maxItems: 200,
      description: "File operations admitted together as one atomic semantic VCS mutation.",
    }),
    intent: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Purpose not already evident from the request. Stored as stated semantic VCS intent for the complete atomic work unit.",
      })
    ),
  },
  { additionalProperties: false }
);

export type ApplyPatchOperation = SemanticFileMutationOperation;

export interface ApplyPatchToolInput {
  operations: ApplyPatchOperation[];
  intent?: string;
}

export type ApplyPatchToolDetails = SemanticFileMutationDetails;

export function createApplyPatchTool(
  cwd: string,
  vcs: ToolEditingVcs,
  context: ToolMutationContext,
  observations?: WorkspaceFileObservationStore
): AgentTool<typeof applyPatchSchema, ApplyPatchToolDetails> {
  return {
    name: "apply_patch",
    label: "Apply patch",
    description:
      'Atomically author multiple managed workspace file changes in one semantic VCS work unit. A replace operation has {"kind":"replace","path":"...","replacements":[{"oldText":"...","newText":"..."}]}; intent belongs only at the top level, beside operations. Every path includes its top-level section and repository name, for example projects/app/README.md; workspace-root files are not managed repositories. Replacement matching is deterministic and shared with edit: one exact occurrence wins; if exact bytes are absent, one normalized occurrence may match across line endings, trailing whitespace, smart punctuation, Unicode spaces, and BOM-preserving text. Files read earlier are protected against stale mutations automatically. Missing, stale, or ambiguous preconditions return a structured conflict with no mutation. Use write or edit for the ergonomic single-file forms, and move_file/copy_file for identity-preserving transfers.',
    parameters: applyPatchSchema,
    cancellationMode: "settle",
    execute: async (
      _toolCallId,
      rawInput,
      signal
    ): Promise<AgentToolResult<ApplyPatchToolDetails>> => {
      const details = await mutateSemanticFiles(
        cwd,
        vcs,
        context,
        rawInput as ApplyPatchToolInput,
        signal,
        observations
      );
      return { content: [{ type: "text", text: mutationResultText(details) }], details };
    },
  };
}
