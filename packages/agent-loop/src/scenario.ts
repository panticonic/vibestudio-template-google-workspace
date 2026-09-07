/**
 * Pure scenario harness (WS1 §4.1). Maintains state by folding each step's
 * append — no I/O anywhere. Simulated executor results enter via `outcome`
 * steps; the harness runs `outcomeEvents` + fold + the follow-up step exactly
 * like the driver would.
 */

import type { LogEnvelope } from "@workspace/agentic-protocol";
import type { Incoming, StepContext } from "./commands.js";
import {
  derivePendingEffects,
  outcomeEvents,
  type AppendItem,
  type EffectDescriptor,
  type EffectOutcome,
} from "./effects.js";
import { applyEvent } from "./fold.js";
import { composeStep, type StepFn, type StepPolicy } from "./step.js";
import type { AgentState } from "./state.js";

export interface ScenarioEnvelopeRecord {
  seq: number;
  envelopeId: string;
  payloadKind: string;
  payload: unknown;
  causality?: unknown;
  publish?: boolean;
}

export interface Scenario {
  state: AgentState;
  log: ScenarioEnvelopeRecord[];
  effects: Map<string, EffectDescriptor>;
  /** every step output, in order (for assertions). */
  outputs: Array<{ append: AppendItem[]; effects: EffectDescriptor[] }>;
  ctx: StepContext;
  step: StepFn;
  policies: StepPolicy[];
}

export function createScenario(input: {
  state: AgentState;
  policies?: StepPolicy[];
  now?: string;
}): Scenario {
  let counter = 0;
  return {
    state: input.state,
    log: [],
    effects: new Map(),
    outputs: [],
    ctx: {
      now: input.now ?? "2026-05-20T12:00:00.000Z",
      random: () => `r${(counter += 1)}`,
      selfRef: { kind: "agent", id: "agent:self", participantId: "agent:self" },
    },
    step: composeStep(input.policies ?? []),
    policies: input.policies ?? [],
  };
}

/** Append items to the scenario log (deterministic synthetic hashes) and
 *  fold them. Mirrors the driver's append + fold advance. */
export function applyAppend(scenario: Scenario, append: AppendItem[]): LogEnvelope[] {
  const envelopes: LogEnvelope[] = [];
  for (const item of append) {
    // lineage-scoped idempotent replay: identical envelopeId is a no-op
    if (scenario.log.some((row) => row.envelopeId === item.envelopeId)) continue;
    const seq = scenario.state.lastSeq + 1;
    const envelope = {
      logId: scenario.state.logId,
      head: scenario.state.head,
      seq,
      envelopeId: item.envelopeId,
      actor: scenario.ctx.selfRef,
      payloadKind: item.payloadKind,
      payload: item.payload,
      ...(item.causality ? { causality: item.causality } : {}),
      appendedAt: scenario.ctx.now,
      prevHash: scenario.state.lastHash,
      hash: `h:${scenario.state.logId}:${seq}`,
    } as unknown as LogEnvelope;
    scenario.log.push({
      seq,
      envelopeId: item.envelopeId,
      payloadKind: item.payloadKind,
      payload: item.payload,
      causality: item.causality,
      publish: item.publish,
    });
    scenario.state = applyEvent(scenario.state, envelope);
    envelopes.push(envelope);
  }
  return envelopes;
}

function registerEffects(scenario: Scenario, emitted: EffectDescriptor[]): void {
  // The harness mirrors the driver's post-step reconcile: the registry is
  // ALWAYS rebuilt from `derivePendingEffects(fold(log))` (the authority);
  // step-emitted effects are validated as a subset (P2 invariant) and serve
  // only as the latency path in a real driver.
  const derived = derivePendingEffects(scenario.state);
  const derivable = new Set(derived.map((effect) => effect.effectId));
  for (const effect of emitted) {
    // Read projection updates are emitted at the exact model-visibility
    // boundary and committed to the durable outbox with that step. They are
    // intentionally not reconstructed from later folded model state.
    if (effect.kind === "record_receipt") continue;
    if (!derivable.has(effect.effectId)) {
      throw new Error(
        `step emitted effect ${effect.effectId} that is not derivable from the folded state ` +
          `(violates the P2 reconstructibility invariant)`
      );
    }
  }
  scenario.effects = new Map(derived.map((effect) => [effect.effectId, effect]));
}

/** Run one incoming through step → append → fold → register effects, then
 *  feed each appended envelope back through step (event-appended cascade),
 *  exactly like the driver. */
export function dispatch(scenario: Scenario, incoming: Incoming): void {
  const output = scenario.step(scenario.state, incoming, scenario.ctx);
  scenario.outputs.push(output);
  const envelopes = applyAppend(scenario, output.append);
  registerEffects(scenario, output.effects);
  for (const envelope of envelopes) {
    dispatch(scenario, { type: "event-appended", envelope });
  }
}

/** Resolve a pending effect with a simulated executor outcome. */
export function resolveEffect(
  scenario: Scenario,
  effectId: string,
  outcome: EffectOutcome
): void {
  const descriptor = scenario.effects.get(effectId);
  if (!descriptor) throw new Error(`no pending effect ${effectId}`);
  let items = outcomeEvents(descriptor, outcome, { now: scenario.ctx.now });
  for (const policy of scenario.policies) {
    if (policy.transformAppend) {
      items = policy.transformAppend({ state: scenario.state, items });
    }
  }
  scenario.effects.delete(effectId);
  const envelopes = applyAppend(scenario, items);
  registerEffects(scenario, []);
  for (const envelope of envelopes) {
    dispatch(scenario, { type: "event-appended", envelope });
  }
}

export function pendingEffectIds(scenario: Scenario): string[] {
  return [...scenario.effects.keys()].sort();
}

export function kinds(scenario: Scenario): string[] {
  // Prompt preparation is operational journal state. Most loop tests assert
  // the semantic turn trajectory; dedicated prerequisite tests inspect these
  // rows directly.
  return scenario.log
    .filter((row) => !row.envelopeId.startsWith("sys:prompt-artifacts:"))
    .map((row) => row.payloadKind);
}
