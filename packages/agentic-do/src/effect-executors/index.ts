import {
  CREDENTIAL_CONNECT_PAYLOAD_KIND,
  agentToolFailureFromUnknown,
  createAgentToolArtifactRef,
  renderAgentToolFailure,
} from "@workspace/agentic-protocol";
/**
 * Effect executors (WS1 §2.4) — the impure edge of the event-sourced harness.
 *
 * Each executor consumes a pure EffectDescriptor and produces an
 * EffectOutcome (or a typed deferral naming the durable wake path that will
 * make the effect runnable again). Terminal mapping back to events is the pure
 * `outcomeEvents` in @workspace/agent-loop.
 */

import type {
  ChannelCallEffect,
  CredentialWaitEffect,
  EffectDescriptor,
  EffectOutcome,
  HttpCallEffect,
  LocalToolEffect,
  PromptArtifactsEffect,
  RecordReceiptEffect,
} from "@workspace/agent-loop";
import { modelCallExecutor } from "./model-call.js";
import type { EffectExecutor } from "./types.js";

export * from "./types.js";
export {
  modelCallExecutor,
  modelTransportRuntimeEvidence,
  toProtocolBlocks,
} from "./model-call.js";

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function turnControlFromToolResult(
  result: unknown,
): Extract<EffectOutcome, { kind: "tool" }>["turnControl"] {
  const details = objectValue(objectValue(result)?.["details"]);
  if (details?.["suspendTurn"] !== true) return undefined;
  const reason =
    typeof details["reason"] === "string" && details["reason"].trim()
      ? details["reason"].trim()
      : "no_foreground_work";
  const note =
    typeof details["noteToSelf"] === "string" && details["noteToSelf"].trim()
      ? details["noteToSelf"].trim()
      : undefined;
  // Only a concrete outstanding background dependency keeps a turn open.
  // The other suspend_turn reasons mean that this invocation has no more work
  // to perform; retaining an open turn for them leaks execution ownership into
  // an unrelated future input and prevents finite workflow parents from
  // observing completion.
  if (reason !== "waiting_for_background") {
    return { kind: "terminate" };
  }
  return {
    kind: "suspend",
    reason,
    summary:
      note ??
      (reason === "waiting_for_background"
        ? "Suspended until background work or user input arrives"
        : "Suspended until new relevant input arrives"),
  };
}

const MAX_MODEL_TOOL_RESULT_CHARS = 32_000;
const TOOL_ARTIFACT_THRESHOLD_BYTES = 48 * 1024;

function resultRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function attachFailureToResult(
  result: unknown,
  failure: ReturnType<typeof agentToolFailureFromUnknown>,
) {
  const record = resultRecord(result);
  if (!record) {
    return {
      protocolContent: [
        { type: "text", text: renderAgentToolFailure(failure) },
      ],
      details: { failure, originalResult: result },
    };
  }
  const details = resultRecord(record["details"]);
  return { ...record, details: { ...(details ?? {}), failure } };
}

function windowToolText(text: string): string {
  if (text.length <= MAX_MODEL_TOOL_RESULT_CHARS) return text;
  const notice =
    `\n[Tool result compacted: ${text.length - MAX_MODEL_TOOL_RESULT_CHARS} of ` +
    `${text.length} characters are available in the attached artifact.]\n`;
  const available = Math.max(0, MAX_MODEL_TOOL_RESULT_CHARS - notice.length);
  const head = Math.floor(available * 0.75);
  return `${text.slice(0, head)}${notice}${text.slice(-(available - head))}`;
}

async function artifactBackedToolResult(
  result: unknown,
  tool: string,
  invocationId: string,
  blobstore: {
    putText(value: string): Promise<{ digest: string; size: number }>;
  },
): Promise<unknown> {
  let json: string;
  try {
    json = JSON.stringify(result);
  } catch {
    return result;
  }
  const record = resultRecord(result);
  const blocks = Array.isArray(record?.["protocolContent"])
    ? (record!["protocolContent"] as unknown[])
    : [];
  const textChars = blocks.reduce<number>(
    (total, block) =>
      total +
      (resultRecord(block)?.["type"] === "text" &&
      typeof resultRecord(block)?.["text"] === "string"
        ? String(resultRecord(block)?.["text"]).length
        : 0),
    0,
  );
  const bytes = new TextEncoder().encode(json).byteLength;
  if (
    bytes <= TOOL_ARTIFACT_THRESHOLD_BYTES &&
    textChars <= MAX_MODEL_TOOL_RESULT_CHARS
  ) {
    return result;
  }
  const stored = await blobstore.putText(json);
  const artifact = createAgentToolArtifactRef({
    digest: stored.digest,
    byteLength: stored.size,
    description: `Complete ${tool} result for invocation ${invocationId}`,
  });
  const compactBlocks = blocks.map((block) => {
    const value = resultRecord(block);
    return value?.["type"] === "text" && typeof value["text"] === "string"
      ? { ...value, text: windowToolText(value["text"]) }
      : block;
  });
  compactBlocks.push({
    type: "text",
    text:
      `Full structured result: ${artifact.uri} (${artifact.byteLength} bytes). ` +
      "Pass the resource object from details.artifact to read for bounded access.",
  });
  const details = resultRecord(record?.["details"]);
  return {
    ...(record ?? {}),
    protocolContent: compactBlocks,
    details: { ...(details ?? {}), artifact },
  };
}

/** local_tool (§2.4.2): registry execution with the mutation-replay guard. */
export const localToolExecutor: EffectExecutor<LocalToolEffect> = {
  kind: "local_tool",
  async execute({ descriptor, state, signal, deps, onEphemeral }) {
    // §1.4.2 retry rule: a mutating tool whose applied worktree mutation is
    // already folded synthesizes success instead of re-executing.
    const replayEvidence = await deps.localTools.alreadyApplied(
      state,
      descriptor.invocationId,
    );
    if (replayEvidence) {
      return {
        kind: "tool",
        result: {
          protocolContent: [
            {
              type: "text",
              text: `Recovered completed workspace mutation ${replayEvidence.commandId}; it was not executed twice.`,
            },
          ],
          details: { replayed: true, evidence: replayEvidence },
        },
        summary: "Recovered a completed workspace mutation",
        isError: false,
      } satisfies EffectOutcome;
    }
    try {
      const outcome = await deps.localTools.run({
        channelId: descriptor.channelId,
        tool: descriptor.tool,
        invocationId: descriptor.invocationId,
        args: descriptor.args,
        signal,
        onProgress: (chunk) =>
          onEphemeral({
            kind: "signal-event",
            channelId: descriptor.channelId,
            event: {
              kind: "invocation.progress",
              actor: deps.selfRef,
              causality: { invocationId: descriptor.invocationId as never },
              payload: { protocol: "agentic.trajectory.v1", data: chunk },
              createdAt: new Date().toISOString(),
            } as never,
          }),
      });
      // A deferred local tool (eval) parks: the driver keeps the leased row (deferRedrive backstop)
      // and the result arrives via deliverEffectOutcome (onEvalComplete) — NOT wrapped in kind:"tool".
      if ("deferred" in outcome && outcome.deferred) {
        return { deferred: true, reason: "external-result" };
      }
      const toolOutcome = outcome as {
        result: unknown;
        summary?: string;
        isError: boolean;
        terminate?: boolean;
        terminalReasonCode?: string;
        failure?: ReturnType<typeof agentToolFailureFromUnknown>;
      };
      const failure = toolOutcome.isError
        ? (toolOutcome.failure ??
          agentToolFailureFromUnknown(toolOutcome.result, {
            operation: `tool.${descriptor.tool}`,
            stage: signal.aborted ? "cancel" : "execute",
            causal: { invocationId: descriptor.invocationId },
            ...(signal.aborted ? { kind: "cancelled" as const } : {}),
          }))
        : undefined;
      const resultWithFailure = failure
        ? attachFailureToResult(toolOutcome.result, failure)
        : toolOutcome.result;
      const boundedResult = await artifactBackedToolResult(
        resultWithFailure,
        descriptor.tool,
        descriptor.invocationId,
        deps.blobstore,
      );
      const turnControl = toolOutcome.isError
        ? undefined
        : toolOutcome.terminate === true
          ? ({ kind: "terminate" } as const)
          : turnControlFromToolResult(toolOutcome.result);
      return {
        kind: "tool",
        ...toolOutcome,
        result: boundedResult,
        ...(failure
          ? {
              failure,
              reason: failure.message,
              terminalReasonCode: failure.code,
            }
          : {}),
        ...(turnControl ? { turnControl } : {}),
      } satisfies EffectOutcome;
    } catch (err) {
      const failure = agentToolFailureFromUnknown(err, {
        operation: `tool.${descriptor.tool}`,
        stage: signal.aborted ? "cancel" : "execute",
        causal: { invocationId: descriptor.invocationId },
        ...(signal.aborted ? { kind: "cancelled" as const } : {}),
      });
      return {
        kind: "tool",
        result: {
          protocolContent: [
            { type: "text", text: renderAgentToolFailure(failure) },
          ],
          details: { failure },
        },
        isError: true,
        reason: failure.message,
        terminalReasonCode: failure.code,
        failure,
      } satisfies EffectOutcome;
    }
  },
};

export const promptArtifactsExecutor: EffectExecutor<PromptArtifactsEffect> = {
  kind: "prompt_artifacts",
  async execute({ descriptor, signal, deps }) {
    if (!deps.promptArtifacts) {
      throw new Error("prompt artifact preparation is unavailable");
    }
    const patch = await deps.promptArtifacts.prepare(
      descriptor.channelId,
      signal,
    );
    return { kind: "prompt-artifacts", patch } satisfies EffectOutcome;
  },
};

/** channel_call (§2.4.3): journaled call through the channel DO; the result
 *  arrives via the channel's terminal delivery → deliverEffectOutcome. */
export const channelCallExecutor: EffectExecutor<ChannelCallEffect> = {
  kind: "channel_call",
  async execute({ descriptor, deps }) {
    await deps.channel.callMethod({
      channelId: descriptor.channelId,
      targetParticipantId:
        (descriptor.target as { participantId?: string }).participantId ??
        descriptor.target.id,
      transportCallId: descriptor.transportCallId,
      method: descriptor.method,
      args: descriptor.args,
      invocationId: descriptor.invocationId,
      ...(descriptor.turnId ? { turnId: descriptor.turnId } : {}),
      ...(descriptor.timeoutMs ? { timeoutMs: descriptor.timeoutMs } : {}),
    });
    // The channel DO settles the call durably (terminal:{transportCallId});
    // the driver maps that delivery to this effect's outcome.
    return { deferred: true, reason: "external-result" };
  },
};

/** http_call (§2.4.4): idempotency-keyed server POST with a callback address —
 *  subsumes the deferred-RPC layer. */
export const httpCallExecutor: EffectExecutor<HttpCallEffect> = {
  kind: "http_call",
  async execute({ descriptor, deps }) {
    const response = await deps.http.post({
      ...(descriptor.targetUrl ? { targetUrl: descriptor.targetUrl } : {}),
      ...(descriptor.target ? { target: descriptor.target } : {}),
      idempotencyKey: descriptor.idempotencyKey,
      request: descriptor.request,
      effectId: descriptor.effectId,
      callback: { ...deps.callbackAddress, method: "deliverEffectOutcome" },
    });
    if (response.deferred) return response;
    return {
      kind: "tool",
      result: response.result,
      isError: response.isError,
    } satisfies EffectOutcome;
  },
};

/** credential_wait (§2.4.5): publish the connect card + register interest.
 *  Resolution funnels into deliverEffectOutcome; expiry is the outbox
 *  next_attempt_at deadline. */
export const credentialWaitExecutor: EffectExecutor<CredentialWaitEffect> = {
  kind: "credential_wait",
  async execute({ descriptor, deps }) {
    await deps.channel.publish({
      channelId: descriptor.channelId,
      payloadKind: CREDENTIAL_CONNECT_PAYLOAD_KIND,
      payload: {
        credKey: descriptor.credKey,
        providerId: descriptor.providerId,
        connectSpec: descriptor.connectSpec,
        ...(descriptor.modelBaseUrl
          ? { modelBaseUrl: descriptor.modelBaseUrl }
          : {}),
        ...(descriptor.waitReason ? { waitReason: descriptor.waitReason } : {}),
        ...(descriptor.reason ? { reason: descriptor.reason } : {}),
        ...(descriptor.failureCode
          ? { failureCode: descriptor.failureCode }
          : {}),
        expiresAt: descriptor.expiresAt,
      },
      // Include the occurrence discriminator (startedAtSeq) so a LATER wait for
      // the same credKey publishes a fresh card instead of replaying the first
      // (stale/expired) card via the channel's durable dedup_keys table.
      idempotencyKey: `credcard:${descriptor.credKey}:${descriptor.startedAtSeq}`,
    });
    await deps.credentials.registerCredentialInterest({
      credKey: descriptor.credKey,
      providerId: descriptor.providerId,
      effectId: descriptor.effectId,
      expiresAt: descriptor.expiresAt,
    });
    return { deferred: true, reason: "external-result" };
  },
};

/** Receipt projection update: durable and idempotent, never a channel append. */
export const receiptExecutor: EffectExecutor<RecordReceiptEffect> = {
  kind: "record_receipt",
  async execute({ descriptor, deps }) {
    await deps.channel.recordReadReceipt({
      channelId: descriptor.channelId,
      messageId: descriptor.messageId,
      turnId: descriptor.turnId,
    });
    return {
      kind: "tool",
      result: null,
      isError: false,
    } satisfies EffectOutcome;
  },
};

export function executorFor(descriptor: EffectDescriptor): EffectExecutor {
  switch (descriptor.kind) {
    case "prompt_artifacts":
      return promptArtifactsExecutor as EffectExecutor;
    case "model_call":
      return modelCallExecutor as EffectExecutor;
    case "local_tool":
      return localToolExecutor as EffectExecutor;
    case "channel_call":
      return channelCallExecutor as EffectExecutor;
    case "http_call":
      return httpCallExecutor as EffectExecutor;
    case "credential_wait":
      return credentialWaitExecutor as EffectExecutor;
    case "record_receipt":
      return receiptExecutor as EffectExecutor;
  }
}
