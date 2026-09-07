/**
 * Protocol message schemas for agentic messaging.
 *
 * Zod schemas for validating message payloads sent over pubsub.
 */

import { z } from "zod";

export const UpdateMessageSchema = z.object({
  id: z.string().uuid(),
  content: z.string().optional(),
  contentType: z.string().optional(),
  complete: z.boolean().optional(),
  /** When true, content appends even on typed (contentType-set) messages. */
  append: z.boolean().optional(),
});

export const ErrorMessageSchema = z.object({
  id: z.string().uuid(),
  error: z.string(),
  code: z.string().optional(),
});

export const SignalMessageSchema = z.object({
  content: z.string(),
  contentType: z.string().optional(),
});

export const MethodCallSchema = z.object({
  /** Canonical user-visible invocation id. */
  invocationId: z.string().min(1),
  /** Transport dispatch id used for cancellation/result routing. */
  transportCallId: z.string().uuid(),
  /** Client-facing handle id; currently mirrors `transportCallId`. */
  callId: z.string().uuid().optional(),
  turnId: z.string().optional(),
  methodName: z.string().min(1),
  providerId: z.string().min(1),
  args: z.unknown(),
});

export const MethodResultSchema = z.object({
  invocationId: z.string().min(1).optional(),
  transportCallId: z.string().uuid(),
  callId: z.string().uuid().optional(),
  turnId: z.string().optional(),
  content: z.unknown().optional(),
  contentType: z.string().optional(),
  complete: z.boolean().optional(),
  isError: z.boolean().optional(),
  progress: z.number().min(0).max(100).optional(),
});

export const MethodCancelSchema = z.object({
  transportCallId: z.string().uuid(),
  callId: z.string().uuid().optional(),
});

export const ExecutionPauseSchema = z.object({
  messageId: z.string().uuid(),
  status: z.enum(["paused", "resumed", "cancelled"]),
  reason: z.string().optional(),
});

export type UpdateMessage = z.infer<typeof UpdateMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type SignalMessage = z.infer<typeof SignalMessageSchema>;
export type MethodCall = z.infer<typeof MethodCallSchema>;
export type MethodResult = z.infer<typeof MethodResultSchema>;
export type MethodCancel = z.infer<typeof MethodCancelSchema>;
export type ExecutionPause = z.infer<typeof ExecutionPauseSchema>;
