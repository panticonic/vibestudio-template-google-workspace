import { z } from "zod";

export const execIntentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("argv"),
      executable: z.string().min(1),
      args: z.array(z.string()).optional().default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("script"),
      script: z.string().min(1),
    })
    .strict(),
]);

export const execRequestSchema = z
  .object({
    intent: execIntentSchema,
    cwd: z.string().optional(),
    env: z.record(z.string()).optional().default({}),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(10 * 60_000)
      .optional()
      .default(30_000),
    stdin: z
      .string()
      .max(64 * 1024)
      .optional(),
    maxOutputBytes: z
      .number()
      .int()
      .min(1024)
      .max(16 * 1024 * 1024)
      .optional()
      .default(1024 * 1024),
    // When set, the run is confined to the context's materialized working folder
    // (cwd resolves within it, env/cwd default to it) instead of the workspace root.
    contextId: z.string().min(1).optional(),
    contextAttachToken: z.string().min(16).optional(),
  })
  .strict();

const environmentEntrySchema = z.tuple([z.string().min(1), z.string()]);

export const sealedExecPlanSchema = z
  .object({
    version: z.literal(1),
    intent: execIntentSchema,
    cwd: z.string().min(1),
    environment: z
      .object({
        profile: z
          .object({
            id: z.literal("vibestudio.shell.host-minimal.v1"),
            label: z.string().min(1),
            revision: z.string().regex(/^[0-9a-f]{12}$/),
          })
          .strict(),
        effective: z.array(environmentEntrySchema),
        overrides: z.array(environmentEntrySchema),
      })
      .strict(),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(10 * 60_000),
    stdin: z
      .string()
      .max(64 * 1024)
      .optional(),
    maxOutputBytes: z
      .number()
      .int()
      .min(1024)
      .max(16 * 1024 * 1024),
  })
  .strict();

export const openRequestSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional().default([]),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional().default({}),
    cols: z.number().int().min(1).max(1000).optional().default(80),
    rows: z.number().int().min(1).max(1000).optional().default(24),
    label: z.string().max(80).optional(),
    // Context-scoped placement: the session lives inside the exact semantic
    // context projection; cwd confinement is relative to that projection.
    contextId: z.string().min(1).optional(),
    contextAttachToken: z.string().min(16).optional(),
  })
  .strict();

export const createContextRequestSchema = z
  .object({
    title: z.string().min(1).max(80).optional(),
  })
  .optional();

export type ExecRequest = z.infer<typeof execRequestSchema>;
export type ExecIntent = z.infer<typeof execIntentSchema>;
export type SealedExecPlan = z.infer<typeof sealedExecPlanSchema>;
export type OpenRequest = z.infer<typeof openRequestSchema>;
export type CreateContextRequest = z.infer<typeof createContextRequestSchema>;
export interface FreshContextHandle {
  contextId: string;
  contextAttachToken: string;
}
export type ScrollCursor = string;

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
  truncated?: boolean;
}

export interface SessionInfo {
  sessionId: string;
  ownerCallerId: string;
  label: string;
  command: { argv: string[]; cwd: string };
  /** Set for context-scoped sessions (placed inside a VCS context folder). */
  contextId?: string;
  revisionLabel?: string;
  pid: number;
  pgid: number;
  cols: number;
  rows: number;
  startedAt: number;
  lastActivityAt: number;
  alive: boolean;
  exit?: { code: number | null; signal?: string; at: number };
  processTree: Array<{ pid: number; ppid: number; comm: string; args: string[] }>;
  listeningPorts: Array<{
    proto: "tcp" | "tcp6" | "udp" | "udp6";
    addr: string;
    port: number;
    pid: number;
  }>;
  detectedPorts: number[];
  detectedUrls: string[];
  bytesOut: number;
  meta: Record<string, unknown>;
  // Display-only classification derived from the launched executable.
  detectedAgent?: { kind: string; title?: string };
}

export type SessionInfoEvent =
  | { type: "snapshot-batch"; sessions: SessionInfo[] }
  | { type: "snapshot"; sessionId: string; info: SessionInfo }
  | { type: "opened"; sessionId: string; info: SessionInfo }
  | { type: "exit"; sessionId: string; exit: { code: number | null; signal?: string; at: number } }
  | { type: "disposed"; sessionId: string }
  | { type: "heartbeat"; at: number };
