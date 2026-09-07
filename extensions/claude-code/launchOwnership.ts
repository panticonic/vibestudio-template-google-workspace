import { z } from "zod";

/** Semantic generation bookkeeping only. Host paths, credentials and process
 * ownership belong to the trusted linked-Claude receiver. */
export const claudeLaunchRecordSchema = z
  .object({
    version: z.literal(1),
    launchId: z.string().min(1),
    entityId: z.string().min(1),
    contextId: z.string().min(1),
    channelId: z.string().min(1),
    ownerKind: z.enum(["external-cli", "host-headless"]),
    phase: z.enum(["preparing", "active", "retiring", "released"]),
    agentId: z.string().min(1).nullable(),
    preparedAt: z.string().datetime(),
    releasedAt: z.string().datetime().optional(),
  })
  .strict();
export type ClaudeLaunchRecord = z.infer<typeof claudeLaunchRecordSchema>;
export type ClaudeLaunchOwnerKind = ClaudeLaunchRecord["ownerKind"];
export function parseClaudeLaunchRecord(
  value: unknown,
  key: string,
): ClaudeLaunchRecord {
  const parsed = claudeLaunchRecordSchema.safeParse(value);
  if (!parsed.success)
    throw Object.assign(
      new Error(
        `Invalid Claude generation record ${key}: ${parsed.error.message}`,
      ),
      { code: "ECORRUPT" },
    );
  return parsed.data;
}
