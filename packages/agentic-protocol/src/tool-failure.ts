import { z } from "zod";

export const AGENT_TOOL_FAILURE_PROTOCOL = "agent-tool-failure.v1" as const;

export const AGENT_TOOL_FAILURE_KINDS = [
  "invalid-input",
  "not-found",
  "conflict",
  "authority",
  "external-effect",
  "domain",
  "integrity",
  "infrastructure",
  "cancelled",
  "unknown",
] as const;

export const AGENT_TOOL_RETRY_POLICIES = [
  "none",
  "correct-input",
  "reobserve",
  "retry-identical",
  "request-approval",
] as const;

export const AGENT_TOOL_RECOVERY_ACTIONS = [
  "correct-request",
  "reobserve",
  "retry-identical",
  "request-approval",
  "reacquire-handle",
  "repair-source",
  "stop",
] as const;

const MAX_FAILURE_DATA_BYTES = 4 * 1024;

const causalIdsSchema = z
  .object({
    invocationId: z.string().min(1).optional(),
    commandId: z.string().min(1).optional(),
    effectId: z.string().min(1).optional(),
    contextId: z.string().min(1).optional(),
    receiptDigest: z.string().min(1).optional(),
  })
  .strict();

const failureCauseSchema = z
  .object({
    role: z.enum(["primary", "cleanup", "rollback", "transport"]),
    code: z.string().min(1),
    message: z.string().min(1),
    data: z.unknown().optional(),
  })
  .strict();

export const agentToolFailureSchema = z
  .object({
    protocol: z.literal(AGENT_TOOL_FAILURE_PROTOCOL),
    code: z.string().min(1),
    kind: z.enum(AGENT_TOOL_FAILURE_KINDS),
    message: z.string().min(1),
    operation: z.string().min(1),
    stage: z.string().min(1),
    retry: z
      .object({
        policy: z.enum(AGENT_TOOL_RETRY_POLICIES),
        commandIdPolicy: z
          .enum(["reuse-identical", "use-new-after-reobserve", "not-applicable"])
          .optional(),
        afterMs: z.number().int().nonnegative().optional(),
      })
      .strict(),
    recovery: z
      .object({
        action: z.enum(AGENT_TOOL_RECOVERY_ACTIONS),
        instruction: z.string().min(1),
      })
      .strict()
      .optional(),
    causal: causalIdsSchema.optional(),
    causes: z.array(failureCauseSchema).min(1),
    data: z.unknown().optional(),
  })
  .strict();

export type AgentToolFailure = z.infer<typeof agentToolFailureSchema>;
export type AgentToolFailureKind = AgentToolFailure["kind"];
export type AgentToolRetryPolicy = AgentToolFailure["retry"]["policy"];

export class AgentToolFailureError extends Error {
  readonly failure: AgentToolFailure;
  readonly errorData: AgentToolFailure;
  readonly code: string;

  constructor(failure: AgentToolFailure, cause?: unknown) {
    super(failure.message, cause === undefined ? undefined : { cause });
    this.name = "AgentToolFailureError";
    this.failure = agentToolFailureSchema.parse(failure);
    this.errorData = this.failure;
    this.code = this.failure.code;
  }
}

const CODE_KIND: ReadonlyArray<[RegExp, AgentToolFailureKind]> = [
  [/^EVAL_READ_ONLY\b/i, "authority"],
  [/^guest_type_error\b/i, "invalid-input"],
  // Messaging (plan §4.10.11): an addressee that could not be resolved is a
  // correctable request; a channel that refuses guests is a domain refusal the
  // agent must not retry.
  [/^ambiguous-(handle|agent|run)\b/i, "invalid-input"],
  [/^(unknown-(handle|agent|run|user|channel)|no-owner|not-a-subagent)\b/i, "not-found"],
  [/^(ClosedChannel|AddresseeUnreachable|CrossChannelDeliveryFailed)\b/, "domain"],
  [/cancel|abort|deadline|timeout/i, "cancelled"],
  [/integrity|corrupt|digest|mismatch/i, "integrity"],
  [/invalid|malformed|schema|argument|input/i, "invalid-input"],
  [/unauthor|access|acquire|approval|credential|permission|grant/i, "authority"],
  [/external.?effect|network|egress|fetch|clone|push/i, "external-effect"],
  [/revision|conflict|occupied|working.?changes|dependency.?blocked/i, "conflict"],
  [/not.?found|missing|invalid.?reference/i, "not-found"],
  [/infrastructure|runtime|dispatch|transport|unavailable|restarted/i, "infrastructure"],
];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : (nonempty(record(error)?.["message"]) ?? String(error));
}

function errorCode(error: unknown, data: Record<string, unknown> | null): string {
  return (
    nonempty(data?.["code"]) ??
    nonempty(data?.["failureCode"]) ??
    nonempty(record(error)?.["code"]) ??
    nonempty(record(error)?.["failureCode"]) ??
    "unknown_tool_failure"
  );
}

function boundedFailureData(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value);
    const bytes = new TextEncoder().encode(json).byteLength;
    if (bytes <= MAX_FAILURE_DATA_BYTES) return value;
    return {
      protocol: "agent-tool-failure-data-summary.v1",
      truncated: true,
      originalBytes: bytes,
      preview: json.slice(0, 2 * 1024),
    };
  } catch {
    return {
      protocol: "agent-tool-failure-data-summary.v1",
      truncated: true,
      originalBytes: null,
      preview: String(value).slice(0, 2 * 1024),
    };
  }
}

function kindFor(code: string, message: string): AgentToolFailureKind {
  const candidate = `${code} ${message}`;
  return CODE_KIND.find(([pattern]) => pattern.test(candidate))?.[1] ?? "unknown";
}

function authorityRemediation(data: Record<string, unknown> | null): Record<string, unknown> | null {
  const failure = record(data?.["authorityFailure"]) ?? record(data?.["failure"]);
  return record(failure?.["remediation"]);
}

function retryFor(
  kind: AgentToolFailureKind,
  data: Record<string, unknown> | null
): AgentToolFailure["retry"] {
  const explicit = record(data?.["retry"]);
  const explicitPolicy = nonempty(explicit?.["policy"]);
  const explicitCommandIdPolicy = nonempty(explicit?.["commandIdPolicy"]);
  if (
    AGENT_TOOL_RETRY_POLICIES.includes(
      explicitPolicy as (typeof AGENT_TOOL_RETRY_POLICIES)[number]
    ) &&
    (explicitCommandIdPolicy === undefined ||
      ["reuse-identical", "use-new-after-reobserve", "not-applicable"].includes(
        explicitCommandIdPolicy
      ))
  ) {
    return {
      policy: explicitPolicy as AgentToolRetryPolicy,
      ...(explicitCommandIdPolicy
        ? {
            commandIdPolicy: explicitCommandIdPolicy as NonNullable<
              AgentToolFailure["retry"]["commandIdPolicy"]
            >,
          }
        : {}),
    };
  }
  const policy = explicit?.["commandIdPolicy"];
  if (policy === "reuse-identical-only-if-outcome-uncertain") {
    return { policy: "retry-identical", commandIdPolicy: "reuse-identical" };
  }
  if (policy === "reobserve-status-and-use-new-command") {
    return { policy: "reobserve", commandIdPolicy: "use-new-after-reobserve" };
  }
  if (nonempty(authorityRemediation(data)?.["kind"]) === "use-writable-session") {
    return { policy: "correct-input", commandIdPolicy: "not-applicable" };
  }
  switch (kind) {
    case "invalid-input":
    case "not-found":
      return { policy: "correct-input", commandIdPolicy: "not-applicable" };
    case "conflict":
      return { policy: "reobserve", commandIdPolicy: "use-new-after-reobserve" };
    case "authority":
      return { policy: "request-approval", commandIdPolicy: "not-applicable" };
    case "external-effect":
      return { policy: "retry-identical", commandIdPolicy: "reuse-identical" };
    default:
      return { policy: "none", commandIdPolicy: "not-applicable" };
  }
}

function recoveryFor(
  kind: AgentToolFailureKind,
  retry: AgentToolFailure["retry"],
  data: Record<string, unknown> | null
): NonNullable<AgentToolFailure["recovery"]> {
  const explicit = record(data?.["recovery"]);
  const legacyRecovery = nonempty(data?.["recovery"]);
  const explicitAction = nonempty(explicit?.["action"]);
  const explicitInstruction =
    nonempty(explicit?.["instruction"]) ?? nonempty(data?.["remediation"]);
  const panelNextAction = nonempty(explicit?.["nextAction"]);
  if (
    explicitAction &&
    AGENT_TOOL_RECOVERY_ACTIONS.includes(
      explicitAction as (typeof AGENT_TOOL_RECOVERY_ACTIONS)[number]
    )
  ) {
    return {
      action: explicitAction as NonNullable<AgentToolFailure["recovery"]>["action"],
      instruction: explicitInstruction ?? "Follow the typed recovery action before retrying.",
    };
  }
  if (panelNextAction === "observe-and-reacquire") {
    return {
      action: "reacquire-handle",
      instruction:
        "Observe the committed panel, then reacquire its current handle before continuing.",
    };
  }
  if (panelNextAction === "repair-and-rebuild") {
    return {
      action: "repair-source",
      instruction: "Repair the panel source from its diagnostics, rebuild it, then continue.",
    };
  }
  if (legacyRecovery?.includes("reacquire-page")) {
    return {
      action: "reacquire-handle",
      instruction:
        legacyRecovery === "inspect-panel-and-reacquire-page"
          ? "Inspect the panel lifecycle, then refresh or reacquire its generation-fenced CDP session. Do not reuse the cached page."
          : "Refresh or reacquire the panel's generation-fenced CDP session. Do not reuse the cached page.",
    };
  }
  if (legacyRecovery === "reobserve-locator") {
    return {
      action: "reobserve",
      instruction: "Inspect the current DOM and form a locator from current accessible facts.",
    };
  }
  const authorityRepair = authorityRemediation(data);
  if (nonempty(authorityRepair?.["kind"]) === "use-writable-session") {
    return {
      action: "correct-request",
      instruction:
        nonempty(authorityRepair?.["message"]) ??
        'Issue a new eval with authority.effects set to "read-write"; a read-only eval cannot widen itself.',
    };
  }
  if (data?.["reason"] === "shape-drift" && Array.isArray(data["safeActions"])) {
    return {
      action: "repair-source",
      instruction:
        "The Durable Object schema changed without a new coordinated schema generation. Restore the exact compatible build, or repair the declared schema version/system epoch and recreate only explicitly disposable state; export valuable state before any reset.",
    };
  }
  switch (retry.policy) {
    case "correct-input":
      return {
        action: "correct-request",
        instruction: explicitInstruction ?? "Correct the request from newly observed facts.",
      };
    case "reobserve":
      return {
        action: "reobserve",
        instruction: explicitInstruction ?? "Re-observe current state, then issue a new command.",
      };
    case "retry-identical":
      return {
        action: "retry-identical",
        instruction:
          explicitInstruction ?? "Retry only the identical request with the same identity.",
      };
    case "request-approval":
      return {
        action: "request-approval",
        instruction:
          explicitInstruction ?? "Complete the declared authority decision before retrying.",
      };
    default:
      if (kind === "infrastructure") {
        return {
          action: "reobserve",
          instruction:
            explicitInstruction ??
            "Do not retry the failed invocation automatically. Inspect current state and the primary cause, then choose a safe recovery path.",
        };
      }
      return {
        action: "stop",
        instruction:
          explicitInstruction ?? "Do not retry automatically; inspect the primary cause.",
      };
  }
}

function secondaryCauses(data: Record<string, unknown> | null): AgentToolFailure["causes"] {
  if (!data) return [];
  const config = record(data["config"]);
  const candidates: Array<[unknown, AgentToolFailure["causes"][number]["role"]]> = [
    [data["cleanupFailure"], "cleanup"],
    [data["cleanupError"], "cleanup"],
    [data["rollbackFailure"], "rollback"],
    [config?.["rollbackFailure"], "rollback"],
    [data["transportFailure"], "transport"],
  ];
  return candidates.flatMap(([value, role]) => {
    if (value === undefined) return [];
    const detail = record(value);
    return [
      {
        role,
        code: nonempty(detail?.["code"]) ?? `${role}_failed`,
        message: nonempty(detail?.["message"]) ?? errorMessage(value),
        data: boundedFailureData(value),
      },
    ];
  });
}

export function isAgentToolFailure(value: unknown): value is AgentToolFailure {
  return agentToolFailureSchema.safeParse(value).success;
}

export function agentToolFailureFromUnknown(
  error: unknown,
  context: {
    operation: string;
    stage: string;
    causal?: AgentToolFailure["causal"];
    kind?: AgentToolFailureKind;
    retry?: AgentToolFailure["retry"];
  }
): AgentToolFailure {
  const root = record(error);
  const details = record(root?.["details"]);
  const existing =
    root?.["failure"] ??
    details?.["failure"] ??
    (isAgentToolFailure(root?.["errorData"])
      ? root?.["errorData"]
      : isAgentToolFailure(details?.["errorData"])
        ? details?.["errorData"]
        : undefined);
  if (isAgentToolFailure(existing)) {
    return {
      ...existing,
      operation: context.operation,
      stage: context.stage,
      ...(context.causal ? { causal: { ...existing.causal, ...context.causal } } : {}),
    };
  }
  const dataValue = root?.["errorData"] ?? details?.["errorData"] ?? details;
  const data = record(dataValue);
  const primaryValue = data?.["primary"];
  const primary = record(primaryValue);
  const message = primary
    ? errorMessage(primaryValue)
    : (nonempty(details?.["error"]) ?? errorMessage(error));
  const code =
    nonempty(root?.["failureCode"]) ??
    nonempty(details?.["failureCode"]) ??
    errorCode(primaryValue ?? error, primary ?? data);
  const explicitKind = nonempty(data?.["failureKind"]) ?? nonempty(details?.["failureKind"]);
  const kind =
    context.kind ??
    (AGENT_TOOL_FAILURE_KINDS.includes(
      explicitKind as (typeof AGENT_TOOL_FAILURE_KINDS)[number]
    )
      ? (explicitKind as AgentToolFailureKind)
      : kindFor(code, message));
  const retry = context.retry ?? retryFor(kind, data);
  return agentToolFailureSchema.parse({
    protocol: AGENT_TOOL_FAILURE_PROTOCOL,
    code,
    kind,
    message,
    operation: context.operation,
    stage: context.stage,
    retry,
    recovery: recoveryFor(kind, retry, data),
    ...(context.causal && Object.keys(context.causal).length > 0 ? { causal: context.causal } : {}),
    causes: [
      {
        role: "primary",
        code,
        message,
        ...(primaryValue === undefined
          ? dataValue === undefined
            ? {}
            : { data: boundedFailureData(dataValue) }
          : { data: boundedFailureData(primaryValue) }),
      },
      ...secondaryCauses(data),
    ],
    ...(dataValue === undefined ? {} : { data: boundedFailureData(dataValue) }),
  });
}

export function renderAgentToolFailure(failure: AgentToolFailure): string {
  const recovery =
    failure.retry.policy === "none"
      ? "Do not retry automatically."
      : failure.retry.policy === "retry-identical"
        ? "Retry only the identical request with the same command identity."
        : failure.retry.policy === "reobserve"
          ? "Re-observe current state, then issue a new command identity."
          : failure.retry.policy === "request-approval"
            ? "Complete the declared approval or authority repair before retrying."
            : "Correct the request from current facts before retrying.";
  const secondary = failure.causes
    .filter((cause) => cause.role !== "primary")
    .map((cause) => `${cause.role}: ${cause.code}: ${cause.message}`);
  return [
    `[${failure.operation}:${failure.stage}] ${failure.code}: ${failure.message}`,
    failure.recovery?.instruction ?? recovery,
    ...secondary,
  ].join("\n");
}
