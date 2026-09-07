import { describe, expect, it } from "vitest";
import {
  createScenario,
  dispatch,
  resolveEffect,
  pendingEffectIds,
  kinds,
  applyAppend,
  type Scenario,
} from "./scenario.js";
import {
  initialAgentState,
  overlayInputConfig,
  type AgentLoopConfig,
  type AgentModelSpec,
  type AgentTurnMetadata,
  type SessionEntry,
} from "./state.js";
import { derivePendingEffects } from "./effects.js";
import { defaultPolicies, publishPolicyPolicy } from "./policies/index.js";
import { ids } from "./ids.js";
import { buildModelContext } from "./context.js";
import type { StepPolicy } from "./step.js";

const primaryModelSpec: AgentModelSpec = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 64_000,
};

const baseConfig: AgentLoopConfig = {
  model: "anthropic:claude-sonnet-4-6",
  modelSpec: primaryModelSpec,
  thinkingLevel: "medium",
  fastMode: false,
  approvalLevel: 2,
  respondPolicy: "all",
  systemPromptHash: "blob:system-prompt",
  activeToolNames: ["read", "write"],
  localToolExecutionModes: { read: "parallel", write: "sequential" },
  localToolCancellationModes: { read: "interruptible", write: "settle" },
  roster: { participants: [] },
};

const promptingRoster: AgentLoopConfig["roster"] = {
  participants: [
    {
      participantId: "panel:user",
      ref: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      type: "panel",
      methods: [{ name: "confirm" }],
    },
  ],
};

const fallbackModelRef = "local:lfm2.5-2.6b";
const fallbackModelSpec: AgentModelSpec = {
  id: "lfm2.5-2.6b",
  name: "LFM2.5 2.6B",
  api: "openai-completions",
  provider: "local",
  baseUrl: "http://127.0.0.1:0/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 4096,
};

function scenario(
  opts: {
    approvalLevel?: 0 | 1 | 2;
    policies?: StepPolicy[];
    forkSeq?: number;
    roster?: AgentLoopConfig["roster"];
    publishPolicy?: AgentLoopConfig["publishPolicy"];
    model?: string;
    modelSpec?: AgentModelSpec;
    modelAuth?: AgentLoopConfig["modelAuth"];
    fallback?: boolean;
    fallbackConfig?: Partial<AgentLoopConfig>;
  } = {},
): Scenario {
  return createScenario({
    state: initialAgentState({
      channelId: "chan-1",
      selfId: "agent:self",
      config: {
        ...baseConfig,
        model: opts.model ?? baseConfig.model,
        modelSpec: opts.modelSpec ?? baseConfig.modelSpec,
        approvalLevel: opts.approvalLevel ?? 2,
        roster: opts.roster ?? baseConfig.roster,
        ...(opts.modelAuth ? { modelAuth: opts.modelAuth } : {}),
        ...(opts.fallback ? { fallbackModelRef, fallbackModelSpec } : {}),
        ...opts.fallbackConfig,
        ...(opts.publishPolicy !== undefined
          ? { publishPolicy: opts.publishPolicy }
          : {}),
      },
      forkSeq: opts.forkSeq,
    }),
    policies: opts.policies ?? defaultPolicies(),
  });
}

function prompt(
  s: Scenario,
  envelopeId = "env-1",
  content = "hello",
  metadata?: AgentTurnMetadata,
): void {
  dispatch(s, {
    type: "command",
    command: {
      kind: "prompt",
      channelId: "chan-1",
      source: { envelopeId },
      content,
      senderRef: {
        kind: "user",
        id: "panel:user",
        participantId: "panel:user",
      },
      ...(metadata ? { metadata } : {}),
    },
  });
  drainPromptArtifactPreparations(s);
}

function drainPromptArtifactPreparations(s: Scenario): void {
  for (;;) {
    const effect = [...s.effects.values()].find(
      (candidate) => candidate.kind === "prompt_artifacts",
    );
    if (!effect) return;
    resolveEffect(s, effect.effectId, {
      kind: "prompt-artifacts",
      patch: s.state.config,
    });
  }
}

const turn1 = ids.turnId("chan-1", "env-1", "agent:self");
const msg0 = ids.messageId(turn1, 0);

describe("agent-loop core lifecycle", () => {
  it("preserves structured input from prompt command through fold and model context", () => {
    const s = scenario();
    const structuredInput = {
      kind: "channel-observation",
      version: 1,
      source: {
        channelId: "chan-1",
        envelopeId: "incident-envelope-7",
        payloadKind: "application.incident.v1",
      },
      payload: { incidentId: "inc-7", severity: "high" },
    };

    dispatch(s, {
      type: "command",
      command: {
        kind: "prompt",
        channelId: "chan-1",
        source: { envelopeId: "incident-envelope-7" },
        content: "Channel observation: application.incident.v1",
        structuredInput,
        senderRef: { kind: "external", id: "service:incidents" },
      },
    });

    expect(
      s.log.find((row) => row.payloadKind === "message.completed")?.payload,
    ).toMatchObject({
      role: "user",
      structuredInput,
    });
    expect(s.state.entries[0]).toMatchObject({ kind: "user", structuredInput });
    expect(buildModelContext(s.state)[0]).toEqual({
      role: "user",
      content: {
        message: "Channel observation: application.incident.v1",
        structuredInput,
      },
    });
  });

  it("journals prompt preparation before opening a turn or admitting a model call", () => {
    const s = scenario();
    const triggerEnvelopeId = ids.recvUserMessage("chan-1", "env-1");

    dispatch(s, {
      type: "command",
      command: {
        kind: "prompt",
        channelId: "chan-1",
        source: { envelopeId: "env-1" },
        content: "hello",
        senderRef: {
          kind: "user",
          id: "panel:user",
          participantId: "panel:user",
        },
      },
    });

    expect(kinds(s)).toEqual(["message.completed"]);
    expect(s.state.openTurn).toBeNull();
    expect(pendingEffectIds(s)).toEqual([
      ids.promptArtifactsEffect(triggerEnvelopeId),
    ]);

    resolveEffect(s, ids.promptArtifactsEffect(triggerEnvelopeId), {
      kind: "prompt-artifacts",
      patch: { systemPromptHash: "blob:prepared" },
    });

    expect(kinds(s)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
    ]);
    expect(s.state.config.systemPromptHash).toBe("blob:prepared");
    expect(s.state.openTurn?.turnId).toBe(turn1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg0)]);
    expect(
      (
        s.log.find((row) => row.payloadKind === "message.started")!.payload as {
          modelRequest: { systemPromptHash: string };
        }
      ).modelRequest.systemPromptHash,
    ).toBe("blob:prepared");
  });

  it("settles prompt preparation failure as a closed diagnostic turn without model work", () => {
    const s = scenario();
    const triggerEnvelopeId = ids.recvUserMessage("chan-1", "env-1");

    dispatch(s, {
      type: "command",
      command: {
        kind: "prompt",
        channelId: "chan-1",
        source: { envelopeId: "env-1" },
        content: "hello",
        senderRef: {
          kind: "user",
          id: "panel:user",
          participantId: "panel:user",
        },
      },
    });
    dispatch(s, {
      type: "effect-failed",
      effectId: ids.promptArtifactsEffect(triggerEnvelopeId),
      kind: "prompt_artifacts",
      error: { message: "workspace prompt resource unavailable" },
      attempts: 1,
    });

    expect(kinds(s)).toEqual([
      "message.completed",
      "turn.opened",
      "message.completed",
      "turn.closed",
    ]);
    expect(s.state.openTurn).toBeNull();
    expect(s.state.pendingPrompt).toBeNull();
    expect(s.state.entries.map((entry) => entry.kind)).toEqual(["assistant"]);
    expect(pendingEffectIds(s)).toEqual([]);
    expect(
      s.log.find(
        (row) =>
          row.payloadKind === "message.completed" &&
          row.envelopeId.includes(":prompt-artifacts:"),
      ),
    ).toMatchObject({
      payloadKind: "message.completed",
      publish: true,
      payload: {
        blocks: [
          expect.objectContaining({
            type: "diagnostic",
            metadata: expect.objectContaining({
              code: "prompt_artifact_load_failed",
              reason: "workspace prompt resource unavailable",
            }),
          }),
        ],
      },
    });
  });

  it("journals a pre-model infrastructure failure as a terminal failed turn", () => {
    const s = scenario();

    dispatch(s, {
      type: "command",
      command: {
        kind: "prompt-failed",
        channelId: "chan-1",
        source: { envelopeId: "env-1" },
        content: "hello",
        senderRef: {
          kind: "user",
          id: "panel:user",
          participantId: "panel:user",
        },
        reason: "prompt resource unavailable",
        code: "prompt_artifact_load_failed",
      },
    });

    expect(kinds(s)).toEqual([
      "message.completed",
      "turn.opened",
      "message.failed",
      "turn.closed",
    ]);
    expect(s.log[2]).toMatchObject({
      payload: {
        reason: "prompt resource unavailable",
        recoverable: false,
        code: "prompt_artifact_load_failed",
      },
      causality: { turnId: turn1 },
      publish: true,
    });
    expect(s.state.openTurn).toBeNull();
    expect(pendingEffectIds(s)).toEqual([]);
  });

  it("prompt opens a turn, journals before dispatch, and closes on a text-only reply", () => {
    const s = scenario();
    prompt(s);

    // journal-before-dispatch: recv + turn.opened + message.started all durable
    expect(kinds(s)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
    ]);
    const opened = s.log.find((row) => row.payloadKind === "turn.opened")!;
    const started = s.log.find((row) => row.payloadKind === "message.started")!;
    expect(opened.causality).toMatchObject({
      turnId: turn1,
      messageId: ids.recvUserMessage("chan-1", "env-1"),
    });
    expect(started.envelopeId).toBe(ids.messageStarted(msg0));
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg0)]);

    // the started payload fully describes the request (re-derivable, P2)
    const request = (
      started.payload as { modelRequest: Record<string, unknown> }
    ).modelRequest;
    expect(request).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      systemPromptHash: "blob:system-prompt",
      attemptId: ids.attemptId(msg0),
      contextThroughSeq: 4,
    });

    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "text", content: "hi there" }],
      stopReason: "completed",
    });

    expect(kinds(s)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.completed",
      "turn.closed",
    ]);
    expect(s.state.openTurn).toBeNull();
    expect(pendingEffectIds(s)).toEqual([]);
    expect(s.state.entries.map((entry) => entry.kind)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("journals the priority service tier when fast mode is enabled for a supporting model", () => {
    const s = scenario({
      model: "openai-codex:gpt-5.6-sol",
      modelSpec: {
        ...primaryModelSpec,
        id: "gpt-5.6-sol",
        api: "openai-codex-responses",
        provider: "openai-codex",
        serviceTiers: ["priority"],
      },
      fallbackConfig: { fastMode: true },
    });

    prompt(s);

    const started = s.log.find((row) => row.payloadKind === "message.started")!;
    expect(
      (started.payload as { modelRequest: Record<string, unknown> })
        .modelRequest,
    ).toMatchObject({ serviceTier: "priority" });
  });

  it("journals roster refreshes through the ordered command path", () => {
    const s = scenario();
    const roster = {
      participants: [
        {
          participantId: "panel:user",
          ref: {
            kind: "panel" as const,
            id: "panel:user",
            participantId: "panel:user",
          },
          type: "panel",
          methods: [{ name: "set_title" }],
        },
      ],
    };

    dispatch(s, { type: "command", command: { kind: "setRoster", roster } });

    expect(kinds(s)).toEqual(["system.event"]);
    expect(s.log[0]).toMatchObject({
      payload: {
        kind: "roster.snapshot",
        details: { kind: "roster.snapshot", roster },
      },
    });
    expect(s.state.config.roster).toEqual(roster);
  });

  it("runs the tool loop: model tool-call → local_tool effect → result → next model call", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-1",
          name: "read",
          arguments: { path: "a.ts" },
        },
      ],
      stopReason: "completed",
    });

    // invocation journaled with full transport; effect pending
    const started = s.log.find(
      (row) => row.envelopeId === ids.invocationStart("tc-1"),
    )!;
    expect(started.payload).toMatchObject({
      name: "read",
      transport: { kind: "local", awaiterId: "tc-1" },
      executionMode: "parallel",
    });
    expect(pendingEffectIds(s)).toEqual([ids.invocationEffect("tc-1")]);
    expect(derivePendingEffects(s.state)).toContainEqual(
      expect.objectContaining({
        kind: "local_tool",
        invocationId: "tc-1",
        invocationSeq: started.seq,
        executionMode: "parallel",
        cancellationMode: "interruptible",
      }),
    );

    resolveEffect(s, ids.invocationEffect("tc-1"), {
      kind: "tool",
      result: {
        protocol: "vibestudio.blob-ref.v1",
        digest: "d1",
        size: 3,
        encoding: "json",
        originalBytes: 3,
      },
      isError: false,
    });

    // E-invocation-terminal: last invocation settled → next model call
    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
    expect(s.state.entries.map((entry) => entry.kind)).toEqual([
      "user",
      "assistant",
      "tool-result",
    ]);

    resolveEffect(s, ids.modelEffect(msg1), {
      kind: "model",
      blocks: [{ type: "text", content: "done" }],
      stopReason: "completed",
    });
    expect(s.state.openTurn).toBeNull();
    expect(pendingEffectIds(s)).toEqual([]);
  });

  it("keeps legacy infrastructure failures without recovery metadata in the current turn", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-infra",
          name: "read",
          arguments: { path: "a.ts" },
        },
      ],
      stopReason: "completed",
    });

    resolveEffect(s, ids.invocationEffect("tc-infra"), {
      kind: "tool",
      result: {
        error: "package linker unavailable",
        code: "package_load_failed",
      },
      isError: true,
      reason: "package linker unavailable",
      terminalOutcome: "infrastructure_error",
      terminalReasonCode: "package_load_failed",
    });

    const terminal = s.log.find(
      (row) => row.envelopeId === ids.invocationTerminal("tc-infra"),
    )!;
    expect(terminal).toMatchObject({
      payloadKind: "invocation.failed",
      payload: {
        terminalOutcome: "infrastructure_error",
        reason: "package linker unavailable",
      },
    });
    expect(
      s.log.some((row) => row.envelopeId.includes(":infrastructure:")),
    ).toBe(false);
    expect(s.state.openTurn).not.toBeNull();
    expect(pendingEffectIds(s)).toEqual([
      ids.modelEffect(ids.messageId(turn1, 1)),
    ]);
  });

  it("honors an explicit infrastructure stop action", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-infra-stop",
          name: "read",
          arguments: { path: "a.ts" },
        },
      ],
      stopReason: "completed",
    });

    resolveEffect(s, ids.invocationEffect("tc-infra-stop"), {
      kind: "tool",
      result: { error: "event log integrity is unknown" },
      isError: true,
      reason: "event log integrity is unknown",
      terminalOutcome: "infrastructure_error",
      terminalReasonCode: "event_log_integrity_unknown",
      failure: {
        protocol: "agent-tool-failure.v1",
        code: "event_log_integrity_unknown",
        kind: "integrity",
        message: "event log integrity is unknown",
        operation: "tool.read",
        stage: "execute",
        retry: { policy: "none", commandIdPolicy: "not-applicable" },
        recovery: {
          action: "stop",
          instruction: "Do not continue from unverified event state.",
        },
        causes: [
          {
            role: "primary",
            code: "event_log_integrity_unknown",
            message: "event log integrity is unknown",
          },
        ],
      },
    });

    expect(s.state.openTurn).toBeNull();
    expect(pendingEffectIds(s)).toEqual([]);
    expect(
      s.log.some((row) =>
        row.envelopeId.includes(":infrastructure:tc-infra-stop"),
      ),
    ).toBe(true);
  });

  it("opens the circuit after three consecutive infrastructure failures from one tool", () => {
    const s = scenario();
    prompt(s);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const invocationId = `tc-infra-repeat-${attempt + 1}`;
      resolveEffect(s, ids.modelEffect(ids.messageId(turn1, attempt)), {
        kind: "model",
        blocks: [
          {
            type: "toolCall",
            id: invocationId,
            name: "read",
            arguments: { path: "a.ts" },
          },
        ],
        stopReason: "completed",
      });
      resolveEffect(s, ids.invocationEffect(invocationId), {
        kind: "tool",
        result: { error: "package linker unavailable" },
        isError: true,
        reason: "package linker unavailable",
        terminalOutcome: "infrastructure_error",
        terminalReasonCode: "package_load_failed",
      });

      if (attempt < 2) {
        expect(s.state.openTurn).not.toBeNull();
        expect(pendingEffectIds(s)).toEqual([
          ids.modelEffect(ids.messageId(turn1, attempt + 1)),
        ]);
      }
    }

    expect(s.state.openTurn).toBeNull();
    expect(pendingEffectIds(s)).toEqual([]);
    expect(
      s.log.some((row) =>
        row.envelopeId.includes(":infrastructure:tc-infra-repeat-3"),
      ),
    ).toBe(true);
    expect(
      s.log.find((row) =>
        row.envelopeId.includes(":infrastructure:tc-infra-repeat-3"),
      ),
    ).toMatchObject({
      payload: {
        blocks: [
          {
            type: "diagnostic",
            content: expect.stringContaining("three consecutive"),
          },
        ],
      },
    });
  });

  it("continues the same turn when infrastructure failure has typed recovery", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-repair",
          name: "eval",
          arguments: { code: "create()" },
        },
      ],
      stopReason: "completed",
    });

    resolveEffect(s, ids.invocationEffect("tc-repair"), {
      kind: "tool",
      result: { error: "protected publication build gate failed" },
      isError: true,
      reason: "protected publication build gate failed",
      terminalOutcome: "infrastructure_error",
      terminalReasonCode: "scaffold_publication_failed",
      failure: {
        protocol: "agent-tool-failure.v1",
        code: "scaffold_publication_failed",
        kind: "infrastructure",
        message: "protected publication build gate failed",
        operation: "tool.eval",
        stage: "execute",
        retry: { policy: "none", commandIdPolicy: "not-applicable" },
        recovery: {
          action: "repair-source",
          instruction:
            "Inspect diagnostics, repair source, and publish a new revision.",
        },
        causes: [
          {
            role: "primary",
            code: "scaffold_publication_failed",
            message: "protected publication build gate failed",
          },
        ],
      },
    });

    expect(
      s.log.find(
        (row) => row.envelopeId === ids.invocationTerminal("tc-repair"),
      ),
    ).toMatchObject({
      payload: {
        terminalOutcome: "infrastructure_error",
        failure: { recovery: { action: "repair-source" } },
      },
    });
    expect(
      s.log.some((row) => row.envelopeId.includes(":infrastructure:")),
    ).toBe(false);
    expect(s.state.openTurn).not.toBeNull();
    expect(pendingEffectIds(s)).toEqual([
      ids.modelEffect(ids.messageId(turn1, 1)),
    ]);
  });

  it("retains typed recovery while waiting for parallel siblings", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        { type: "toolCall", id: "tc-repair", name: "eval", arguments: {} },
        { type: "toolCall", id: "tc-sibling", name: "read", arguments: {} },
      ],
      stopReason: "completed",
    });

    resolveEffect(s, ids.invocationEffect("tc-repair"), {
      kind: "tool",
      result: { error: "panel generation changed" },
      isError: true,
      terminalOutcome: "infrastructure_error",
      terminalReasonCode: "cdp_target_closed",
      failure: {
        protocol: "agent-tool-failure.v1",
        code: "cdp_target_closed",
        kind: "infrastructure",
        message: "panel generation changed",
        operation: "tool.eval",
        stage: "execute",
        retry: { policy: "none", commandIdPolicy: "not-applicable" },
        recovery: {
          action: "reacquire-handle",
          instruction: "Acquire a page for the current panel generation.",
        },
        causes: [
          {
            role: "primary",
            code: "cdp_target_closed",
            message: "panel generation changed",
          },
        ],
      },
    });
    expect(pendingEffectIds(s)).toEqual([ids.invocationEffect("tc-sibling")]);

    resolveEffect(s, ids.invocationEffect("tc-sibling"), {
      kind: "tool",
      result: { ok: true },
      isError: false,
    });

    expect(
      s.log.some((row) => row.envelopeId.includes(":infrastructure:")),
    ).toBe(false);
    expect(s.state.openTurn).not.toBeNull();
    expect(pendingEffectIds(s)).toEqual([
      ids.modelEffect(ids.messageId(turn1, 1)),
    ]);
  });

  it("waits for parallel siblings before continuing after legacy infrastructure failure", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-infra",
          name: "read",
          arguments: { path: "a.ts" },
        },
        {
          type: "toolCall",
          id: "tc-sibling",
          name: "read",
          arguments: { path: "b.ts" },
        },
      ],
      stopReason: "completed",
    });

    resolveEffect(s, ids.invocationEffect("tc-infra"), {
      kind: "tool",
      result: { error: "package linker unavailable" },
      isError: true,
      reason: "package linker unavailable",
      terminalOutcome: "infrastructure_error",
      terminalReasonCode: "package_load_failed",
    });
    expect(s.state.openTurn).not.toBeNull();
    expect(
      s.log.some((row) => row.envelopeId.includes(":infrastructure:")),
    ).toBe(false);

    resolveEffect(s, ids.invocationEffect("tc-sibling"), {
      kind: "tool",
      result: { ok: true },
      isError: false,
    });
    expect(
      s.log.some((row) => row.envelopeId.includes(":infrastructure:")),
    ).toBe(false);
    expect(s.state.openTurn).not.toBeNull();
    expect(pendingEffectIds(s)).toEqual([
      ids.modelEffect(ids.messageId(turn1, 1)),
    ]);
  });

  it("keeps an authored tool failure recoverable inside the turn", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-user",
          name: "read",
          arguments: { path: "missing" },
        },
      ],
      stopReason: "completed",
    });

    resolveEffect(s, ids.invocationEffect("tc-user"), {
      kind: "tool",
      result: { error: "missing" },
      isError: true,
      reason: "missing",
      terminalReasonCode: "WorkingChangesPresent",
    });

    expect(
      s.log.find((row) => row.envelopeId === ids.invocationTerminal("tc-user")),
    ).toMatchObject({
      payload: {
        terminalOutcome: "tool_error",
        terminalReasonCode: "WorkingChangesPresent",
      },
    });
    expect(s.state.openTurn).not.toBeNull();
    expect(pendingEffectIds(s)).toEqual([
      ids.modelEffect(ids.messageId(turn1, 1)),
    ]);
  });

  it("stamps tier secondary on tool-call (intermediate) messages and primary on the final answer", () => {
    const s = scenario();
    prompt(s);
    // First model output carries a tool call → the turn continues → tier 2.
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-1",
          name: "read",
          arguments: { path: "a.ts" },
        },
      ],
      stopReason: "completed",
    });
    const intermediate = s.log.find(
      (row) => row.envelopeId === ids.messageTerminal(msg0),
    )!;
    expect((intermediate.payload as { tier?: string }).tier).toBe("secondary");
    expect(intermediate.causality).toMatchObject({
      messageId: msg0,
      turnId: turn1,
    });

    resolveEffect(s, ids.invocationEffect("tc-1"), {
      kind: "tool",
      result: "file contents",
      isError: false,
    });
    const msg1 = ids.messageId(turn1, 1);
    // Final model output is text-only → turn closes → tier 1.
    resolveEffect(s, ids.modelEffect(msg1), {
      kind: "model",
      blocks: [{ type: "text", content: "done" }],
      stopReason: "completed",
    });
    const final = s.log.find(
      (row) => row.envelopeId === ids.messageTerminal(msg1),
    )!;
    expect((final.payload as { tier?: string }).tier).toBe("primary");
    expect(final.causality).toMatchObject({ messageId: msg1, turnId: turn1 });
  });

  it("repairs a missing prompt artifact before a post-tool continuation model call", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "read-1",
          name: "read",
          arguments: { path: "a.ts" },
        },
      ],
      stopReason: "completed",
    });

    // Simulate an activation/migration fold that retained the open turn but
    // lost its materialized prompt hash.
    s.state = {
      ...s.state,
      config: { ...s.state.config, systemPromptHash: "" },
    };
    resolveEffect(s, ids.invocationEffect("read-1"), {
      kind: "tool",
      result: "file contents",
      isError: false,
    });

    const preparation = [...s.effects.values()].find(
      (effect) => effect.kind === "prompt_artifacts",
    );
    expect(preparation).toBeDefined();
    expect(pendingEffectIds(s)).not.toContain(
      ids.modelEffect(ids.messageId(turn1, 1)),
    );

    resolveEffect(s, preparation!.effectId, {
      kind: "prompt-artifacts",
      patch: { ...s.state.config, systemPromptHash: "blob:repaired" },
    });

    const continuationId = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toContain(ids.modelEffect(continuationId));
    expect(
      (
        s.log.find(
          (row) => row.envelopeId === ids.messageStarted(continuationId),
        )!.payload as {
          modelRequest: { systemPromptHash: string };
        }
      ).modelRequest.systemPromptHash,
    ).toBe("blob:repaired");
  });

  it("publishes the completed spawn invocation while the durable task owns child progress", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "spawn-1",
          name: "spawn_subagent",
          arguments: { mode: "fresh", task: "audit" },
        },
      ],
      stopReason: "completed",
    });

    resolveEffect(s, ids.invocationEffect("spawn-1"), {
      kind: "tool",
      result: {
        protocolContent: [{ type: "text", text: "spawned subagent spawn-1" }],
        details: { runId: "spawn-1", status: "running" },
      },
      isError: false,
    });

    const terminal = s.log.find(
      (row) => row.envelopeId === ids.invocationTerminal("spawn-1"),
    )!;
    expect(terminal.payloadKind).toBe("invocation.completed");
    expect(terminal.publish).toBe(true);
    expect(s.state.entries.map((entry) => entry.kind)).toContain("tool-result");
  });

  it("still publishes spawn_subagent failures when no background run exists", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "spawn-1",
          name: "spawn_subagent",
          arguments: { mode: "fresh", task: "" },
        },
      ],
      stopReason: "completed",
    });

    resolveEffect(s, ids.invocationEffect("spawn-1"), {
      kind: "tool",
      result: "spawn_subagent(mode:'fresh') requires a non-empty task",
      isError: true,
      reason: "spawn_subagent(mode:'fresh') requires a non-empty task",
    });

    const terminal = s.log.find(
      (row) => row.envelopeId === ids.invocationTerminal("spawn-1"),
    )!;
    expect(terminal.payloadKind).toBe("invocation.failed");
    expect(terminal.publish).toBe(true);
  });

  it("suspend_turn parks the open turn until a later background terminal wakes it", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "suspend-1",
          name: "suspend_turn",
          arguments: { reason: "waiting_for_background" },
        },
      ],
      stopReason: "completed",
    });

    resolveEffect(s, ids.invocationEffect("suspend-1"), {
      kind: "tool",
      result: {
        protocolContent: [{ type: "text", text: "Turn suspended." }],
        details: { suspendTurn: true, reason: "waiting_for_background" },
      },
      turnControl: {
        kind: "suspend",
        reason: "waiting_for_background",
        summary: "Suspended until background work or user input arrives",
      },
      isError: false,
    });

    const waiting = s.log.find((row) => row.payloadKind === "turn.waiting")!;
    expect(waiting.payload).toMatchObject({
      reason: "waiting_for_background",
      summary: "Suspended until background work or user input arrives",
    });
    expect(s.state.openTurn).not.toBeNull();
    expect(
      s.log.filter((row) => row.payloadKind === "message.started"),
    ).toHaveLength(1);
    expect(pendingEffectIds(s)).toEqual([]);

    const [backgroundTerminal] = applyAppend(s, [
      {
        envelopeId: "subagent-terminal:run-1",
        payloadKind: "invocation.completed",
        payload: { protocol: "agentic.trajectory.v1", result: { ok: true } },
        causality: { turnId: turn1, invocationId: "run-1" as never },
        publish: true,
      },
    ]);
    dispatch(s, { type: "event-appended", envelope: backgroundTerminal! });

    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
  });

  it("closes a turn when the finalized tool batch requests termination", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "complete-1",
          name: "complete",
          arguments: { report: "done" },
        },
      ],
      stopReason: "completed",
    });

    resolveEffect(s, ids.invocationEffect("complete-1"), {
      kind: "tool",
      result: { ok: true },
      isError: false,
      turnControl: { kind: "terminate" },
    });

    expect(s.state.openTurn).toBeNull();
    expect(pendingEffectIds(s)).toEqual([]);
    expect(
      s.log.find((row) => row.payloadKind === "turn.closed")?.payload,
    ).toMatchObject({
      reason: "tool_terminated",
    });
    expect(
      s.log.filter((row) => row.payloadKind === "message.started"),
    ).toHaveLength(1);
  });

  it("continues after a mixed tool batch where only one result requests termination", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        { type: "toolCall", id: "complete-1", name: "complete", arguments: {} },
        { type: "toolCall", id: "other-1", name: "other", arguments: {} },
      ],
      stopReason: "completed",
    });

    resolveEffect(s, ids.invocationEffect("complete-1"), {
      kind: "tool",
      result: { ok: true },
      isError: false,
      turnControl: { kind: "terminate" },
    });
    resolveEffect(s, ids.invocationEffect("other-1"), {
      kind: "tool",
      result: { ok: true },
      isError: false,
    });

    expect(s.state.openTurn).not.toBeNull();
    expect(pendingEffectIds(s)).toEqual([
      ids.modelEffect(ids.messageId(turn1, 1)),
    ]);
  });

  it("does not let a recovery wake resume a turn from its own suspension result", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "suspend-1",
          name: "suspend_turn",
          arguments: { reason: "waiting_for_background" },
        },
      ],
      stopReason: "completed",
    });
    resolveEffect(s, ids.invocationEffect("suspend-1"), {
      kind: "tool",
      result: {
        protocolContent: [{ type: "text", text: "Turn suspended." }],
        details: { suspendTurn: true, reason: "waiting_for_background" },
      },
      turnControl: {
        kind: "suspend",
        reason: "waiting_for_background",
        summary: "Suspended until background work or user input arrives",
      },
      isError: false,
    });

    dispatch(s, { type: "command", command: { kind: "wake" } });

    expect(s.state.openTurn?.waitingAtSeq).toBeDefined();
    expect(pendingEffectIds(s)).toEqual([]);
    expect(
      s.log.filter((row) => row.payloadKind === "message.started"),
    ).toHaveLength(1);
  });

  it("stamps tier primary on a direct text-only answer", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "text", content: "hi there" }],
      stopReason: "completed",
    });
    const completed = s.log.find(
      (row) => row.envelopeId === ids.messageTerminal(msg0),
    )!;
    expect((completed.payload as { tier?: string }).tier).toBe("primary");
  });

  it("continues model/tool rounds without a model-call cap", () => {
    const s = scenario();
    prompt(s);

    for (let i = 0; i < 35; i += 1) {
      const messageId = ids.messageId(turn1, i);
      const toolCallId = `tc-${i}`;
      expect(pendingEffectIds(s)).toEqual([ids.modelEffect(messageId)]);
      resolveEffect(s, ids.modelEffect(messageId), {
        kind: "model",
        blocks: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "read",
            arguments: { path: "a.ts" },
          },
        ],
        stopReason: "completed",
      });
      resolveEffect(s, ids.invocationEffect(toolCallId), {
        kind: "tool",
        result: `file contents ${i}`,
        isError: false,
      });
    }

    const msg35 = ids.messageId(turn1, 35);
    expect(s.state.openTurn?.modelCallCount).toBe(36);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg35)]);
    resolveEffect(s, ids.modelEffect(msg35), {
      kind: "model",
      blocks: [{ type: "text", content: "done" }],
      stopReason: "completed",
    });
    expect(s.state.openTurn).toBeNull();
    expect(pendingEffectIds(s)).toEqual([]);
  });

  it("queues steering and consumes it with the next model call", () => {
    const s = scenario();
    prompt(s);
    dispatch(s, {
      type: "command",
      command: {
        kind: "steer",
        channelId: "chan-1",
        source: { envelopeId: "env-2" },
        content: "also do this",
        senderRef: { kind: "user", id: "panel:user" },
      },
    });
    // model call in flight: steer only journals the user message
    expect(s.state.steeringQueue).toHaveLength(1);
    expect(pendingEffectIds(s)).toEqual([
      ids.modelEffect(msg0),
      ids.promptArtifactsEffect(ids.recvUserMessage("chan-1", "env-2")),
    ]);
    drainPromptArtifactPreparations(s);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg0)]);

    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "text", content: "first answer" }],
      stopReason: "completed",
    });

    // steering pending → next model call instead of close
    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
    // the new snapshot covers the steered message → queue drained
    expect(s.state.steeringQueue).toHaveLength(0);

    resolveEffect(s, ids.modelEffect(msg1), {
      kind: "model",
      blocks: [{ type: "text", content: "both done" }],
      stopReason: "completed",
    });
    expect(s.state.openTurn).toBeNull();
  });

  it("journals side-effecting tool calls in model source order with sequential metadata", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-write-1",
          name: "write",
          arguments: { path: "a" },
        },
        {
          type: "toolCall",
          id: "tc-write-2",
          name: "write",
          arguments: { path: "b" },
        },
      ],
      stopReason: "completed",
    });

    const effects = derivePendingEffects(s.state).filter(
      (effect) => effect.kind === "local_tool",
    );
    expect(effects).toEqual([
      expect.objectContaining({
        invocationId: "tc-write-1",
        executionMode: "sequential",
        cancellationMode: "settle",
      }),
      expect.objectContaining({
        invocationId: "tc-write-2",
        executionMode: "sequential",
        cancellationMode: "settle",
      }),
    ]);
    expect(effects[0]!.invocationSeq).toBeLessThan(effects[1]!.invocationSeq!);
  });

  it("interrupt mid-model-call settles pendings and closes the turn after the interrupted terminal", () => {
    const s = scenario();
    prompt(s);
    dispatch(s, { type: "command", command: { kind: "interrupt" } });
    // marker journaled; model executor abort is the driver's job
    expect(kinds(s)).toContain("system.event");
    expect(s.state.openTurn?.interrupted).toBe(true);

    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "text", content: "partial" }],
      stopReason: "aborted",
    });
    expect(s.state.openTurn).toBeNull();
    const closed = s.log.find((row) => row.payloadKind === "turn.closed")!;
    expect(closed.payload).toMatchObject({ reason: "user_interrupted" });
    expect(pendingEffectIds(s)).toEqual([]);
  });

  it("journals distinct deterministic interrupts when channel retirement follows a user interrupt", () => {
    const s = scenario();
    prompt(s);

    dispatch(s, { type: "command", command: { kind: "interrupt" } });
    dispatch(s, {
      type: "command",
      command: { kind: "abort", reason: "channel_unsubscribe" },
    });

    const interrupts = s.log.filter(
      (row) =>
        row.payloadKind === "system.event" &&
        (row.payload as { details?: { kind?: string } }).details?.kind ===
          "interrupt",
    );
    expect(interrupts).toEqual([
      expect.objectContaining({
        envelopeId: ids.interruptEvent(turn1, "user_interrupted"),
        payload: expect.objectContaining({
          details: { kind: "interrupt", reason: "user_interrupted" },
        }),
      }),
      expect.objectContaining({
        envelopeId: ids.interruptEvent(turn1, "channel_unsubscribe"),
        payload: expect.objectContaining({
          details: { kind: "interrupt", reason: "channel_unsubscribe" },
        }),
      }),
    ]);

    const replay = scenario();
    prompt(replay);
    dispatch(replay, { type: "command", command: { kind: "interrupt" } });
    dispatch(replay, {
      type: "command",
      command: { kind: "abort", reason: "channel_unsubscribe" },
    });
    expect(replay.log).toEqual(s.log);
  });

  it("classifies empty and tool_calls_only outcomes", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [],
      stopReason: "completed",
    });
    const completed = s.log.filter(
      (row) => row.payloadKind === "message.completed",
    );
    expect(completed[completed.length - 1]!.payload).toMatchObject({
      outcome: "empty",
    });
  });

  it("compacts without orphaning retained tool results from their assistant tool calls", () => {
    const entries: SessionEntry[] = [
      {
        kind: "assistant",
        seq: 1,
        messageId: "msg-tool",
        blocks: [
          {
            type: "toolCall",
            id: "call-kept-result",
            name: "spawn_subagent",
            arguments: {},
          },
          { type: "toolCall", id: "call-sibling", name: "read", arguments: {} },
        ],
      },
      {
        kind: "tool-result",
        seq: 2,
        invocationId: "call-sibling",
        turnId: "turn-tool",
        name: "read",
        result: "contents",
        isError: false,
      },
      { kind: "user", seq: 3, envelopeId: "env-3", content: "filler 3" },
      { kind: "user", seq: 4, envelopeId: "env-4", content: "filler 4" },
      {
        kind: "tool-result",
        seq: 5,
        invocationId: "call-kept-result",
        turnId: "turn-tool",
        name: "spawn_subagent",
        result: "spawned",
        isError: false,
      },
      { kind: "user", seq: 6, envelopeId: "env-6", content: "filler 6" },
      { kind: "user", seq: 7, envelopeId: "env-7", content: "filler 7" },
      { kind: "user", seq: 8, envelopeId: "env-8", content: "filler 8" },
      { kind: "user", seq: 9, envelopeId: "env-9", content: "filler 9" },
      { kind: "user", seq: 10, envelopeId: "env-10", content: "filler 10" },
      { kind: "user", seq: 11, envelopeId: "env-11", content: "filler 11" },
      { kind: "user", seq: 12, envelopeId: "env-12", content: "filler 12" },
    ];
    const s = createScenario({
      state: {
        ...initialAgentState({
          channelId: "chan-1",
          config: baseConfig,
          selfId: "agent:self",
        }),
        entries,
        lastSeq: 12,
      },
      policies: defaultPolicies(),
    });

    dispatch(s, { type: "command", command: { kind: "compact" } });

    expect(s.state.entries.map((entry) => entry.seq)).toEqual([
      1, 2, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(
      s.log.find((row) => row.payloadKind === "system.compaction_recorded")
        ?.payload,
    ).toMatchObject({
      summary: "compacted 2 entries",
    });
  });

  it("wake recovery does not re-expand inherited assistant tool calls from another turn", () => {
    const childTurnId = ids.turnId("chan-1", "child-seed", "agent:self");
    const childMessageId = ids.messageId(childTurnId, 0);
    const state = initialAgentState({
      channelId: "chan-1",
      config: baseConfig,
      selfId: "agent:self",
    });
    const s = createScenario({
      state: {
        ...state,
        entries: [
          {
            kind: "assistant",
            seq: 1,
            messageId: "m:t:parent-channel:parent-trigger:parent-agent:0",
            senderRef: {
              kind: "agent",
              id: "parent-agent",
              participantId: "parent-agent",
            },
            blocks: [
              {
                type: "toolCall",
                id: "call-parent-spawn",
                name: "spawn_subagent",
                arguments: { task: "inherited" },
              },
            ],
          },
        ],
        openTurn: {
          turnId: childTurnId,
          openedAtSeq: 2,
          modelCallCount: 1,
          consecutiveModelFailureCount: 0,
          interrupted: false,
          waitingCount: 0,
        },
        inFlightModelCall: {
          messageId: childMessageId,
          attemptId: ids.attemptId(childMessageId),
          contextThroughSeq: 2,
          request: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            modelSpec: primaryModelSpec,
            thinkingLevel: "medium",
            systemPromptHash: "blob:system-prompt",
            activeToolNames: ["read", "write"],
            contextThroughSeq: 2,
            attemptId: ids.attemptId(childMessageId),
          },
        },
        lastSeq: 3,
      },
      policies: defaultPolicies(),
    });

    dispatch(s, { type: "command", command: { kind: "wake" } });

    expect(s.log.map((row) => row.envelopeId)).toEqual([
      ids.messageTerminal(childMessageId),
      ids.messageStarted(ids.messageId(childTurnId, 1)),
    ]);
    expect(
      s.log.some(
        (row) => row.envelopeId === ids.invocationStart("call-parent-spawn"),
      ),
    ).toBe(false);
  });

  it("multi-attempt: recoverable model failure retries with a fresh messageId", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [],
      stopReason: "error",
      errorReason: "overloaded",
    });
    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
    expect(s.log.some((row) => row.payloadKind === "message.failed")).toBe(
      true,
    );
    // fresh attempt id
    const started = s.log.filter(
      (row) => row.payloadKind === "message.started",
    );
    expect(started).toHaveLength(2);
  });

  it("reports a terminal diagnostic after repeated recoverable model failures", () => {
    const s = scenario();
    prompt(s);

    for (let i = 0; i < 3; i += 1) {
      const messageId = ids.messageId(turn1, i);
      expect(pendingEffectIds(s)).toEqual([ids.modelEffect(messageId)]);
      resolveEffect(s, ids.modelEffect(messageId), {
        kind: "model",
        blocks: [],
        stopReason: "error",
        errorReason: "overloaded",
      });
    }

    expect(s.state.openTurn).toBeNull();
    expect(pendingEffectIds(s)).toEqual([]);
    expect(
      s.log.filter((row) => row.payloadKind === "message.started"),
    ).toHaveLength(3);
    expect(
      s.log.filter((row) => row.payloadKind === "message.failed"),
    ).toHaveLength(3);
    const diagnostic = s.log.find(
      (row) => row.envelopeId === `diag:${turn1}:model-retry-limit-exceeded`,
    );
    expect(diagnostic?.payload).toMatchObject({
      blocks: [
        {
          metadata: {
            code: "model_retry_limit_exceeded",
            severity: "error",
            limit: 3,
            consecutiveModelFailureCount: 3,
            turnId: turn1,
          },
        },
      ],
    });
    expect(diagnostic?.publish).toBe(true);
    const closed = s.log.find((row) => row.payloadKind === "turn.closed")!;
    expect(closed.payload).toMatchObject({
      reason: "model_retry_limit_exceeded",
    });
  });

  it("auto-failover: scheduled provider failure continues once on local fallback", () => {
    const s = scenario({ fallback: true });
    prompt(s, "env-1", "background check", { origin: "scheduled" });

    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [],
      stopReason: "error",
      failure: {
        code: "auth_or_credentials",
        reason: "cloud credential expired",
        recoverable: false,
      },
    });

    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
    const notice = s.log.find(
      (row) =>
        row.payloadKind === "system.event" &&
        (row.payload as { kind?: string }).kind === "model.fallback_continued",
    );
    expect(notice?.publish).toBe(true);
    expect(notice?.payload).toMatchObject({
      kind: "model.fallback_continued",
      details: {
        failedModelRef: "anthropic:claude-sonnet-4-6",
        failureCode: "auth_or_credentials",
        fallbackModelRef,
      },
    });
    const fallbackStarted = s.log.find(
      (row) => row.envelopeId === ids.messageStarted(msg1),
    )!;
    const request = (
      fallbackStarted.payload as { modelRequest: Record<string, unknown> }
    ).modelRequest;
    expect(request).toMatchObject({
      provider: "local",
      model: "lfm2.5-2.6b",
      auth: "loopback",
      modelSpec: fallbackModelSpec,
      attemptId: ids.attemptId(msg1),
    });
    expect(s.state.openTurn?.failedOverToFallback).toBe(true);
  });

  it.each([undefined, "agent-initiated" as const])(
    "does not auto-failover interactive provider failures (origin %s)",
    (origin) => {
      const s = scenario({ fallback: true });
      prompt(s, "env-1", "hello", origin ? { origin } : undefined);

      resolveEffect(s, ids.modelEffect(msg0), {
        kind: "model",
        blocks: [],
        stopReason: "error",
        failure: {
          code: "auth_or_credentials",
          reason: "cloud credential expired",
          recoverable: false,
        },
      });

      expect(
        s.log.filter((row) => row.payloadKind === "message.started"),
      ).toHaveLength(1);
      expect(
        s.log.some(
          (row) =>
            row.payloadKind === "system.event" &&
            (row.payload as { kind?: string }).kind ===
              "model.fallback_continued",
        ),
      ).toBe(false);
      expect(s.state.openTurn).toBeNull();
      expect(pendingEffectIds(s)).toEqual([]);
    },
  );

  it("uses an explicitly scoped cloud fallback at its own effort on a user usage limit", () => {
    const lunaSpec: AgentModelSpec = {
      ...primaryModelSpec,
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
    };
    const s = scenario({
      fallbackConfig: {
        fallbackModelRef: "openai-codex:gpt-5.6-luna",
        fallbackModelSpec: lunaSpec,
        fallbackModelAuth: "url-bound",
        fallbackThinkingLevel: "minimal",
        fallbackFailureCodes: ["usage_limit_terminal"],
        fallbackScope: "all-turns",
      },
    });
    prompt(s);

    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [],
      stopReason: "error",
      failure: {
        code: "usage_limit_terminal",
        reason: "Spark limit reached",
        recoverable: false,
        resetAt: "2026-06-15T18:35:01.000Z",
      },
    });

    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
    const started = s.log.find(
      (row) => row.envelopeId === ids.messageStarted(msg1),
    )!;
    expect(
      (started.payload as { modelRequest: Record<string, unknown> })
        .modelRequest,
    ).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      auth: "url-bound",
      thinkingLevel: "minimal",
    });
    const notice = s.log.find(
      (row) =>
        row.payloadKind === "system.event" &&
        (row.payload as { kind?: string }).kind === "model.fallback_continued",
    );
    expect(notice?.payload).toMatchObject({
      details: {
        failureCode: "usage_limit_terminal",
        fallbackModelRef: "openai-codex:gpt-5.6-luna",
        fallbackThinkingLevel: "minimal",
      },
    });
    expect(s.log.some((row) => row.payloadKind === "turn.waiting")).toBe(false);

    resolveEffect(s, ids.modelEffect(msg1), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-fallback",
          name: "read",
          arguments: { path: "a.ts" },
        },
      ],
      stopReason: "completed",
    });
    resolveEffect(s, ids.invocationEffect("tc-fallback"), {
      kind: "tool",
      result: "contents",
      isError: false,
    });

    const msg2 = ids.messageId(turn1, 2);
    const continued = s.log.find(
      (row) => row.envelopeId === ids.messageStarted(msg2),
    )!;
    expect(
      (continued.payload as { modelRequest: Record<string, unknown> })
        .modelRequest,
    ).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      auth: "url-bound",
      thinkingLevel: "minimal",
    });
  });

  it("does not auto-failover twice in the same unattended turn", () => {
    const s = scenario({ fallback: true });
    prompt(s, "env-1", "background check", { origin: "scheduled" });
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [],
      stopReason: "error",
      failure: {
        code: "auth_or_credentials",
        reason: "cloud credential expired",
        recoverable: false,
      },
    });

    const msg1 = ids.messageId(turn1, 1);
    resolveEffect(s, ids.modelEffect(msg1), {
      kind: "model",
      blocks: [],
      stopReason: "error",
      failure: {
        code: "provider_overloaded_retryable",
        reason: "local fallback overloaded",
        recoverable: true,
        retryAfterMs: 10_000,
      },
    });

    expect(
      s.log.filter((row) => row.payloadKind === "message.started"),
    ).toHaveLength(2);
    expect(
      s.log.filter(
        (row) =>
          row.payloadKind === "system.event" &&
          (row.payload as { kind?: string }).kind ===
            "model.fallback_continued",
      ),
    ).toHaveLength(1);
    expect(s.state.openTurn).toBeNull();
    expect(pendingEffectIds(s)).toEqual([]);
  });

  it("does not auto-failover when the failed request was already local", () => {
    const s = scenario({
      fallback: true,
      model: fallbackModelRef,
      modelSpec: fallbackModelSpec,
      modelAuth: "loopback",
    });
    prompt(s, "env-1", "background check", { origin: "scheduled" });

    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [],
      stopReason: "error",
      failure: {
        code: "auth_or_credentials",
        reason: "local fallback failed",
        recoverable: false,
      },
    });

    expect(
      s.log.filter((row) => row.payloadKind === "message.started"),
    ).toHaveLength(1);
    expect(
      s.log.some(
        (row) =>
          row.payloadKind === "system.event" &&
          (row.payload as { kind?: string }).kind ===
            "model.fallback_continued",
      ),
    ).toBe(false);
    expect(s.state.openTurn).toBeNull();
    expect(pendingEffectIds(s)).toEqual([]);
  });

  it("pauses terminal model usage-limit failures until the reset time", () => {
    const s = scenario();
    prompt(s);
    const rawUsageLimit = `Codex error: ${JSON.stringify({
      type: "error",
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
        resets_at: 1781548501,
      },
      headers: {
        "X-Codex-Bengalfox-Limit-Name": "GPT-5.3 Codex-Spark",
      },
    })}`;

    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [],
      stopReason: "error",
      errorReason: rawUsageLimit,
    });

    expect(pendingEffectIds(s)).toEqual([]);
    expect(s.state.openTurn).not.toBeNull();
    expect(
      s.log.filter((row) => row.payloadKind === "message.started"),
    ).toHaveLength(1);
    const failed = s.log.find(
      (row) => row.envelopeId === ids.messageTerminal(msg0),
    )!;
    expect(failed.causality).toMatchObject({ messageId: msg0, turnId: turn1 });
    expect(failed.payload).toMatchObject({
      reason:
        "The usage limit has been reached for GPT-5.3 Codex-Spark. Try again after Jun 15, 2026 at 6:35 PM UTC.",
      recoverable: false,
      code: "usage_limit_terminal",
      resetAt: "2026-06-15T18:35:01.000Z",
    });
    const waiting = s.log.find((row) => row.payloadKind === "turn.waiting")!;
    expect(waiting.payload).toMatchObject({
      reason: "model_usage_limit_reset",
      summary: "Waiting for model usage limit reset",
    });
    expect(s.log.some((row) => row.payloadKind === "turn.closed")).toBe(false);

    s.ctx.now = "2026-06-15T18:35:02.000Z";
    dispatch(s, {
      type: "command",
      command: {
        kind: "resumeAfterReset",
        messageId: msg0,
        resetAt: "2026-06-15T18:35:01.000Z",
      },
    });
    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
    expect(
      s.log.filter((row) => row.payloadKind === "message.started"),
    ).toHaveLength(2);
  });

  it("effect-failed (model, attempts exhausted) closes the turn with a published diagnostic", () => {
    const s = scenario();
    prompt(s);
    dispatch(s, {
      type: "effect-failed",
      effectId: ids.modelEffect(msg0),
      kind: "model_call",
      error: { message: "provider exploded" },
      attempts: 3,
    });
    expect(s.state.openTurn).toBeNull();
    const closed = s.log.find((row) => row.payloadKind === "turn.closed")!;
    expect(closed.payload).toMatchObject({ reason: "work_failed" });
    const failed = s.log.find(
      (row) => row.envelopeId === ids.messageTerminal(msg0),
    )!;
    expect(failed.payloadKind).toBe("message.failed");
    expect(failed.publish).toBe(true);
    const diagnostic = s.log.find(
      (row) =>
        row.payloadKind === "message.completed" &&
        String(row.envelopeId).startsWith("diag:"),
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.publish).toBe(true);
  });
});

describe("approval gate (approvalLevel < 2)", () => {
  it("gates unsafe tools, keeps safe tools auto at level 1, and resumes on grant", () => {
    const s = scenario({ approvalLevel: 1, roster: promptingRoster });
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        { type: "toolCall", id: "tc-r", name: "read", arguments: {} },
        {
          type: "toolCall",
          id: "tc-w",
          name: "write",
          arguments: { path: "x" },
        },
      ],
      stopReason: "completed",
    });

    const approvalId = ids.approvalId("tc-w");
    // read dispatches immediately; write is gated behind the approval form
    expect(pendingEffectIds(s)).toEqual(
      [ids.approvalFormEffect(approvalId), ids.invocationEffect("tc-r")].sort(),
    );
    expect(
      s.log.find((row) => row.envelopeId === ids.approvalRequested(approvalId))!
        .payload,
    ).toMatchObject({
      question: "Allow write to act on “x”?",
      details: { toolName: "write" },
    });

    resolveEffect(s, ids.invocationEffect("tc-r"), {
      kind: "tool",
      result: null,
      isError: false,
    });
    // still waiting on approval — no model call yet
    expect(pendingEffectIds(s)).toEqual([ids.approvalFormEffect(approvalId)]);

    resolveEffect(s, ids.approvalFormEffect(approvalId), {
      kind: "approval",
      granted: true,
      resolvedBy: { kind: "user", id: "panel:user" },
    });
    // grant → the gated tool's dispatch effect becomes derivable
    expect(pendingEffectIds(s)).toEqual([ids.invocationEffect("tc-w")]);

    resolveEffect(s, ids.invocationEffect("tc-w"), {
      kind: "tool",
      result: null,
      isError: false,
    });
    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
  });

  it("denial appends invocation.failed (approval denied)", () => {
    const s = scenario({ approvalLevel: 0, roster: promptingRoster });
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "toolCall", id: "tc-w", name: "write", arguments: {} }],
      stopReason: "completed",
    });
    const approvalId = ids.approvalId("tc-w");
    resolveEffect(s, ids.approvalFormEffect(approvalId), {
      kind: "approval",
      granted: false,
      resolvedBy: { kind: "user", id: "panel:user" },
      reason: "nope",
    });
    const terminal = s.log.find(
      (row) => row.envelopeId === ids.invocationTerminal("tc-w"),
    )!;
    expect(terminal.payloadKind).toBe("invocation.failed");
    expect(terminal.payload).toMatchObject({ reason: "approval denied" });
    // denial settles the invocation → loop continues with a fresh model call
    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
  });

  it("a failed approval-form effect resolves the approval (no infinite reconcile loop, AL-7)", () => {
    const s = scenario({ approvalLevel: 0, roster: promptingRoster });
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "toolCall", id: "tc-w", name: "write", arguments: {} }],
      stopReason: "completed",
    });
    const approvalId = ids.approvalId("tc-w");
    expect(pendingEffectIds(s)).toEqual([ids.approvalFormEffect(approvalId)]);

    // The approval-form delivery permanently fails (no `confirm` method / the
    // user participant is gone). effectFailedStep maps the `form:` effect id —
    // the bug was that it only stripped `inv:`, returned EMPTY, and the
    // approval stayed pending so reconcile re-derived the form effect forever.
    dispatch(s, {
      type: "effect-failed",
      effectId: ids.approvalFormEffect(approvalId),
      kind: "channel_call",
      error: { message: "confirm not registered" },
      attempts: 5,
    });

    // The approval is resolved fail-closed and is NO LONGER pending.
    const resolved = s.log.find(
      (row) => row.envelopeId === ids.approvalResolved(approvalId),
    )!;
    expect(resolved.payloadKind).toBe("approval.resolved");
    expect(resolved.payload).toMatchObject({ granted: false });
    expect(s.state.pendingApprovals[approvalId]).toBeUndefined();

    // The loop converges: the denied invocation settles and a fresh model call
    // is the only pending effect — the approval form is gone for good.
    expect(pendingEffectIds(s)).not.toContain(
      ids.approvalFormEffect(approvalId),
    );
    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
  });
});

describe("ask user policy", () => {
  it("does not rewrite an ask_user call with a missing question", () => {
    const s = scenario({
      roster: {
        participants: [
          {
            participantId: "user:alice",
            ref: {
              kind: "user",
              id: "user:alice",
              participantId: "user:alice",
            },
            type: "user",
            handle: "alice",
            methods: [{ name: "feedback_form" }],
          },
        ],
      },
    });
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-invalid",
          name: "ask_user",
          arguments: { options: ["Yes"] },
        },
      ],
      stopReason: "completed",
    });

    const started = s.log.find(
      (row) => row.envelopeId === ids.invocationStart("tc-invalid"),
    )!;
    expect(started.payload).toMatchObject({
      name: "ask_user",
      request: { options: ["Yes"] },
    });
    expect(s.outputs.flatMap((output) => output.effects)).toContainEqual(
      expect.objectContaining({ kind: "local_tool", tool: "ask_user" }),
    );
  });

  it("rewrites multi-select ask_user calls to multi-select feedback forms", () => {
    const s = scenario({
      roster: {
        participants: [
          {
            participantId: "user:alice",
            ref: {
              kind: "user",
              id: "user:alice",
              participantId: "user:alice",
            },
            type: "user",
            handle: "alice",
            methods: [{ name: "feedback_form" }],
          },
        ],
      },
    });
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-q",
          name: "ask_user",
          arguments: {
            question: "Pick targets",
            options: ["Staging", "Production"],
            multiSelect: true,
          },
        },
      ],
      stopReason: "completed",
    });

    const started = s.log.find(
      (row) => row.envelopeId === ids.invocationStart("tc-q"),
    )!;
    const request = (started.payload as { request: Record<string, unknown> })
      .request;
    const fields = request["fields"] as Array<Record<string, unknown>>;

    expect(started.payload).toMatchObject({
      name: "feedback_form",
      invocationType: "user",
      transport: {
        kind: "channel",
        channelId: "chan-1",
        target: { participantId: "user:alice" },
      },
    });
    expect(request["hideSubmit"]).toBe(false);
    expect(fields[0]).toMatchObject({
      key: "answer",
      type: "multiSelect",
      label: "Pick targets",
      required: true,
      options: [
        { value: "Staging", label: "Staging" },
        { value: "Production", label: "Production" },
      ],
    });
    expect(fields[0]).not.toHaveProperty("submitOnSelect");

    const emittedEffect = s.outputs
      .flatMap((output) => output.effects)
      .find((effect) => effect.effectId === ids.invocationEffect("tc-q"));
    expect(emittedEffect).toMatchObject({
      kind: "channel_call",
      method: "feedback_form",
      purpose: "ask-user",
    });
  });

  it("durably fans an unaddressed ask out to every canonical human", () => {
    const humans = ["alice", "bob"].map((handle) => ({
      participantId: `user:${handle}`,
      ref: {
        kind: "user" as const,
        id: `user:${handle}`,
        participantId: `user:${handle}`,
      },
      type: "user",
      handle,
      methods: [{ name: "feedback_form" }],
    }));
    const s = scenario({ roster: { participants: humans } });
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-everyone",
          name: "ask_user",
          arguments: { question: "Ship it?" },
        },
      ],
      stopReason: "completed",
    });

    const started = s.log.find(
      (row) => row.envelopeId === ids.invocationStart("tc-everyone"),
    )!;
    expect(
      (started.payload as { askUserTargets?: unknown }).askUserTargets,
    ).toEqual(humans.map((human) => human.ref));
    expect([...s.effects.values()]).toEqual([
      expect.objectContaining({
        effectId: ids.invocationEffect("tc-everyone"),
        target: humans[0]!.ref,
        purpose: "ask-user",
      }),
      expect.objectContaining({
        effectId: `${ids.invocationEffect("tc-everyone")}#user:bob`,
        target: humans[1]!.ref,
        purpose: "ask-user",
      }),
    ]);
  });

  it("routes an addressed ask to exactly one human and never broadcasts an unknown target", () => {
    const participants = ["alice", "bob"].map((handle) => ({
      participantId: `user:${handle}`,
      ref: {
        kind: "user" as const,
        id: `user:${handle}`,
        participantId: `user:${handle}`,
      },
      type: "user",
      handle,
      methods: [{ name: "feedback_form" }],
    }));
    const addressed = scenario({ roster: { participants } });
    prompt(addressed);
    resolveEffect(addressed, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-bob",
          name: "ask_user",
          arguments: { question: "Bob?", to: "@bob" },
        },
      ],
      stopReason: "completed",
    });
    expect([...addressed.effects.values()]).toEqual([
      expect.objectContaining({
        target: participants[1]!.ref,
        purpose: "ask-user",
      }),
    ]);

    const unknown = scenario({ roster: { participants } });
    prompt(unknown);
    resolveEffect(unknown, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-unknown",
          name: "ask_user",
          arguments: { question: "Mystery?", to: "@nobody" },
        },
      ],
      stopReason: "completed",
    });
    expect([...unknown.effects.values()]).toEqual([
      expect.objectContaining({ kind: "local_tool", tool: "ask_user" }),
    ]);
  });

  it("routes ask_user against the humans captured for the model call when presence changes in flight", () => {
    const human = {
      participantId: "user:alice",
      ref: {
        kind: "user" as const,
        id: "user:alice",
        participantId: "user:alice",
      },
      type: "user",
      handle: "alice",
      methods: [{ name: "feedback_form" }],
    };
    const s = scenario({ roster: { participants: [human] } });
    prompt(s);

    expect(s.state.inFlightModelCall?.request.askUserParticipants).toEqual([
      {
        participantId: human.participantId,
        ref: human.ref,
        handle: human.handle,
      },
    ]);

    applyAppend(s, [
      {
        envelopeId: "human-roster-empty-while-model-runs",
        payloadKind: "system.event",
        payload: {
          protocol: "agentic.trajectory.v1",
          kind: "roster.snapshot",
          details: {
            kind: "roster.snapshot",
            roster: { participants: [] },
          },
        },
      },
    ]);
    expect(s.state.config.roster.participants).toEqual([]);

    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-presence-race",
          name: "ask_user",
          arguments: { question: "Still there?" },
        },
      ],
      stopReason: "completed",
    });

    const started = s.log.find(
      (row) => row.envelopeId === ids.invocationStart("tc-presence-race"),
    )!;
    expect(started.payload).toMatchObject({
      name: "feedback_form",
      askUserTargets: [human.ref],
      transport: {
        kind: "channel",
        target: human.ref,
      },
    });
    expect(derivePendingEffects(s.state)).toEqual([
      expect.objectContaining({
        kind: "channel_call",
        method: "feedback_form",
        target: human.ref,
      }),
    ]);
  });
});

describe("channel tools", () => {
  it("never routes the executing agent's own participant methods back to itself", () => {
    const s = scenario({
      roster: {
        participants: [
          {
            participantId: "agent:self",
            ref: {
              kind: "agent",
              id: "agent:self",
              participantId: "agent:self",
            },
            type: "agent",
            methods: [{ name: "getDebugState" }],
          },
          {
            participantId: "panel:user",
            ref: {
              kind: "panel",
              id: "panel:user",
              participantId: "panel:user",
            },
            type: "panel",
            methods: [{ name: "set_title" }],
          },
        ],
      },
    });

    prompt(s);

    expect(s.state.inFlightModelCall?.request.channelToolOwners).toEqual({
      set_title: {
        kind: "panel",
        id: "panel:user",
        participantId: "panel:user",
      },
    });
  });

  it("routes roster participant methods over the channel transport", () => {
    const s = scenario({
      roster: {
        participants: [
          {
            participantId: "panel:user",
            ref: {
              kind: "panel",
              id: "panel:user",
              participantId: "panel:user",
            },
            type: "panel",
            methods: [{ name: "eval" }],
          },
        ],
      },
    });
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-e",
          name: "eval",
          arguments: { code: "1+1" },
        },
      ],
      stopReason: "completed",
    });
    const started = s.log.find(
      (row) => row.envelopeId === ids.invocationStart("tc-e"),
    )!;
    expect(started.payload).toMatchObject({
      transport: {
        kind: "channel",
        channelId: "chan-1",
        transportCallId: ids.transportCallId("tc-e"),
        target: { participantId: "panel:user" },
      },
    });
    const effects = derivePendingEffects(s.state);
    expect(effects).toEqual([
      expect.objectContaining({ kind: "channel_call", method: "eval" }),
    ]);
  });

  it("routes against the roster captured for the model call when presence changes in flight", () => {
    const panelRoster: AgentLoopConfig["roster"] = {
      participants: [
        {
          participantId: "panel:user",
          ref: { kind: "panel", id: "panel:user", participantId: "panel:user" },
          type: "panel",
          methods: [{ name: "set_title" }],
        },
      ],
    };
    const s = scenario({ roster: panelRoster });
    prompt(s);

    expect(s.state.inFlightModelCall?.request.channelToolOwners).toEqual({
      set_title: panelRoster.participants[0]!.ref,
    });

    applyAppend(s, [
      {
        envelopeId: "roster-empty-while-model-runs",
        payloadKind: "system.event",
        payload: {
          protocol: "agentic.trajectory.v1",
          kind: "roster.snapshot",
          details: {
            kind: "roster.snapshot",
            roster: { participants: [] },
          },
        },
      },
    ]);
    expect(s.state.config.roster.participants).toEqual([]);

    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-title",
          name: "set_title",
          arguments: { title: "Welcome to Vibestudio" },
        },
      ],
      stopReason: "completed",
    });

    const started = s.log.find(
      (row) => row.envelopeId === ids.invocationStart("tc-title"),
    )!;
    expect(started.payload).toMatchObject({
      transport: {
        kind: "channel",
        channelId: "chan-1",
        transportCallId: ids.transportCallId("tc-title"),
        target: { participantId: "panel:user" },
      },
    });
    expect(derivePendingEffects(s.state)).toEqual([
      expect.objectContaining({ kind: "channel_call", method: "set_title" }),
    ]);
  });

  it("routes duplicate client tools to the panel that initiated the turn", () => {
    const s = scenario({
      roster: {
        participants: [
          {
            participantId: "panel:other",
            ref: {
              kind: "panel",
              id: "panel:other",
              participantId: "panel:other",
            },
            type: "panel",
            methods: [{ name: "client_eval" }],
          },
          {
            participantId: "panel:user",
            ref: {
              kind: "panel",
              id: "panel:user",
              participantId: "panel:user",
            },
            type: "panel",
            methods: [{ name: "client_eval" }],
          },
        ],
      },
    });

    prompt(s);

    expect(s.state.inFlightModelCall?.request.channelToolOwners).toEqual({
      client_eval: {
        kind: "panel",
        id: "panel:user",
        participantId: "panel:user",
      },
    });
  });
});

describe("wake / recovery (C-wake)", () => {
  it("fails an orphan in-flight model call and retries with a fresh attempt", () => {
    const s = scenario();
    prompt(s);
    // crash: wipe the harness's effect registry (the outbox analogue)
    s.effects.clear();
    dispatch(s, { type: "command", command: { kind: "wake" } });

    expect(
      s.log.some(
        (row) =>
          row.payloadKind === "message.failed" &&
          row.envelopeId === ids.messageTerminal(msg0),
      ),
    ).toBe(true);
    expect(
      s.log.find((row) => row.envelopeId === ids.messageTerminal(msg0))
        ?.publish,
    ).toBe(true);
    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
  });

  it("NEVER re-emits a model call while a failed attempt's invocation is non-terminal", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "toolCall", id: "tc-1", name: "read", arguments: {} }],
      stopReason: "completed",
    });
    // crash before the tool resolves
    s.effects.clear();
    dispatch(s, { type: "command", command: { kind: "wake" } });

    // the pending invocation re-derives; NO new model_call (the guard)
    expect(pendingEffectIds(s)).toEqual([ids.invocationEffect("tc-1")]);
    expect(derivePendingEffects(s.state).map((effect) => effect.kind)).toEqual([
      "local_tool",
    ]);
  });

  it("starts a turn from a pendingPrompt on wake", () => {
    const s = scenario();
    // a user message arrives but the driver crashed before stepping the prompt:
    applyAppend(s, [
      {
        envelopeId: "recv:chan-1:env-9",
        payloadKind: "message.completed",
        payload: {
          protocol: "agentic.trajectory.v1",
          role: "user",
          blocks: [{ type: "text", content: "hi" }],
          outcome: "completed",
          turnTriggerEnvelopeId: "env-9",
          promptArtifactsReady: true,
        },
        causality: { messageId: "recv:chan-1:env-9" as never },
      },
    ]);
    expect(s.state.pendingPrompt).not.toBeNull();
    dispatch(s, { type: "command", command: { kind: "wake" } });
    expect(s.state.openTurn).not.toBeNull();
    expect(pendingEffectIds(s)).toHaveLength(1);
  });
});

describe("credential wait", () => {
  it("suspension terminates the placeholder model message, keeps the turn open, and resumes", () => {
    const s = scenario();
    prompt(s);
    // model suspends on credentials: step-level events come from the driver;
    // simulate the journaled message terminal + wait marker
    applyAppend(s, [
      {
        envelopeId: ids.messageTerminal(msg0),
        payloadKind: "message.failed",
        payload: {
          protocol: "agentic.trajectory.v1",
          reason: "model_credential_required",
          recoverable: true,
        },
        causality: { messageId: msg0 as never },
        publish: true,
      },
      {
        envelopeId: ids.systemEvent(
          ids.credKey("chan-1", "anthropic"),
          "started",
        ),
        payloadKind: "system.event",
        payload: {
          protocol: "agentic.trajectory.v1",
          kind: "credential.wait_started",
          messageId: msg0,
          details: {
            kind: "credential.wait_started",
            credKey: ids.credKey("chan-1", "anthropic"),
            providerId: "anthropic",
            messageId: msg0,
            connectSpec: { providerId: "anthropic" },
            expiresAt: "2026-05-20T12:10:00.000Z",
          },
        },
        causality: { turnId: turn1, messageId: msg0 as never },
      },
    ]);
    expect(s.state.openTurn).not.toBeNull();
    expect(s.state.inFlightModelCall).toBeNull();
    expect(Object.keys(s.state.pendingCredentialWaits)).toHaveLength(1);
    expect(
      s.log.filter((row) => row.payloadKind === "turn.closed"),
    ).toHaveLength(0);
    // the wait derives a credential_wait effect
    expect(derivePendingEffects(s.state).map((effect) => effect.kind)).toEqual([
      "credential_wait",
    ]);

    // resolution event arrives → wait cleared, model restarts
    const resolved = applyAppend(s, [
      {
        envelopeId: ids.systemEvent(
          ids.credKey("chan-1", "anthropic"),
          "resolved",
        ),
        payloadKind: "system.event",
        payload: {
          protocol: "agentic.trajectory.v1",
          kind: "credential.wait_resolved",
          details: {
            kind: "credential.wait_resolved",
            credKey: ids.credKey("chan-1", "anthropic"),
            providerId: "anthropic",
            resolved: true,
          },
        },
        causality: { turnId: turn1 },
      },
    ]);
    for (const envelope of resolved)
      dispatch(s, { type: "event-appended", envelope });
    expect(Object.keys(s.state.pendingCredentialWaits)).toHaveLength(0);
    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toContain(ids.modelEffect(msg1));
  });
});

describe("fork policy", () => {
  it("settles pre-cut pendings and closes the inherited open turn on first wake", () => {
    // Build a parent-state scenario, then re-create as a forked head.
    const parent = scenario();
    prompt(parent);
    resolveEffect(parent, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "toolCall", id: "tc-1", name: "read", arguments: {} }],
      stopReason: "completed",
    });
    // fork at the current seq: child inherits the open turn + pending invocation
    const forkSeq = parent.state.lastSeq;
    const child = createScenario({
      state: { ...parent.state, forkSeq },
      policies: defaultPolicies(),
    });
    child.log = [...parent.log];

    dispatch(child, { type: "command", command: { kind: "wake" } });

    const abandoned = child.log.find(
      (row) => row.envelopeId === ids.invocationTerminal("tc-1"),
    )!;
    expect(abandoned.payloadKind).toBe("invocation.abandoned");
    expect(abandoned.payload).toMatchObject({ reason: "forked" });
    const closed = child.log.filter((row) => row.payloadKind === "turn.closed");
    expect(closed[closed.length - 1]!.payload).toMatchObject({
      reason: "forked",
    });
    expect(child.state.openTurn).toBeNull();
    expect(pendingEffectIds(child)).toEqual([]);
  });
});

describe("publish policy: say-only", () => {
  it("suppresses publication of everything except turn open/close", () => {
    const s = scenario({ publishPolicy: "say-only" });
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "text", content: "secret" }],
      stopReason: "completed",
    });
    for (const row of s.log) {
      if (
        row.payloadKind === "turn.opened" ||
        row.payloadKind === "turn.closed"
      ) {
        expect(row.publish).toBe(true);
      } else {
        expect(row.publish ?? false).toBe(false);
      }
    }
  });

  it("suppresses executor-side ephemeral signals", () => {
    const policy = publishPolicyPolicy();
    expect(
      policy.filterEphemeral?.({
        state: { config: { publishPolicy: "say-only" } } as never,
        emit: {
          kind: "signal-event",
          channelId: "chan-1",
          event: { kind: "message.delta" } as never,
        },
      }),
    ).toBeNull();
  });
});

describe("publish policy: turn-final", () => {
  it("publishes only the primary end-of-turn message, suppressing intermediate steps", () => {
    const s = scenario({ publishPolicy: "turn-final" });
    prompt(s);
    // intermediate model round: carries a tool call ⇒ tier "secondary".
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "toolCall", id: "tc-1", name: "read", arguments: {} }],
      stopReason: "completed",
    });
    resolveEffect(s, ids.invocationEffect("tc-1"), {
      kind: "tool",
      result: null,
      isError: false,
    });
    // final model round: text-only ⇒ tier "primary".
    const msg1 = ids.messageId(turn1, 1);
    resolveEffect(s, ids.modelEffect(msg1), {
      kind: "model",
      blocks: [{ type: "text", content: "done" }],
      stopReason: "completed",
    });
    const published = (kind: string, tier?: string) =>
      s.log.filter(
        (row) =>
          row.payloadKind === kind &&
          (tier === undefined ||
            (row.payload as { tier?: string }).tier === tier) &&
          row.publish === true,
      );
    // no message.started publishes; the secondary (tool-call) completion is suppressed.
    expect(
      s.log.filter(
        (row) => row.payloadKind === "message.started" && row.publish === true,
      ),
    ).toHaveLength(0);
    expect(published("message.completed", "secondary")).toHaveLength(0);
    // the primary headline + turn boundaries + invocation outcome still publish.
    expect(published("message.completed", "primary")).toHaveLength(1);
    expect(published("turn.closed")).toHaveLength(1);
    expect(published("invocation.completed")).toHaveLength(1);
  });
});

describe("determinism properties", () => {
  function runTwice(run: (s: Scenario) => void): [Scenario, Scenario] {
    const a = scenario();
    const b = scenario();
    run(a);
    run(b);
    return [a, b];
  }

  it("same scenario twice yields byte-identical ids and state", () => {
    const [a, b] = runTwice((s) => {
      prompt(s);
      resolveEffect(s, ids.modelEffect(msg0), {
        kind: "model",
        blocks: [{ type: "toolCall", id: "tc-1", name: "read", arguments: {} }],
        stopReason: "completed",
      });
      resolveEffect(s, ids.invocationEffect("tc-1"), {
        kind: "tool",
        result: null,
        isError: false,
      });
    });
    expect(JSON.stringify(a.log)).toBe(JSON.stringify(b.log));
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });

  it("duplicate append of a deterministic id is a replay no-op", () => {
    const s = scenario();
    prompt(s);
    const before = s.log.length;
    applyAppend(s, [
      {
        envelopeId: ids.turnOpened(turn1),
        payloadKind: "turn.opened",
        payload: { protocol: "agentic.trajectory.v1" },
        causality: { turnId: turn1 },
      },
    ]);
    expect(s.log.length).toBe(before);
  });

  it("message.delta is rejected by the fold (signal-only transport)", () => {
    const s = scenario();
    expect(() =>
      applyAppend(s, [
        {
          envelopeId: "delta-1",
          payloadKind: "message.delta",
          payload: {
            protocol: "agentic.trajectory.v1",
            blockId: "b",
            type: "text",
            text: "x",
          },
          causality: { messageId: "m" as never },
        },
      ]),
    ).toThrow(/never be appended/u);
  });

  describe("overlayInputConfig (fold-cache reload)", () => {
    it("preserves the fold-derived roster while overlaying input settings", () => {
      // The vessel injects an EMPTY sentinel roster (roster folds from
      // system.event); a naive overlay would wipe the folded roster on every
      // reload and silently break channel tools (AL-6 regression).
      const folded: AgentLoopConfig = {
        ...baseConfig,
        model: "old-model",
        roster: {
          participants: [
            {
              participantId: "panel:x",
              ref: { kind: "panel", id: "panel:x", participantId: "panel:x" },
              methods: [{ name: "eval" }],
            },
          ],
        },
      };
      const input: AgentLoopConfig = {
        ...baseConfig,
        model: "new-model",
        systemPromptHash: "blob:updated",
        activeToolNames: ["read", "write", "eval"],
        roster: { participants: [] }, // empty sentinel from the vessel
      };

      const merged = overlayInputConfig(folded, input);

      // input-owned settings win
      expect(merged.model).toBe("new-model");
      expect(merged.systemPromptHash).toBe("blob:updated");
      expect(merged.activeToolNames).toEqual(["read", "write", "eval"]);
      // fold-owned roster survives the reload
      expect(merged.roster.participants).toHaveLength(1);
      expect(merged.roster.participants[0]!.participantId).toBe("panel:x");
    });
  });
});

describe("agent-loop message delivery (acks, edit/retract, after-turn, flush)", () => {
  const userRef = {
    kind: "user" as const,
    id: "panel:user",
    participantId: "panel:user",
  };

  function promptWith(
    s: Scenario,
    opts: {
      envelopeId: string;
      sourceMessageId?: string;
      content?: string;
      metadata?: { deliverAfterTurn?: boolean };
    },
  ): void {
    dispatch(s, {
      type: "command",
      command: {
        kind: "prompt",
        channelId: "chan-1",
        source: { envelopeId: opts.envelopeId },
        ...(opts.sourceMessageId
          ? { sourceMessageId: opts.sourceMessageId }
          : {}),
        content: opts.content ?? "hello",
        senderRef: userRef,
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
      },
    });
    drainPromptArtifactPreparations(s);
  }

  function readAcks(
    s: Scenario,
  ): Array<{ messageId: string; turnId?: string }> {
    return s.outputs
      .flatMap((output) => output.effects)
      .filter((effect) => effect.kind === "record_receipt")
      .map((effect) => {
        const receipt = effect as { messageId: string; turnId: string };
        return { messageId: receipt.messageId, turnId: receipt.turnId };
      });
  }

  it("emits a read ack when a fresh prompt is folded into a model call", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    const acks = readAcks(s);
    expect(acks.map((ack) => ack.messageId)).toContain("u1");
    expect(acks.find((ack) => ack.messageId === "u1")?.turnId).toBe(turn1);
  });

  it("fires the read ack for a mid-turn-steered message on the continuation model call", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    // steer arrives while the first model call is in flight → queued, no ack yet
    dispatch(s, {
      type: "command",
      command: {
        kind: "steer",
        channelId: "chan-1",
        source: { envelopeId: "env-2" },
        sourceMessageId: "s1",
        content: "more",
        senderRef: userRef,
      },
    });
    expect(readAcks(s).map((ack) => ack.messageId)).not.toContain("s1");
    drainPromptArtifactPreparations(s);
    // model completes text-only with a steer queued → continuation consumes it
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "text", content: "ok" }],
      stopReason: "completed",
    });
    expect(readAcks(s).map((ack) => ack.messageId)).toContain("s1");
  });

  it("holds an after-turn message out of context and fires NO extra model call", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    const before = pendingEffectIds(s);
    const outputsBefore = s.outputs.length;
    promptWith(s, {
      envelopeId: "env-2",
      sourceMessageId: "d1",
      content: "later",
      metadata: { deliverAfterTurn: true },
    });
    // recv appended, but no NEW model_call effect and no context entry
    expect(pendingEffectIds(s)).toEqual(before);
    expect(s.state.deferredPostTurnQueue.map((d) => d.sourceMessageId)).toEqual(
      ["d1"],
    );
    expect(
      s.state.entries.some(
        (e) => e.kind === "user" && e.sourceMessageId === "d1",
      ),
    ).toBe(false);
    const newModelCalls = s.outputs
      .slice(outputsBefore)
      .flatMap((o) => o.effects)
      .filter((e) => e.kind === "model_call");
    expect(newModelCalls).toHaveLength(0);
  });

  it("delivers an after-turn message immediately when the open turn is parked", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "suspend-1",
          name: "suspend_turn",
          arguments: { reason: "waiting_for_background" },
        },
      ],
      stopReason: "completed",
    });
    resolveEffect(s, ids.invocationEffect("suspend-1"), {
      kind: "tool",
      result: {
        protocolContent: [{ type: "text", text: "Turn suspended." }],
        details: { suspendTurn: true, reason: "waiting_for_background" },
      },
      turnControl: {
        kind: "suspend",
        reason: "waiting_for_background",
        summary: "Suspended until background work or user input arrives",
      },
      isError: false,
    });

    expect(s.state.openTurn?.waitingAtSeq).toBeDefined();
    expect(pendingEffectIds(s)).toEqual([]);

    promptWith(s, {
      envelopeId: "env-terminal",
      sourceMessageId: "subagent-terminal:run-1",
      content: "Subagent run-1 completed.",
      metadata: { deliverAfterTurn: true },
    });

    expect(s.state.deferredPostTurnQueue).toHaveLength(0);
    expect(s.state.openTurn?.waitingAtSeq).toBeUndefined();
    expect(
      s.state.entries.some(
        (entry) =>
          entry.kind === "user" &&
          entry.sourceMessageId === "subagent-terminal:run-1",
      ),
    ).toBe(true);
    expect(pendingEffectIds(s)).toEqual([
      ids.modelEffect(ids.messageId(turn1, 1)),
      `read:subagent-terminal:run-1:${turn1}`,
      `read:u1:${turn1}`,
    ]);
  });

  it("releases an after-turn message that arrives before suspension settles", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "suspend-1",
          name: "suspend_turn",
          arguments: { reason: "waiting_for_background" },
        },
      ],
      stopReason: "completed",
    });

    promptWith(s, {
      envelopeId: "env-terminal",
      sourceMessageId: "subagent-terminal:run-1",
      content: "Subagent run-1 completed.",
      metadata: { deliverAfterTurn: true },
    });
    expect(
      s.state.deferredPostTurnQueue.map((entry) => entry.sourceMessageId),
    ).toEqual(["subagent-terminal:run-1"]);

    resolveEffect(s, ids.invocationEffect("suspend-1"), {
      kind: "tool",
      result: {
        protocolContent: [{ type: "text", text: "Turn suspended." }],
        details: { suspendTurn: true, reason: "waiting_for_background" },
      },
      turnControl: {
        kind: "suspend",
        reason: "waiting_for_background",
        summary: "Suspended until background work or user input arrives",
      },
      isError: false,
    });

    expect(s.state.deferredPostTurnQueue).toHaveLength(0);
    expect(s.state.openTurn?.turnId).toBe(turn1);
    expect(s.state.openTurn?.waitingAtSeq).toBeUndefined();
    expect(
      s.state.entries.some(
        (entry) =>
          entry.kind === "user" &&
          entry.sourceMessageId === "subagent-terminal:run-1",
      ),
    ).toBe(true);
    expect(pendingEffectIds(s)).toEqual([
      ids.modelEffect(ids.messageId(turn1, 1)),
      `read:subagent-terminal:run-1:${turn1}`,
      `read:u1:${turn1}`,
    ]);
    expect(
      s.outputs
        .flatMap((output) => output.append)
        .some((item) => item.payloadKind === "turn.closed"),
    ).toBe(false);
  });

  it("does not lose a sibling terminal when user steering races the first terminal wake", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "suspend-1",
          name: "suspend_turn",
          arguments: { reason: "waiting_for_background" },
        },
      ],
      stopReason: "completed",
    });
    resolveEffect(s, ids.invocationEffect("suspend-1"), {
      kind: "tool",
      result: {
        protocolContent: [{ type: "text", text: "Turn suspended." }],
        details: { suspendTurn: true, reason: "waiting_for_background" },
      },
      turnControl: {
        kind: "suspend",
        reason: "waiting_for_background",
        summary: "Suspended until background work or user input arrives",
      },
      isError: false,
    });

    promptWith(s, {
      envelopeId: "env-terminal-1",
      sourceMessageId: "subagent-terminal:run-1",
      content: "Subagent run-1 completed.",
      metadata: { deliverAfterTurn: true },
    });
    const firstTerminalModel = ids.modelEffect(ids.messageId(turn1, 1));
    expect(pendingEffectIds(s)).toEqual([
      firstTerminalModel,
      `read:subagent-terminal:run-1:${turn1}`,
      `read:u1:${turn1}`,
    ]);

    dispatch(s, {
      type: "command",
      command: {
        kind: "steer",
        channelId: "chan-1",
        source: { envelopeId: "env-user-wake" },
        sourceMessageId: "u2",
        content: "What has finished so far?",
        senderRef: userRef,
      },
    });
    promptWith(s, {
      envelopeId: "env-terminal-2",
      sourceMessageId: "subagent-terminal:run-2",
      content: "Subagent run-2 completed.",
      metadata: { deliverAfterTurn: true },
    });

    expect(s.state.steeringQueue.map((entry) => entry.sourceMessageId)).toEqual(
      ["u2"],
    );
    expect(
      s.state.deferredPostTurnQueue.map((entry) => entry.sourceMessageId),
    ).toEqual(["subagent-terminal:run-2"]);

    resolveEffect(s, firstTerminalModel, {
      kind: "model",
      blocks: [{ type: "text", content: "The first child finished." }],
      stopReason: "completed",
    });
    const steeredModel = ids.modelEffect(ids.messageId(turn1, 2));
    expect(pendingEffectIds(s)).toEqual([
      steeredModel,
      `read:subagent-terminal:run-1:${turn1}`,
      `read:u1:${turn1}`,
      `read:u2:${turn1}`,
    ]);
    expect(
      s.state.deferredPostTurnQueue.map((entry) => entry.sourceMessageId),
    ).toEqual(["subagent-terminal:run-2"]);

    resolveEffect(s, steeredModel, {
      kind: "model",
      blocks: [{ type: "text", content: "Here is the current status." }],
      stopReason: "completed",
    });

    expect(s.state.deferredPostTurnQueue).toHaveLength(0);
    expect(
      s.state.entries.some(
        (entry) =>
          entry.kind === "user" &&
          entry.sourceMessageId === "subagent-terminal:run-2",
      ),
    ).toBe(true);
    expect(readAcks(s).map((ack) => ack.messageId)).toEqual(
      expect.arrayContaining([
        "subagent-terminal:run-1",
        "u2",
        "subagent-terminal:run-2",
      ]),
    );
    expect(pendingEffectIds(s).some((id) => id.includes("model"))).toBe(true);
  });

  it("does not let future-turn artifact preparation deadlock the current tool continuation", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-slow",
          name: "read",
          arguments: { path: "a.ts" },
        },
      ],
      stopReason: "completed",
    });

    dispatch(s, {
      type: "command",
      command: {
        kind: "prompt",
        channelId: "chan-1",
        source: { envelopeId: "env-2" },
        sourceMessageId: "d1",
        content: "after this turn",
        senderRef: userRef,
        metadata: { deliverAfterTurn: true },
      },
    });

    const deferredPreparation = ids.promptArtifactsEffect(
      ids.recvUserMessage("chan-1", "env-2"),
    );
    expect(pendingEffectIds(s)).toEqual(
      expect.arrayContaining([
        ids.invocationEffect("tc-slow"),
        deferredPreparation,
      ]),
    );

    resolveEffect(s, ids.invocationEffect("tc-slow"), {
      kind: "tool",
      result: "timed out",
      isError: true,
    });

    expect(pendingEffectIds(s)).toEqual(
      expect.arrayContaining([
        ids.modelEffect(ids.messageId(turn1, 1)),
        deferredPreparation,
      ]),
    );
    expect(
      s.state.deferredPostTurnQueue.map((item) => item.sourceMessageId),
    ).toEqual(["d1"]);
    expect(
      s.state.entries.some(
        (entry) => entry.kind === "user" && entry.sourceMessageId === "d1",
      ),
    ).toBe(false);
  });

  it("promotes deferred messages one-per-turn after each close, with fresh envelope ids", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    promptWith(s, {
      envelopeId: "env-2",
      sourceMessageId: "d1",
      metadata: { deliverAfterTurn: true },
    });
    promptWith(s, {
      envelopeId: "env-3",
      sourceMessageId: "d2",
      metadata: { deliverAfterTurn: true },
    });
    expect(s.state.deferredPostTurnQueue.map((d) => d.sourceMessageId)).toEqual(
      ["d1", "d2"],
    );

    // first turn closes → promote d1 into its own fresh turn
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "text", content: "done" }],
      stopReason: "completed",
    });
    expect(s.state.deferredPostTurnQueue.map((d) => d.sourceMessageId)).toEqual(
      ["d2"],
    );
    expect(s.state.openTurn).not.toBeNull();
    // promoted recv used a fresh deterministic id (not the arrival env-2)
    const promoted = s.log.find((row) =>
      row.envelopeId.startsWith("recv:promoted:d1:"),
    );
    expect(promoted).toBeDefined();
    const promotedTurn = s.log.find(
      (row) =>
        row.payloadKind === "turn.opened" &&
        (row.causality as { turnId?: string } | undefined)?.turnId ===
          s.state.openTurn?.turnId,
    );
    expect(
      (promotedTurn?.causality as { messageId?: string } | undefined)
        ?.messageId,
    ).toBe(promoted?.envelopeId);

    // d1's turn closes → promote d2
    const d1Msg = ids.messageId(s.state.openTurn!.turnId, 0);
    resolveEffect(s, ids.modelEffect(d1Msg), {
      kind: "model",
      blocks: [{ type: "text", content: "done d1" }],
      stopReason: "completed",
    });
    expect(s.state.deferredPostTurnQueue).toHaveLength(0);
    expect(s.state.openTurn).not.toBeNull();
    expect(readAcks(s).map((ack) => ack.messageId)).toEqual(
      expect.arrayContaining(["u1", "d1", "d2"]),
    );
  });

  it("edits queued steer content before read", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    dispatch(s, {
      type: "command",
      command: {
        kind: "steer",
        channelId: "chan-1",
        source: { envelopeId: "env-2" },
        sourceMessageId: "s1",
        content: "first",
        senderRef: userRef,
      },
    });
    dispatch(s, {
      type: "command",
      command: {
        kind: "edit",
        sourceMessageId: "s1",
        blocks: [{ type: "text", content: "edited" }],
        by: userRef,
      },
    });
    const entry = s.state.steeringQueue.find((e) => e.sourceMessageId === "s1");
    expect((entry?.content as { blocks?: unknown }).blocks).toEqual([
      { type: "text", content: "edited" },
    ]);
  });

  it("no-ops an edit/retract after the message was read (consumed into context)", () => {
    const s = scenario();
    // u1 is folded into the first model call → consumed (read); only in entries.
    promptWith(s, {
      envelopeId: "env-1",
      sourceMessageId: "u1",
      content: "original",
    });
    const entryBefore = s.state.entries.find(
      (e) => e.kind === "user" && e.sourceMessageId === "u1",
    );
    expect(entryBefore).toBeDefined();
    dispatch(s, {
      type: "command",
      command: {
        kind: "edit",
        sourceMessageId: "u1",
        blocks: [{ type: "text", content: "x" }],
        by: userRef,
      },
    });
    dispatch(s, {
      type: "command",
      command: { kind: "retract", sourceMessageId: "u1", by: userRef },
    });
    // read wins: the consumed entry is untouched, never removed.
    const entryAfter = s.state.entries.find(
      (e) => e.kind === "user" && e.sourceMessageId === "u1",
    );
    expect(entryAfter).toEqual(entryBefore);
  });

  it("retracts a queued steer before read", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    dispatch(s, {
      type: "command",
      command: {
        kind: "steer",
        channelId: "chan-1",
        source: { envelopeId: "env-2" },
        sourceMessageId: "s1",
        content: "oops",
        senderRef: userRef,
      },
    });
    expect(s.state.steeringQueue).toHaveLength(1);
    dispatch(s, {
      type: "command",
      command: { kind: "retract", sourceMessageId: "s1", by: userRef },
    });
    expect(s.state.steeringQueue).toHaveLength(0);
  });

  it("flush with queued steers delivers the steers and leaves the deferred queue intact", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    dispatch(s, {
      type: "command",
      command: {
        kind: "steer",
        channelId: "chan-1",
        source: { envelopeId: "env-2" },
        sourceMessageId: "s1",
        content: "now",
        senderRef: userRef,
      },
    });
    promptWith(s, {
      envelopeId: "env-3",
      sourceMessageId: "d1",
      metadata: { deliverAfterTurn: true },
    });
    // flush: steers present + model in flight → soft flush marker
    dispatch(s, {
      type: "command",
      command: { kind: "interrupt", flushDeferred: true },
    });
    expect(s.state.openTurn?.pendingFlush).toBe("steers");
    expect(s.state.deferredPostTurnQueue.map((d) => d.sourceMessageId)).toEqual(
      ["d1"],
    );
    // aborted model terminal → continuation consumes the steer (turn stays open)
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [],
      stopReason: "aborted",
    });
    expect(s.state.openTurn).not.toBeNull();
    expect(readAcks(s).map((ack) => ack.messageId)).toContain("s1");
    expect(s.state.deferredPostTurnQueue.map((d) => d.sourceMessageId)).toEqual(
      ["d1"],
    );
  });

  it("allows repeated soft flushes in the same turn", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    dispatch(s, {
      type: "command",
      command: {
        kind: "steer",
        channelId: "chan-1",
        source: { envelopeId: "env-2" },
        sourceMessageId: "s1",
        content: "first steer",
        senderRef: userRef,
      },
    });
    drainPromptArtifactPreparations(s);

    dispatch(s, {
      type: "command",
      command: { kind: "interrupt", flushDeferred: true },
    });
    const firstFlushId = s.log.find(
      (row) =>
        row.payloadKind === "system.event" &&
        row.envelopeId.includes("flush-steers"),
    )?.envelopeId;
    expect(firstFlushId).toBeDefined();
    expect(s.state.openTurn?.pendingFlush).toBe("steers");
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [],
      stopReason: "aborted",
    });
    expect(readAcks(s).map((ack) => ack.messageId)).toContain("s1");

    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toContain(ids.modelEffect(msg1));
    dispatch(s, {
      type: "command",
      command: {
        kind: "steer",
        channelId: "chan-1",
        source: { envelopeId: "env-3" },
        sourceMessageId: "s2",
        content: "second steer",
        senderRef: userRef,
      },
    });
    drainPromptArtifactPreparations(s);

    dispatch(s, {
      type: "command",
      command: { kind: "interrupt", flushDeferred: true },
    });
    const flushIds = s.log
      .filter(
        (row) =>
          row.payloadKind === "system.event" &&
          row.envelopeId.includes("flush-steers"),
      )
      .map((row) => row.envelopeId);
    expect(flushIds).toHaveLength(2);
    expect(flushIds[1]).not.toBe(firstFlushId);
    expect(s.state.openTurn?.pendingFlush).toBe("steers");

    resolveEffect(s, ids.modelEffect(msg1), {
      kind: "model",
      blocks: [],
      stopReason: "aborted",
    });
    expect(s.state.openTurn).not.toBeNull();
    expect(readAcks(s).map((ack) => ack.messageId)).toContain("s2");
  });

  it("flush against a turn waiting on a pending invocation cancels it and delivers the steers", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    // The model parks on a tool call (e.g. a feedback form) — the invocation
    // stays pending, no model in flight, so wakeGuard is unsatisfied.
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        { type: "toolCall", id: "tc-1", name: "feedback_form", arguments: {} },
      ],
      stopReason: "completed",
    });
    expect(pendingEffectIds(s)).toEqual([ids.invocationEffect("tc-1")]);
    expect(s.state.openTurn).not.toBeNull();
    // Queue a steer while blocked → lands in the steering queue (no ack yet).
    dispatch(s, {
      type: "command",
      command: {
        kind: "steer",
        channelId: "chan-1",
        source: { envelopeId: "env-2" },
        sourceMessageId: "s1",
        content: "actually do X",
        senderRef: userRef,
      },
    });
    drainPromptArtifactPreparations(s);
    expect(s.state.steeringQueue.map((e) => e.sourceMessageId)).toEqual(["s1"]);
    // Flush ("Send now"): abandon the pending form + deliver the steer.
    dispatch(s, {
      type: "command",
      command: { kind: "interrupt", flushDeferred: true },
    });
    // The pending invocation was cancelled (a valid cancelled tool-result)...
    const cancelled = s.log.find(
      (r) => r.payloadKind === "invocation.cancelled",
    );
    expect(cancelled).toBeTruthy();
    // ...and the cancel carries the transportCallId the provider knows, so a
    // panel feedback form can correlate it and dismiss (not linger on screen).
    expect(
      (cancelled!.causality as { transportCallId?: string }).transportCallId,
    ).toBe(ids.transportCallId("tc-1"));
    // ...a fresh turn opened that folds + read-acks the steer, and the steer
    // queue drained — i.e. the agent actually makes progress.
    expect(readAcks(s).map((a) => a.messageId)).toContain("s1");
    expect(s.state.steeringQueue).toEqual([]);
    expect(s.state.openTurn).not.toBeNull();
    expect(pendingEffectIds(s).some((id) => id.includes("model"))).toBe(true);
  });

  it("flush with no steers promotes exactly one deferred head per flush", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    promptWith(s, {
      envelopeId: "env-2",
      sourceMessageId: "d1",
      metadata: { deliverAfterTurn: true },
    });
    promptWith(s, {
      envelopeId: "env-3",
      sourceMessageId: "d2",
      metadata: { deliverAfterTurn: true },
    });
    // flush: no steers, model in flight, deferred present → hard interrupt + close
    dispatch(s, {
      type: "command",
      command: { kind: "interrupt", flushDeferred: true },
    });
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [],
      stopReason: "aborted",
    });
    // one head promoted into a fresh turn; the other still queued
    expect(s.state.deferredPostTurnQueue.map((d) => d.sourceMessageId)).toEqual(
      ["d2"],
    );
    expect(s.state.openTurn).not.toBeNull();
  });
});
