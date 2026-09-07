/** Ergonomic whole-file authoring facade over the canonical mutation engine. */

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

const writeSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description:
        "File to create or replace. Managed source paths must be inside an existing workspace repository; use .tmp/<name> for context-local scratch data.",
    }),
    content: Type.String({ description: "Complete UTF-8 text content for the resulting file." }),
    createOnly: Type.Optional(
      Type.Boolean({
        description: "Require the path to be absent; return a conflict instead of overwriting.",
      })
    ),
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

export type WriteToolInput = Static<typeof writeSchema>;
export type WriteToolDetails = SemanticFileMutationDetails;

export function createWriteTool(
  cwd: string,
  vcs: ToolEditingVcs,
  context: ToolMutationContext,
  fs?: Pick<RuntimeFs, "readFile" | "writeFile">,
  observations?: WorkspaceFileObservationStore
): AgentTool<typeof writeSchema, WriteToolDetails> {
  return {
    name: "write",
    label: "Write file",
    description:
      "Create or replace one complete text file. Managed files are authored as a state-checked semantic VCS work unit tied to this invocation and optional stated intent; .tmp files are explicitly reported as scratch. Files read earlier are protected against stale overwrites automatically; createOnly: true requires an absent path. Identical content is an unchanged success. Use edit for a targeted text change and apply_patch for an atomic multi-file transaction or explicit file mode.",
    parameters: writeSchema,
    cancellationMode: "settle",
    execute: async (_toolCallId, input, signal): Promise<AgentToolResult<WriteToolDetails>> => {
      const { path, content } = input;
      if (typeof path !== "string" || typeof content !== "string") {
        throw Object.assign(new Error("write requires path and content"), {
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
              kind: "write",
              path,
              content,
              ...(input.createOnly ? { createOnly: true } : {}),
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
