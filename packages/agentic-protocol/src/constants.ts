export const AGENTIC_PROTOCOL_VERSION = "agentic.trajectory.v1" as const;

export const AGENTIC_EVENT_PAYLOAD_KIND = "agentic.trajectory.v1/event" as const;

/** Channel envelope kind for the model credential connect card. Published by
 *  the agent's credential_wait executor; reduced into
 *  `ChannelViewState.credentialRequests` and rendered by the chat UI. */
export const CREDENTIAL_CONNECT_PAYLOAD_KIND = "agentic.credential-connect.v1" as const;

export const GENESIS_EVENT_HASH = "0".repeat(64);

export const TERMINAL_MESSAGE_KINDS = ["message.completed", "message.failed"] as const;

export const TERMINAL_INVOCATION_KINDS = [
  "invocation.completed",
  "invocation.failed",
  "invocation.cancelled",
  "invocation.abandoned",
] as const;

export const INVOCATION_OUTCOMES = [
  "success",
  "tool_error",
  "infrastructure_error",
  "cancelled",
  "stale_dispatch",
  "abandoned",
] as const;

export type InvocationOutcome = (typeof INVOCATION_OUTCOMES)[number];

export const MESSAGE_OUTCOMES = ["completed", "empty", "tool_calls_only", "interrupted"] as const;

export type MessageOutcome = (typeof MESSAGE_OUTCOMES)[number];

/**
 * Salience tier of a message — how prominently the UI should present it.
 *  - "primary"   (tier 1): a headline the human cares about directly — their
 *    own typed input, or an agent's final answer for a turn. Full presentation.
 *  - "secondary" (tier 2): supporting content — intermediate agent steps
 *    (narration before tool calls), system-injected prompts, and messages
 *    produced by UI interactions. Rendered slighter/de-emphasized.
 *
 * Absent ⇒ treated as "primary" so messages predating this field render as
 * they always have.
 */
export const MESSAGE_TIERS = ["primary", "secondary"] as const;

export type MessageTier = (typeof MESSAGE_TIERS)[number];

export type TerminalInvocationKind = (typeof TERMINAL_INVOCATION_KINDS)[number];

export const TURN_REASON_CODES = [
  "user_interrupted",
  "channel_unsubscribe",
  "runner_restarted",
  "turn_superseded",
  "work_failed",
  "model_credential_required",
  "model_credential_reconnect_required",
  "model_usage_limit_reset",
  "model_retry_limit_exceeded",
  "waiting_for_background",
  "no_foreground_work",
  "not_addressed",
  "already_handled",
  "input_required",
  "forked",
] as const;

export type TurnReasonCode = (typeof TURN_REASON_CODES)[number];

export const LIFECYCLE_MESSAGE_REASON_CODES = [
  "runner_restarted_before_model",
  "runner_restarted_mid_model",
  "recovery_continue_failed",
  "model_credential_required",
] as const;

export type LifecycleMessageReasonCode = (typeof LIFECYCLE_MESSAGE_REASON_CODES)[number];

export type LifecycleNoticeStatus = "recovered" | "interrupted" | "failed";

export interface LifecycleRecoveryNotice {
  reason: LifecycleMessageReasonCode;
  status: LifecycleNoticeStatus;
  title: string;
  /** Static detail; the recovery-continue-failed case appends the dynamic error. */
  detail: string;
}

/**
 * Single source of truth for agent lifecycle/recovery notice prose, keyed by the
 * typed reason code. Producers emit `*.message`; consumers classify content via
 * `lifecycleRecoveryNoticeForMessage`. The reason code — not the prose — is the
 * authoritative control-flow signal (see `vibestudioDiagnostic`); this table just
 * de-duplicates the human strings that previously lived in 3+ places.
 */
export const LIFECYCLE_RECOVERY_NOTICES = {
  runner_restarted_before_model: {
    reason: "runner_restarted_before_model",
    status: "interrupted",
    title: "Restart interrupted the turn",
    detail: "The agent restarted before it began responding. No tool work was replayed.",
    message: "Agent turn was interrupted before model generation began.",
  },
  runner_restarted_mid_model: {
    reason: "runner_restarted_mid_model",
    status: "interrupted",
    title: "Restart interrupted the response",
    detail: "The partial response was discarded because replay is not enabled for this agent.",
    message: "Agent turn was interrupted during model generation.",
  },
  recovery_continue_failed: {
    reason: "recovery_continue_failed",
    status: "failed",
    title: "Recovery could not continue",
    detail: "",
    // Prefix — the dynamic error message follows.
    message: "Recovered tool result could not continue the agent:",
  },
} as const satisfies Record<
  Exclude<LifecycleMessageReasonCode, "model_credential_required">,
  LifecycleRecoveryNotice & { message: string }
>;

/**
 * The stale-pre-dispatch lifecycle phrase. Its control flow is already typed at
 * the invocation level (`terminalOutcome: "stale_dispatch"` /
 * `reasonCode: "aborted_before_dispatch"`); this is the single source for the
 * human string that was duplicated across the dispatch-abort throw sites.
 */
export const AGENT_INTERRUPTED_BEFORE_TOOL_DISPATCH =
  "Agent turn was interrupted before tool dispatch.";

/**
 * Classify a lifecycle/recovery message string into its typed notice. Shared by
 * the agent vessel (which attaches it as `vibestudioDiagnostic`) and the chat
 * projection (fallback when the diagnostic metadata is absent), so the matching
 * logic lives in exactly one place.
 */
export function lifecycleRecoveryNoticeForMessage(
  content: string
): (LifecycleRecoveryNotice & { detail: string }) | undefined {
  if (content === LIFECYCLE_RECOVERY_NOTICES.runner_restarted_before_model.message) {
    return LIFECYCLE_RECOVERY_NOTICES.runner_restarted_before_model;
  }
  if (content === LIFECYCLE_RECOVERY_NOTICES.runner_restarted_mid_model.message) {
    return LIFECYCLE_RECOVERY_NOTICES.runner_restarted_mid_model;
  }
  const failedPrefix = LIFECYCLE_RECOVERY_NOTICES.recovery_continue_failed.message;
  if (content.startsWith(failedPrefix)) {
    return {
      ...LIFECYCLE_RECOVERY_NOTICES.recovery_continue_failed,
      detail: content.slice(failedPrefix.length).trim(),
    };
  }
  return undefined;
}

export function isInvocationOutcome(value: unknown): value is InvocationOutcome {
  return INVOCATION_OUTCOMES.includes(value as InvocationOutcome);
}

export function isTurnReasonCode(value: unknown): value is TurnReasonCode {
  return TURN_REASON_CODES.includes(value as TurnReasonCode);
}

export function isLifecycleMessageReasonCode(value: unknown): value is LifecycleMessageReasonCode {
  return LIFECYCLE_MESSAGE_REASON_CODES.includes(value as LifecycleMessageReasonCode);
}

export function isTerminalInvocationKind(value: unknown): value is TerminalInvocationKind {
  return TERMINAL_INVOCATION_KINDS.includes(value as TerminalInvocationKind);
}

export function invocationTerminalKindForOutcome(
  outcome: InvocationOutcome
): TerminalInvocationKind {
  switch (outcome) {
    case "success":
      return "invocation.completed";
    case "tool_error":
    case "infrastructure_error":
      return "invocation.failed";
    case "cancelled":
    case "stale_dispatch":
      return "invocation.cancelled";
    case "abandoned":
      return "invocation.abandoned";
  }
}

export function validateInvocationTerminalOutcomeForKind(
  kind: unknown,
  outcome: unknown
): { valid: true } | { valid: false; message: string } {
  if (!isTerminalInvocationKind(kind)) return { valid: true };
  if (!isInvocationOutcome(outcome)) {
    return { valid: false, message: `${kind} requires payload.terminalOutcome` };
  }
  const expectedKind = invocationTerminalKindForOutcome(outcome);
  if (expectedKind !== kind) {
    return {
      valid: false,
      message: `terminalOutcome ${outcome} is inconsistent with ${kind}`,
    };
  }
  return { valid: true };
}

export const TERMINAL_APPROVAL_KINDS = ["approval.resolved"] as const;

export const TURN_SCOPED_OWNER_KINDS = [
  "message.started",
  "message.delta",
  "message.completed",
  "message.failed",
  "invocation.started",
  "invocation.progress",
  "invocation.output",
  "invocation.completed",
  "invocation.failed",
  "invocation.cancelled",
  "invocation.abandoned",
  "approval.requested",
  "approval.resolved",
  "turn.opened",
  "turn.waiting",
  "turn.closed",
] as const;
