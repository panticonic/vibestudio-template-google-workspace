import { z } from "zod";

export const AGENT_TOOL_ARTIFACT_PROTOCOL = "agent-tool-artifact.v1" as const;
export const AGENT_TOOL_ARTIFACT_URI_PREFIX = "artifact:" as const;

export const agentToolArtifactRefSchema = z
  .object({
    protocol: z.literal(AGENT_TOOL_ARTIFACT_PROTOCOL),
    uri: z.string().regex(/^artifact:[0-9a-f]{64}$/u),
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
    byteLength: z.number().int().nonnegative(),
    mediaType: z.literal("application/json"),
    encoding: z.literal("json"),
    description: z.string().min(1),
  })
  .strict();

export type AgentToolArtifactRef = z.infer<typeof agentToolArtifactRefSchema>;

export function createAgentToolArtifactRef(input: {
  digest: string;
  byteLength: number;
  description: string;
}): AgentToolArtifactRef {
  return agentToolArtifactRefSchema.parse({
    protocol: AGENT_TOOL_ARTIFACT_PROTOCOL,
    uri: `${AGENT_TOOL_ARTIFACT_URI_PREFIX}${input.digest}`,
    digest: input.digest,
    byteLength: input.byteLength,
    mediaType: "application/json",
    encoding: "json",
    description: input.description,
  });
}

export function artifactDigestFromUri(value: string): string | null {
  const match = /^artifact:([0-9a-f]{64})$/u.exec(value);
  return match?.[1] ?? null;
}
