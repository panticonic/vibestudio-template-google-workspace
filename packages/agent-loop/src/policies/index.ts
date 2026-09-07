/**
 * Step policies (WS1 §1.6) — pure interceptors over the core step output.
 * Fixed compose order: channel-tools → approval-gate → ask-user → fork →
 * (consumer extras) → compaction.
 */

import {
  AGENTIC_PROTOCOL_VERSION,
  isHandleResolutionFailure,
  resolveHandle,
  type ParticipantRef,
} from "@workspace/agentic-protocol";
import { ids } from "../ids.js";
import {
  askUserFanoutCallId,
  askUserFanoutEffectId,
  type AppendItem,
  type ChannelCallEffect,
  type EffectDescriptor,
} from "../effects.js";
import type { StepPolicy } from "../step.js";
import type { AgentState, RosterEntry } from "../state.js";

type AskUserParticipant = Pick<RosterEntry, "participantId" | "ref" | "handle">;

export const DEFAULT_SAFE_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "ask_user",
  "set_title",
  "suspend_turn",
]);

/** channel-tools: route roster participant methods over the channel transport. */
export function channelToolsPolicy(): StepPolicy {
  return {
    name: "channel-tools",
    intercept({ state, output }) {
      const methodOwners = new Map<string, ParticipantRef>();
      const capturedOwners = state.openTurn?.activeModelRequest?.channelToolOwners;
      if (capturedOwners) {
        for (const [name, owner] of Object.entries(capturedOwners)) {
          methodOwners.set(name, owner);
        }
      } else {
        for (const participant of state.config.roster?.participants ?? []) {
          for (const method of participant.methods ?? []) {
            if (!methodOwners.has(method.name)) methodOwners.set(method.name, participant.ref);
          }
        }
      }
      if (methodOwners.size === 0) return output;
      let changed = false;
      const append = output.append.map((item) => {
        if (item.payloadKind !== "invocation.started") return item;
        const payload = item.payload as Record<string, unknown>;
        const name = String(payload["name"] ?? "");
        const transport = payload["transport"] as { kind?: string } | undefined;
        const owner = methodOwners.get(name);
        if (!owner || transport?.kind !== "local") return item;
        const invocationId = String(
          (item.causality as { invocationId?: string } | undefined)?.invocationId ?? ""
        );
        changed = true;
        return {
          ...item,
          payload: {
            ...payload,
            invocationType: "panel",
            transport: {
              kind: "channel",
              channelId: state.channelId,
              target: owner,
              transportCallId: ids.transportCallId(invocationId),
            },
          },
        };
      });
      if (!changed) return output;
      // effects re-derive from the rewritten payloads
      const effects = output.effects.map((effect) => {
        if (effect.kind !== "local_tool") return effect;
        const rewritten = append.find(
          (item) =>
            item.payloadKind === "invocation.started" &&
            String((item.causality as { invocationId?: string })?.invocationId) ===
              effect.invocationId &&
            (item.payload as { transport?: { kind?: string } }).transport?.kind === "channel"
        );
        if (!rewritten) return effect;
        const payload = rewritten.payload as Record<string, unknown>;
        const transport = payload["transport"] as {
          target: ParticipantRef;
          transportCallId: string;
        };
        const channelEffect: ChannelCallEffect = {
          effectId: effect.effectId,
          kind: "channel_call",
          channelId: effect.channelId,
          idempotencyKey: transport.transportCallId,
          invocationId: effect.invocationId,
          turnId: effect.turnId,
          transportCallId: transport.transportCallId,
          target: transport.target,
          method: String(payload["name"]),
          args: payload["request"],
        };
        return channelEffect;
      });
      return { append, effects };
    },
  };
}

/** approval-gate: today's toolNeedsApproval rule as a pure rewrite. */
export function approvalGatePolicy(): StepPolicy {
  return {
    name: "approval-gate",
    intercept({ state, ctx, output }) {
      const level = state.config.approvalLevel;
      if (level === 2) return output;
      const gatedIds = new Set<string>();
      const append: AppendItem[] = [];
      for (const item of output.append) {
        append.push(item);
        if (item.payloadKind !== "invocation.started") continue;
        const payload = item.payload as Record<string, unknown>;
        const name = String(payload["name"] ?? "");
        if (level === 1 && DEFAULT_SAFE_TOOL_NAMES.has(name)) continue;
        const invocationId = String(
          (item.causality as { invocationId?: string } | undefined)?.invocationId ?? ""
        );
        const approvalId = ids.approvalId(invocationId);
        gatedIds.add(invocationId);
        // mark the started payload as approval-gated
        append[append.length - 1] = {
          ...item,
          payload: { ...payload, requiresApproval: true },
        };
        append.push({
          envelopeId: ids.approvalRequested(approvalId),
          payloadKind: "approval.requested",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            question: approvalQuestion(name, payload["request"]),
            requestedBy: ctx.selfRef,
            details: { toolName: name, input: payload["request"] },
          },
          causality: {
            approvalId: approvalId as never,
            invocationId: invocationId as never,
            modelToolCallId: invocationId,
            turnId: (item.causality as { turnId?: string } | undefined)?.turnId,
          },
          publish: true,
        });
      }
      if (gatedIds.size === 0) return output;
      // the gated tools' dispatch effects become derivable only after grant;
      // the approval form effect is derived by the reconcile (or here).
      const effects = output.effects.filter(
        (effect) =>
          !(
            (effect.kind === "local_tool" ||
              effect.kind === "channel_call" ||
              effect.kind === "http_call") &&
            gatedIds.has(effect.invocationId)
          )
      );
      return { append, effects };
    },
  };
}

function approvalQuestion(toolName: string, request: unknown): string {
  const input = request && typeof request === "object" ? (request as Record<string, unknown>) : {};
  const target = ["path", "filePath", "command", "url", "query"]
    .map((key) => input[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const friendlyName = toolName || "this tool";
  return target
    ? `Allow ${friendlyName} to act on “${target.length > 120 ? `${target.slice(0, 117)}…` : target}”?`
    : `Allow the ${friendlyName} tool?`;
}

/** Extract an explicit target hint from ask_user args (`to`/`target`; string or
 *  first string of an array). Absent/blank ⇒ unaddressed. */
function askUserTargetHint(raw: unknown): string | undefined {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  for (const key of ["to", "target"]) {
    const value = input[key];
    const first = Array.isArray(value) ? value.find((v) => typeof v === "string") : value;
    if (typeof first === "string" && first.trim()) return first.trim();
  }
  return undefined;
}

/** Resolve a target hint (`@handle`, bare handle, or `user:<id>`) to a human
 *  roster participant through the SHARED resolver (messaging plan §4.2.1), so
 *  `ask_user` and `notify` cannot disagree about what a handle means. The
 *  `kinds` filter keeps ask_user human-only; ambiguity fails closed there
 *  rather than being tie-broken by roster order here. */
function resolveAskUserTarget(
  humans: AskUserParticipant[],
  hint: string
): AskUserParticipant | undefined {
  const mention = hint.startsWith("@") ? hint.slice(1) : hint;
  // The loop keeps the handle and participant id beside the ref, so lift both
  // in before resolving — otherwise a handle-only hint never matches.
  const refs: ParticipantRef[] = humans.map((entry) => ({
    ...entry.ref,
    participantId: entry.ref.participantId ?? entry.participantId,
    ...(entry.handle ? { metadata: { ...(entry.ref.metadata ?? {}), handle: entry.handle } } : {}),
  }));
  const resolved = resolveHandle(mention, refs, { kinds: ["user"] });
  if (isHandleResolutionFailure(resolved)) return undefined;
  const index = refs.indexOf(resolved);
  // Hand back the original entry: the normalized copy exists only for matching,
  // and the transport target must stay the roster's canonical ref.
  return index >= 0 ? humans[index] : undefined;
}

/** ask-user: rewrite ask_user invocations to a channel feedback_form call.
 *  Multi-human aware (WP7 §5): an explicitly addressed ask (`to`/`target` =
 *  handle, `@mention`, or `user:<id>`) routes to that user's participant only;
 *  an unaddressed ask broadcasts to ALL human participants (ref.kind ===
 *  "user"), first answer wins — the invocation terminal is keyed by
 *  invocationId, so the first answer settles it and sibling calls are cancelled.
 *  With no canonical human on the roster, the local ask_user tool fails closed. */
export function askUserPolicy(): StepPolicy {
  return {
    name: "ask-user",
    intercept({ state, output }) {
      // Use the same model-bound participant snapshot as channel tool routing.
      // Presence may change while a model request is in flight; interpreting
      // the returned tool call against a later roster makes execution depend
      // on transport timing. The live-roster fallback reads historical
      // message.started events written before askUserParticipants existed.
      const capturedHumans = state.openTurn?.activeModelRequest?.askUserParticipants;
      const humans: AskUserParticipant[] =
        capturedHumans ??
        (state.config.roster?.participants ?? []).filter(
          (participant) => participant.ref.kind === "user"
        );
      if (humans.length === 0) return output;
      // invocationId → ordered fan-out targets (first is the payload transport
      // target and keeps the canonical ids).
      const rewrittenIds = new Map<string, ParticipantRef[]>();
      const targetsFor = (request: unknown): ParticipantRef[] => {
        const hint = askUserTargetHint(request);
        const addressed = hint ? resolveAskUserTarget(humans, hint) : undefined;
        if (addressed) return [addressed.ref];
        // An explicit but unknown addressee must never broaden into a broadcast.
        if (hint) return [];
        return humans.map((entry) => entry.ref);
      };
      const append = output.append.map((item) => {
        if (item.payloadKind !== "invocation.started") return item;
        const payload = item.payload as Record<string, unknown>;
        if (payload["name"] !== "ask_user") return item;
        // `question` is required by the ask_user tool schema. Do not turn a
        // malformed model call into a generic user-facing form: rewriting it
        // here would bypass the normal local-tool argument validation and
        // leave the user staring at a meaningless "Question" prompt.
        const request = payload["request"];
        const question =
          request && typeof request === "object" && !Array.isArray(request)
            ? (request as Record<string, unknown>)["question"]
            : undefined;
        if (
          !request ||
          typeof request !== "object" ||
          Array.isArray(request) ||
          typeof question !== "string" ||
          !question.trim()
        ) {
          return item;
        }
        const invocationId = String(
          (item.causality as { invocationId?: string } | undefined)?.invocationId ?? ""
        );
        const targets = targetsFor(request);
        if (targets.length === 0) return item;
        rewrittenIds.set(invocationId, targets);
        return {
          ...item,
          payload: {
            ...payload,
            name: "feedback_form",
            invocationType: "user",
            request: feedbackFormArgsFromAskUser(request),
            askUserTargets: targets,
            transport: {
              kind: "channel",
              channelId: state.channelId,
              target: targets[0],
              transportCallId: ids.transportCallId(invocationId),
            },
          },
        };
      });
      if (rewrittenIds.size === 0) return output;
      const effects = output.effects.flatMap((effect): EffectDescriptor[] => {
        if (effect.kind !== "local_tool" || !rewrittenIds.has(effect.invocationId)) {
          return [effect];
        }
        const targets = rewrittenIds.get(effect.invocationId)!;
        const args = feedbackFormArgsFromAskUser(effect.args);
        return targets.map((target, index): EffectDescriptor => {
          const callId =
            index === 0
              ? ids.transportCallId(effect.invocationId)
              : askUserFanoutCallId(effect.invocationId, target);
          return {
            effectId:
              index === 0 ? effect.effectId : askUserFanoutEffectId(effect.invocationId, target),
            kind: "channel_call",
            channelId: effect.channelId,
            idempotencyKey: callId,
            invocationId: effect.invocationId,
            turnId: effect.turnId,
            transportCallId: callId,
            target,
            method: "feedback_form",
            args,
            purpose: "ask-user",
          };
        });
      });
      return { append, effects };
    },
  };
}

function feedbackFormArgsFromAskUser(raw: unknown): Record<string, unknown> {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const question =
    typeof input["question"] === "string" && input["question"].trim()
      ? input["question"]
      : "Question";
  const options = Array.isArray(input["options"])
    ? input["options"].filter((option): option is string => typeof option === "string")
    : [];
  if (options.length > 0) {
    const allowFreeText = input["allowFreeform"] === false ? false : undefined;
    const multiSelect = input["multiSelect"] === true;
    return {
      title: question,
      fields: [
        {
          key: "answer",
          type: multiSelect ? "multiSelect" : "select",
          label: question,
          required: true,
          options: options.map((option) => ({ value: option, label: option })),
          ...(allowFreeText === false ? { allowFreeText } : {}),
          ...(multiSelect ? {} : { submitOnSelect: input["allowFreeform"] !== true }),
        },
      ],
      hideSubmit: multiSelect ? false : input["allowFreeform"] !== true,
    };
  }
  return {
    title: question,
    fields: [{ key: "answer", type: "string", label: question, required: true }],
  };
}

/** fork: on wake, settle every pre-cut pending under the forked head. */
export function forkPolicy(): StepPolicy {
  return {
    name: "fork",
    intercept({ state, incoming, output }) {
      if (incoming.type !== "command" || incoming.command.kind !== "wake") return output;
      if (state.forkSeq <= 0) return output;
      const append: AppendItem[] = [...output.append];
      const preCut = <T extends { startedAtSeq: number }>(record: Record<string, T>) =>
        Object.values(record).filter((item) => item.startedAtSeq <= state.forkSeq);
      for (const invocation of preCut(state.pendingInvocations)) {
        append.push({
          envelopeId: ids.invocationTerminal(invocation.invocationId),
          payloadKind: "invocation.abandoned",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            reason: "forked",
            terminalOutcome: "abandoned",
            terminalReasonCode: "forked",
          },
          causality: {
            invocationId: invocation.invocationId as never,
            turnId: invocation.turnId,
          },
          publish: true,
        });
      }
      for (const approval of preCut(state.pendingApprovals)) {
        append.push({
          envelopeId: ids.approvalResolved(approval.approvalId),
          payloadKind: "approval.resolved",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            granted: false,
            resolvedBy: { kind: "system", id: "fork" },
            reason: "forked",
          },
          causality: {
            approvalId: approval.approvalId as never,
            invocationId: approval.invocationId as never,
            turnId: approval.turnId,
          },
          publish: true,
        });
      }
      for (const wait of preCut(state.pendingCredentialWaits)) {
        append.push({
          envelopeId: ids.systemEvent(wait.credKey, "resolved", wait.startedAtSeq),
          payloadKind: "system.event",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            kind: "credential.wait_resolved",
            credKey: wait.credKey,
            details: {
              kind: "credential.wait_resolved",
              credKey: wait.credKey,
              providerId: wait.providerId,
              resolved: false,
              reason: "forked",
            },
          },
          causality: { turnId: wait.turnId },
          publish: true,
        });
      }
      if (state.openTurn && state.openTurn.openedAtSeq <= state.forkSeq) {
        append.push({
          envelopeId: ids.turnClosed(state.openTurn.turnId),
          payloadKind: "turn.closed",
          payload: { protocol: AGENTIC_PROTOCOL_VERSION, reason: "forked" },
          causality: { turnId: state.openTurn.turnId },
          publish: true,
        });
        // a wake-generated model_call for the pre-cut turn must not survive
        const effects = output.effects.filter((effect) => effect.kind !== "model_call");
        return { append, effects };
      }
      return { append, effects: output.effects };
    },
  };
}

/** The one reader of the notify-only publish discipline. `"say-only"` is the
 *  frozen legacy spelling of the same value (plan §4.3): it appears in
 *  checked-in agent configs, so it is normalized on read rather than migrated
 *  — a rename that invalidates existing manifests buys nothing. */
export function isNotifyOnlyPolicy(policy: string | undefined): boolean {
  return policy === "notify-only" || policy === "say-only";
}

/** publish-policy: config-driven channel publication discipline. Reads
 *  `state.config.publishPolicy` and gates the `publish` flag across every
 *  publication surface — step-produced appends (`intercept`), driver-produced
 *  effect-outcome appends (`transformAppend`, load-bearing: the model's
 *  `message.completed` is driver-produced), and executor-side streaming signals
 *  (`filterEphemeral`). Replay-pure: reads only `state.config` + item shape (no
 *  wall clock) and flips ONLY the `publish` flag — it never drops or mutates an
 *  item's identity/payload, so the durable trajectory stays policy-agnostic.
 *
 *  "all" (or absent): identity — every outcome publishes (today's behavior).
 *  "turn-final": only the end-of-turn (tier "primary") model message publishes;
 *    the intermediate model surfaces (every `message.started` streaming
 *    placeholder + any secondary-tier `message.completed`/`message.failed`) stay
 *    trajectory-only (live viewers still see them via the KEPT ephemeral deltas).
 *    Turn boundaries + invocation/approval/system outcomes still publish.
 *  "notify-only" (alias: the frozen legacy spelling "say-only"): nothing
 *    publishes but turn open/close; the agent speaks only via its explicit
 *    `notify` tool (published out-of-band, bypassing this filter) and all
 *    ephemeral signals are dropped. (Exactly the old silentPolicy behavior.) */
export function publishPolicyPolicy(): StepPolicy {
  const notifyOnly = (items: AppendItem[]): AppendItem[] =>
    items.map((item) =>
      item.payloadKind === "turn.opened" || item.payloadKind === "turn.closed"
        ? item
        : { ...item, publish: false }
    );
  const turnFinal = (items: AppendItem[]): AppendItem[] =>
    items.map((item) => {
      if (item.payloadKind === "message.started") return { ...item, publish: false };
      if (
        (item.payloadKind === "message.completed" || item.payloadKind === "message.failed") &&
        (item.payload as { tier?: string }).tier === "secondary"
      )
        return { ...item, publish: false };
      return item;
    });
  const filterFor = (state: AgentState): ((items: AppendItem[]) => AppendItem[]) | null => {
    if (isNotifyOnlyPolicy(state.config.publishPolicy)) return notifyOnly;
    return state.config.publishPolicy === "turn-final" ? turnFinal : null;
  };
  return {
    name: "publish-policy",
    intercept({ state, output }) {
      const filter = filterFor(state);
      if (!filter) return output;
      return { append: filter(output.append), effects: output.effects };
    },
    transformAppend({ state, items }) {
      const filter = filterFor(state);
      return filter ? filter(items) : items;
    },
    filterEphemeral({ state, emit }) {
      // notify-only suppresses all streaming signals; turn-final + all keep them.
      return isNotifyOnlyPolicy(state.config.publishPolicy) ? null : emit;
    },
  };
}

export function defaultPolicies(): StepPolicy[] {
  return [
    channelToolsPolicy(),
    approvalGatePolicy(),
    askUserPolicy(),
    forkPolicy(),
    publishPolicyPolicy(),
  ];
}
