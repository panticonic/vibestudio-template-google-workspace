import { describe, expect, it, vi } from "vitest";
import { DURABLE_OBJECT_FRAMEWORK_RPC_METHODS } from "@vibestudio/durable";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { rpcExposedMethodNames } from "@vibestudio/rpc";
import { executionSessionNonceFor } from "@vibestudio/rpc/internal";
import { missionsMethods } from "@vibestudio/service-schemas/missions";
import type {
  MissionCharter,
  MissionAuthorityPlanReference,
  MissionRecord,
  MissionRunRecord,
} from "@vibestudio/automation/mission";
import { missionPrincipal } from "@vibestudio/automation/mission";
import { MissionsDO } from "./MissionsDO.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

class IdempotentLaunchMissionsDO extends MissionsDO {
  protected override get rpcIdempotencyKey(): string | null {
    return "agent-launch-request";
  }
}

class IdempotentCommandMissionsDO extends MissionsDO {
  protected override get rpcIdempotencyKey(): string | null {
    return "stable-command";
  }
}

class IdentityMissionsDO extends MissionsDO {
  identityForTest() {
    return {
      source: this.env["WORKER_SOURCE"],
      className: this.env["WORKER_CLASS_NAME"],
      objectKey: this.env["__objectKey"],
    };
  }
}

function agentCharter(summary = "Prepare a daily summary"): MissionCharter {
  return {
    summary,
    execution: {
      kind: "agent",
      image: {
        source: "workers/summary",
        ref: `state:${HASH_B}`,
        effectiveVersion: HASH_A,
        className: "SummaryAgent",
        objectKey: "daily",
      },
      action: { kind: "prompt", text: "Prepare a daily summary" },
      conversation: { mode: "fresh" },
      operations: [],
    },
    trigger: { kind: "manual" },
  };
}

function continuingAgentCharter(): MissionCharter {
  const charter = agentCharter("Continue the current conversation");
  if (charter.execution.kind !== "agent") throw new Error("Expected agent");
  charter.execution.conversation = {
    mode: "continue",
    channelId: "conversation:daily",
    contextId: "context:daily",
    executorId: "do:workers/summary:SummaryAgent:daily",
  };
  return charter;
}

function methodCharter(): MissionCharter {
  return {
    summary: "Check whether the rollout is complete",
    execution: {
      kind: "method",
      image: {
        source: "workers/rollout",
        ref: `state:${HASH_C}`,
        effectiveVersion: HASH_B,
        className: "RolloutWorker",
        objectKey: "primary",
      },
      method: "check",
      args: [{ deployment: "production" }],
      operations: [],
    },
    trigger: { kind: "manual" },
  };
}

function policy(digest = HASH_C): MissionAuthorityPlanReference {
  return {
    schemaVersion: 1,
    digest,
    artifactRef: `authority-plan:${digest}`,
    compilerVersion: "test-compiler",
    catalogDigest: HASH_A,
  };
}

const alice = {
  callerId: "panel:alice",
  callerKind: "panel" as const,
  userId: "alice",
};
const bob = {
  callerId: "panel:bob",
  callerKind: "panel" as const,
  userId: "bob",
};

async function createMissions<T extends typeof MissionsDO>(
  ctor: T = MissionsDO as T,
) {
  const result = await createTestDO(ctor, {
    WORKER_SOURCE: "workers/missions",
    WORKER_CLASS_NAME: "MissionsDO",
    __objectKey: "workspace-missions",
  });
  let authorityPlanDigest = HASH_C;
  const calls: Array<{
    target: string;
    method: string;
    args: unknown[];
    options?: unknown;
  }> = [];
  const rpcCall = vi.fn(
    async (
      target: string,
      method: string,
      args: unknown[] = [],
      options?: unknown,
    ): Promise<unknown> => {
      calls.push({ target, method, args, options });
      if (target === "main" && method === "authority.compileAuthorityPlan")
        return policy(authorityPlanDigest);
      if (target === "main" && method === "authority.acquireForTarget")
        return { requestIds: [], grantIds: ["grant:mission"], denialIds: [] };
      if (target === "main" && method === "authority.retireTarget")
        return { cancelledRequestCount: 0, revokedGrantCount: 1 };
      if (target === "main" && method.startsWith("workspace-state.alarm"))
        return undefined;
      throw new Error(`Unexpected RPC ${target}.${method}`);
    },
  );
  const noop = vi.fn();
  Object.defineProperty(result.instance, "rpc", {
    value: {
      call: rpcCall,
      expose: noop,
      exposeAll: noop,
      exposeStreaming: noop,
      stream: noop,
      streamReadable: noop,
      emit: noop,
      on: noop,
      peer: noop,
      status: noop,
      ready: noop,
      onStatusChange: noop,
    },
    configurable: true,
  });
  return {
    ...result,
    calls,
    rpcCall,
    setPolicyDigest(value: string) {
      authorityPlanDigest = value;
    },
  };
}

describe("MissionsDO", () => {
  it("runs under its installed Base provider identity", async () => {
    const { instance } = await createTestDO(IdentityMissionsDO, {
      WORKER_SOURCE: "workers/missions",
      WORKER_CLASS_NAME: "MissionsDO",
      __objectKey: "workspace-missions",
    });
    expect(instance.identityForTest()).toEqual({
      source: "workers/missions",
      className: "MissionsDO",
      objectKey: "workspace-missions",
    });
  });

  it("exposes exactly the typed builtin contract", async () => {
    const { instance } = await createMissions();
    const productMethods = [...rpcExposedMethodNames(instance)].filter(
      (method) => !DURABLE_OBJECT_FRAMEWORK_RPC_METHODS.has(method),
    );
    expect(productMethods.sort()).toEqual(Object.keys(missionsMethods).sort());
  });

  it("launches immediately with a host-compiled authority plan and user-bound durable authority", async () => {
    const { callAs, calls } = await createMissions();
    const created = await callAs<MissionRecord>(alice, "launch", {
      name: "Daily summary",
      charter: agentCharter(),
    });
    expect(created).toMatchObject({
      schemaVersion: 3,
      name: "Daily summary",
      state: "active",
      revision: 1,
      owner: { userId: "alice" },
      authorityPlan: policy(),
      authority: { requestIds: [], grantIds: ["grant:mission"], denialIds: [] },
    });
    expect(created.revisionDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(calls.map(({ method }) => method)).toEqual([
      "authority.compileAuthorityPlan",
      "authority.acquireForTarget",
    ]);
    expect(calls[1]?.args).toEqual([
      {
        targetSubject: missionPrincipal(
          created.missionId,
          created.revisionDigest,
        ),
        authorityPlanDigest: HASH_C,
      },
    ]);
    await expect(callAs(bob, "get", created.missionId)).rejects.toThrow(
      /Unknown automation/,
    );
  });

  it("deduplicates launch transport retries without duplicate definitions", async () => {
    const { callAs, sql } = await createMissions(IdempotentLaunchMissionsDO);
    const input = { name: "Daily summary", charter: agentCharter() };
    const first = await callAs<MissionRecord>(alice, "launch", input);
    const retry = await callAs<MissionRecord>(alice, "launch", input);
    expect(retry.missionId).toBe(first.missionId);
    expect(sql.exec("SELECT COUNT(*) AS count FROM missions").one()).toEqual({
      count: 1,
    });
    expect(
      sql.exec("SELECT COUNT(*) AS count FROM mission_launches").one(),
    ).toEqual({ count: 1 });
  });

  it("pause changes admission eligibility without discarding standing grants", async () => {
    const { callAs, calls } = await createMissions();
    const launched = await callAs<MissionRecord>(alice, "launch", {
      name: "Daily summary",
      charter: agentCharter(),
    });
    const acquiredBeforePause = calls.filter(
      ({ method }) => method === "authority.acquireForTarget",
    );
    const paused = await callAs<MissionRecord>(
      alice,
      "pause",
      launched.missionId,
    );
    const resumed = await callAs<MissionRecord>(
      alice,
      "resume",
      launched.missionId,
    );
    expect(paused.state).toBe("paused");
    expect(paused.authority).toEqual(launched.authority);
    expect(resumed.state).toBe("active");
    expect(resumed.authority).toEqual(launched.authority);
    expect(
      calls.filter(({ method }) => method === "authority.acquireForTarget"),
    ).toEqual(acquiredBeforePause);
    expect(
      calls.some(({ method }) => /revoke|retire|suspend/u.test(method)),
    ).toBe(false);
  });

  it("keeps open lifecycle controls scoped to the automation owner", async () => {
    const { callAs } = await createMissions();
    const launched = await callAs<MissionRecord>(alice, "launch", {
      name: "Daily summary",
      charter: agentCharter(),
    });

    await expect(callAs(bob, "pause", launched.missionId)).rejects.toThrow(
      /Unknown automation/,
    );
    expect(
      await callAs<MissionRecord>(alice, "get", launched.missionId),
    ).toMatchObject({ state: "active" });
  });

  it("edits by creating a new immutable revision subject and policy", async () => {
    const harness = await createMissions();
    const launched = await harness.callAs<MissionRecord>(alice, "launch", {
      name: "Daily summary",
      charter: agentCharter(),
    });
    harness.setPolicyDigest(HASH_B);
    const edited = await harness.callAs<MissionRecord>(
      alice,
      "edit",
      launched.missionId,
      {
        name: "Focused summary",
        charter: agentCharter("Prepare a focused summary"),
      },
    );
    expect(edited).toMatchObject({
      missionId: launched.missionId,
      revision: 2,
      state: "active",
    });
    expect(edited.revisionDigest).not.toBe(launched.revisionDigest);
    expect(edited.authorityPlan.digest).toBe(HASH_B);
    expect(
      harness.calls
        .filter(({ method }) => method === "authority.acquireForTarget")
        .at(-1)?.args,
    ).toEqual([
      {
        targetSubject: missionPrincipal(
          edited.missionId,
          edited.revisionDigest,
        ),
        authorityPlanDigest: HASH_B,
      },
    ]);
    expect(
      harness.calls.find(({ method }) => method === "authority.retireTarget")
        ?.args,
    ).toEqual([
      {
        targetSubject: missionPrincipal(
          launched.missionId,
          launched.revisionDigest,
        ),
      },
    ]);
  });

  it("deduplicates edit retries to the exact committed revision", async () => {
    const harness = await createMissions(IdempotentCommandMissionsDO);
    const launched = await harness.callAs<MissionRecord>(alice, "launch", {
      name: "Daily summary",
      charter: agentCharter(),
    });
    harness.setPolicyDigest(HASH_B);
    const input = {
      name: "Focused summary",
      charter: agentCharter("Prepare a focused summary"),
    };
    const first = await harness.callAs<MissionRecord>(
      alice,
      "edit",
      launched.missionId,
      input,
    );
    const replay = await harness.callAs<MissionRecord>(
      alice,
      "edit",
      launched.missionId,
      input,
    );

    expect(replay).toEqual(first);
    expect(replay.revision).toBe(2);
    expect(
      harness.sql.exec("SELECT COUNT(*) AS count FROM mission_revisions").one(),
    ).toEqual({
      count: 1,
    });
    expect(
      harness.calls.filter(
        ({ method }) => method === "authority.compileAuthorityPlan",
      ),
    ).toHaveLength(2);
  });

  it("binds method dispatch to the admitted execution nonce and closes admission", async () => {
    const harness = await createMissions();
    harness.rpcCall.mockImplementation(
      async (target, method, args = [], options) => {
        harness.calls.push({ target, method, args, options });
        if (target === "main" && method === "authority.compileAuthorityPlan")
          return policy();
        if (target === "main" && method === "authority.acquireForTarget")
          return { requestIds: [], grantIds: ["grant:mission"], denialIds: [] };
        if (target === "main" && method === "runtime.createEntity")
          return {
            targetId: "do:workers/rollout:RolloutWorker:primary",
            contextId: (args[0] as { contextId?: string })?.contextId,
          };
        if (target === "main" && method === "authority.admitExecution")
          return { authoritySessionId: "admission:one", nonce: "nonce:one" };
        if (target === "main" && method === "authority.finishExecution")
          return undefined;
        if (
          target === "do:workers/rollout:RolloutWorker:primary" &&
          method === "check"
        )
          return { ready: true };
        if (target === "main" && method.startsWith("workspace-state.alarm"))
          return undefined;
        throw new Error(`Unexpected RPC ${target}.${method}`);
      },
    );
    const launched = await harness.callAs<MissionRecord>(alice, "launch", {
      name: "Rollout check",
      charter: methodCharter(),
    });
    const run = await harness.callAs<MissionRunRecord>(
      alice,
      "runNow",
      launched.missionId,
    );
    expect(run).toMatchObject({ phase: "terminal", outcome: "succeeded" });
    const dispatch = harness.calls.find(
      ({ target, method }) =>
        target === "do:workers/rollout:RolloutWorker:primary" &&
        method === "check",
    );
    expect(dispatch?.options).toMatchObject({
      idempotencyKey: `${run.runId}:dispatch`,
    });
    expect(executionSessionNonceFor(dispatch?.options as never)).toBe(
      "nonce:one",
    );
    expect(
      harness.calls.some(
        ({ method }) => method === "authority.finishExecution",
      ),
    ).toBe(true);
  });

  it("dispatches a continuing turn through the existing agent authority path", async () => {
    const harness = await createMissions();
    harness.rpcCall.mockImplementation(
      async (target, method, args = [], options) => {
        harness.calls.push({ target, method, args, options });
        if (target === "main" && method === "authority.compileAuthorityPlan")
          return policy();
        if (
          target === "do:workers/summary:SummaryAgent:daily" &&
          method === "runAutomationTurn"
        )
          return undefined;
        if (target === "main" && method.startsWith("workspace-state.alarm"))
          return undefined;
        throw new Error(`Unexpected RPC ${target}.${method}`);
      },
    );
    const mission = await harness.callAs<MissionRecord>(alice, "launch", {
      name: "Conversation reminder",
      charter: continuingAgentCharter(),
    });

    const run = await harness.callAs<MissionRunRecord>(
      alice,
      "runNow",
      mission.missionId,
    );

    expect(run).toMatchObject({
      phase: "executing",
      contextId: "context:daily",
      channelId: "conversation:daily",
      executorId: "do:workers/summary:SummaryAgent:daily",
    });
    expect(
      harness.calls.filter(
        ({ method }) =>
          method === "runtime.createContext" ||
          method === "runtime.createEntity" ||
          method === "subscribeChannel",
      ),
    ).toEqual([]);
    const dispatch = harness.calls.find(
      ({ target, method }) =>
        target === "do:workers/summary:SummaryAgent:daily" &&
        method === "runAutomationTurn",
    );
    expect(dispatch?.args).toEqual([
      expect.objectContaining({
        channelId: "conversation:daily",
        prompt: "Prepare a daily summary",
      }),
    ]);
    expect(
      executionSessionNonceFor(dispatch?.options as never),
    ).toBeUndefined();
    expect(
      harness.calls.filter(
        ({ method }) =>
          method === "authority.acquireForTarget" ||
          method === "authority.admitExecution",
      ),
    ).toEqual([]);

    await harness.callAs<MissionRecord>(alice, "retire", mission.missionId);
    expect(
      harness.sql
        .exec(
          "SELECT phase,outcome FROM mission_runs WHERE run_id=?",
          run.runId,
        )
        .one(),
    ).toEqual({ phase: "terminal", outcome: "interrupted" });
    expect(
      harness.calls.some(({ method }) => method === "authority.retireTarget"),
    ).toBe(false);
  });

  it("records an overlapping occurrence and raises one persistent run issue", async () => {
    const harness = await createMissions();
    const executorId = "do:workers/summary:SummaryAgent:daily";
    const gadTarget = "do:workers/workspace-source:GadWorkspaceDO:workspace";
    const notifications: Array<Record<string, unknown>> = [];
    harness.rpcCall.mockImplementation(async (target, method, args = []) => {
      if (target === "main" && method === "authority.compileAuthorityPlan")
        return policy();
      if (target === "main" && method === "authority.acquireForTarget")
        return { requestIds: [], grantIds: [], denialIds: [] };
      if (target === "main" && method === "authority.admitExecution")
        return {
          authoritySessionId: "admission:continuing",
          nonce: "nonce:continuing",
        };
      if (target === executorId && method === "runAutomationTurn")
        return undefined;
      if (target === "main" && method === "workers.resolveService")
        return { kind: "durable-object", targetId: gadTarget };
      if (target === gadTarget && method === "putUserNotification") {
        notifications.push(args[0] as Record<string, unknown>);
        return args[0];
      }
      if (target === "main" && method.startsWith("workspace-state.alarm"))
        return undefined;
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    const mission = await harness.callAs<MissionRecord>(alice, "launch", {
      name: "Conversation reminder",
      charter: continuingAgentCharter(),
    });
    const active = await harness.callAs<MissionRunRecord>(
      alice,
      "runNow",
      mission.missionId,
    );
    const blocked = await harness.callAs<MissionRunRecord>(
      alice,
      "runNow",
      mission.missionId,
    );

    expect(active.phase).toBe("executing");
    expect(blocked).toMatchObject({
      phase: "terminal",
      outcome: "skipped",
      failure: {
        code: "ERUNACTIVE",
        retry: "automatic",
      },
    });
    expect(notifications).toEqual([
      expect.objectContaining({
        id: `automation.run.overrun:${active.runId}`,
        kind: "automation.run.issue",
        title: "Conversation reminder is delayed",
        data: {
          missionId: mission.missionId,
          runId: active.runId,
          blockedRunId: blocked.runId,
        },
      }),
    ]);
  });

  it("deduplicates a retried manual run by its durable command identity", async () => {
    const harness = await createMissions(IdempotentCommandMissionsDO);
    let dispatches = 0;
    harness.rpcCall.mockImplementation(async (target, method, args = []) => {
      if (target === "main" && method === "authority.compileAuthorityPlan")
        return policy();
      if (target === "main" && method === "authority.acquireForTarget")
        return { requestIds: [], grantIds: [], denialIds: [] };
      if (target === "main" && method === "runtime.createEntity")
        return {
          targetId: "do:workers/rollout:RolloutWorker:primary",
          contextId: (args[0] as { contextId?: string })?.contextId,
        };
      if (target === "main" && method === "authority.admitExecution")
        return { authoritySessionId: "admission:one", nonce: "nonce:one" };
      if (target === "main" && method === "authority.finishExecution")
        return undefined;
      if (
        target === "do:workers/rollout:RolloutWorker:primary" &&
        method === "check"
      ) {
        dispatches += 1;
        return { ready: true };
      }
      if (target === "main" && method.startsWith("workspace-state.alarm"))
        return undefined;
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    const mission = await harness.callAs<MissionRecord>(alice, "launch", {
      name: "Rollout check",
      charter: methodCharter(),
    });
    const first = await harness.callAs<MissionRunRecord>(
      alice,
      "runNow",
      mission.missionId,
    );
    const replay = await harness.callAs<MissionRunRecord>(
      alice,
      "runNow",
      mission.missionId,
    );

    expect(replay.runId).toBe(first.runId);
    expect(dispatches).toBe(1);
    expect(
      harness.sql.exec("SELECT COUNT(*) AS count FROM mission_runs").one(),
    ).toEqual({
      count: 1,
    });
  });

  it("reconciles an executing turn from receiver-owned evidence", async () => {
    const harness = await createMissions(IdempotentCommandMissionsDO);
    const dispatchKeys: string[] = [];
    let admissions = 0;
    let executorStatus:
      | { state: "not-found" }
      | {
          state: "running";
          channelId: string;
          turnId: string;
          waiting: boolean;
        }
      | {
          state: "terminal";
          outcome: "succeeded";
          finalMessage: string;
        } = {
      state: "running",
      channelId: "do:workers/pubsub-channel:PubSubChannel:fresh",
      turnId: "turn:live",
      waiting: true,
    };
    let acknowledged = false;
    harness.rpcCall.mockImplementation(
      async (target, method, args = [], options) => {
        if (target === "main" && method === "authority.compileAuthorityPlan")
          return policy();
        if (target === "main" && method === "authority.acquireForTarget")
          return { requestIds: [], grantIds: [], denialIds: [] };
        if (target === "main" && method === "runtime.createContext")
          return { contextId: "ctx:fresh" };
        if (target === "main" && method === "runtime.createEntity") {
          const input = args[0] as { className?: string };
          return input.className === "PubSubChannel"
            ? {
                targetId: "do:workers/pubsub-channel:PubSubChannel:fresh",
                contextId: "ctx:fresh",
              }
            : {
                targetId: "do:workers/summary:SummaryAgent:daily-run",
                contextId: "ctx:fresh",
              };
        }
        if (method === "subscribeChannel") return undefined;
        if (target === "main" && method === "authority.admitExecution") {
          admissions += 1;
          return {
            authoritySessionId: `admission:turn:${admissions}`,
            nonce: `nonce:turn:${admissions}`,
          };
        }
        if (method === "runAutomationTurn") {
          dispatchKeys.push(
            (options as { idempotencyKey?: string }).idempotencyKey ?? "",
          );
          return undefined;
        }
        if (method === "describeAutomationRun") return executorStatus;
        if (method === "acknowledgeAutomationRun") {
          acknowledged = true;
          return undefined;
        }
        if (target === "main" && method === "authority.finishExecution")
          return undefined;
        if (target === "main" && method.startsWith("workspace-state.alarm"))
          return undefined;
        throw new Error(`Unexpected RPC ${target}.${method}`);
      },
    );
    const mission = await harness.callAs<MissionRecord>(alice, "launch", {
      name: "Daily summary",
      charter: agentCharter(),
    });
    const run = await harness.callAs<MissionRunRecord>(
      alice,
      "runNow",
      mission.missionId,
    );
    expect(run.phase).toBe("executing");
    harness.sql.exec(
      "UPDATE mission_runs SET progress_at=? WHERE run_id=?",
      Date.now() - 60_001,
      run.runId,
    );

    const wake = await harness.instance.alarm();

    expect(dispatchKeys).toEqual([`${run.runId}:dispatch`]);
    expect(
      await harness.callAs<MissionRunRecord>(alice, "getRun", run.runId),
    ).toMatchObject({ phase: "executing" });

    executorStatus = { state: "not-found" };
    harness.sql.exec(
      "UPDATE mission_runs SET progress_at=? WHERE run_id=?",
      Date.now() - 60_001,
      run.runId,
    );
    await harness.instance.alarm();

    expect(dispatchKeys).toEqual([
      `${run.runId}:dispatch`,
      `${run.runId}:dispatch`,
    ]);
    expect(
      harness.sql
        .exec(
          "SELECT authority_session_id FROM mission_runs WHERE run_id=?",
          run.runId,
        )
        .one(),
    ).toEqual({ authority_session_id: "admission:turn:3" });

    executorStatus = {
      state: "terminal",
      outcome: "succeeded",
      finalMessage: "Summary sent.",
    };
    harness.sql.exec(
      "UPDATE mission_runs SET progress_at=? WHERE run_id=?",
      Date.now() - 60_001,
      run.runId,
    );
    await harness.instance.alarm();
    expect(
      await harness.callAs<MissionRunRecord>(alice, "getRun", run.runId),
    ).toMatchObject({
      phase: "terminal",
      outcome: "succeeded",
      finalMessage: "Summary sent.",
    });
    expect(acknowledged).toBe(true);
    expect(wake?.wakeAt).toBeGreaterThan(Date.now());
  });

  it("skips a scheduled occurrence that was missed while the workspace was unavailable", async () => {
    const harness = await createMissions();
    const charter = agentCharter();
    charter.trigger = { kind: "schedule", everyMs: 60_000 };
    const mission = await harness.callAs<MissionRecord>(alice, "launch", {
      name: "Daily summary",
      charter,
    });
    const now = Date.now();
    harness.sql.exec(
      "UPDATE missions SET next_run_at=? WHERE mission_id=?",
      now - 5_001,
      mission.missionId,
    );

    const wake = await harness.instance.alarm();

    expect(
      harness.sql.exec("SELECT COUNT(*) AS count FROM mission_runs").one(),
    ).toEqual({ count: 0 });
    expect(wake?.wakeAt).toBeGreaterThan(now);
  });

  it("records failed child effects without misreporting the run as succeeded", async () => {
    const harness = await createMissions(IdempotentCommandMissionsDO);
    const executorId = "do:workers/summary:SummaryAgent:daily-run";
    const gadTarget = "do:workers/workspace-source:GadWorkspaceDO:workspace";
    let gadAvailable = false;
    let closeAvailable = false;
    harness.rpcCall.mockImplementation(async (target, method, args = []) => {
      if (target === "main" && method === "authority.compileAuthorityPlan")
        return policy();
      if (target === "main" && method === "authority.acquireForTarget")
        return { requestIds: [], grantIds: [], denialIds: [] };
      if (target === "main" && method === "runtime.createContext")
        return { contextId: "ctx:fresh" };
      if (target === "main" && method === "runtime.createEntity") {
        const input = args[0] as { className?: string };
        return input.className === "PubSubChannel"
          ? {
              targetId: "do:workers/pubsub-channel:PubSubChannel:fresh",
              contextId: "ctx:fresh",
            }
          : { targetId: executorId, contextId: "ctx:fresh" };
      }
      if (method === "subscribeChannel" || method === "runAutomationTurn")
        return undefined;
      if (method === "acknowledgeAutomationRun") return undefined;
      if (target === "main" && method === "authority.admitExecution")
        return { authoritySessionId: "admission:turn", nonce: "nonce:turn" };
      if (target === "main" && method === "authority.finishExecution") {
        if (!closeAvailable) throw new Error("authority closure unavailable");
        return undefined;
      }
      if (target === "main" && method === "workers.resolveService")
        return { kind: "durable-object", targetId: gadTarget };
      if (target === gadTarget && method === "putUserNotification") {
        if (!gadAvailable) throw new Error("GAD temporarily unavailable");
        return args[0];
      }
      if (target === "main" && method.startsWith("workspace-state.alarm"))
        return undefined;
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    const charter = agentCharter();
    charter.trigger = { kind: "schedule", everyMs: 60_000, maxRuns: 1 };
    const mission = await harness.callAs<MissionRecord>(alice, "launch", {
      name: "Daily summary",
      charter,
    });
    const run = await harness.callAs<MissionRunRecord>(
      alice,
      "runNow",
      mission.missionId,
    );
    const effectFailure = {
      invocationId: "notify-call",
      name: "notify",
      outcome: "tool_error" as const,
      code: "EDELIVERY",
      message: "Notification delivery failed",
    };

    const finishInput = {
      runId: run.runId,
      outcome: "completed-with-errors" as const,
      finalMessage: "The notification could not be delivered.",
      effectFailures: [effectFailure],
    };

    await expect(
      harness.callAs<void>(
        { callerId: executorId, callerKind: "do" },
        "finishRun",
        finishInput,
      ),
    ).rejects.toThrow("authority closure unavailable");
    expect(
      await harness.callAs<MissionRunRecord>(alice, "getRun", run.runId),
    ).toMatchObject({ phase: "executing" });

    closeAvailable = true;
    await harness.callAs<void>(
      { callerId: executorId, callerKind: "do" },
      "finishRun",
      finishInput,
    );

    expect(
      await harness.callAs<MissionRunRecord>(alice, "getRun", run.runId),
    ).toMatchObject({
      phase: "terminal",
      outcome: "completed-with-errors",
      effectFailures: [effectFailure],
    });
    const overview = await harness.callAs<{
      items: Array<{ issueRunsSince: number }>;
    }>(alice, "overview", { missionId: mission.missionId });
    expect(overview.items[0]?.issueRunsSince).toBe(1);
    expect(
      await harness.callAs<MissionRecord>(alice, "get", mission.missionId),
    ).toMatchObject({ state: "completed", completionReason: "max-runs" });
    expect(
      harness.sql.exec("SELECT attempts FROM mission_effects").one(),
    ).toEqual({
      attempts: 1,
    });
    expect(
      harness.rpcCall.mock.calls.find(
        ([target, method]) =>
          target === gadTarget && method === "putUserNotification",
      ),
    ).toMatchObject([
      gadTarget,
      "putUserNotification",
      [
        expect.objectContaining({
          id: `automation.run.issue:${run.runId}`,
          userId: "alice",
          kind: "automation.run.issue",
          message: "notify: Notification delivery failed",
        }),
      ],
      undefined,
    ]);

    gadAvailable = true;
    harness.sql.exec("UPDATE mission_effects SET next_attempt_at=0");
    await harness.instance.alarm();
    expect(
      harness.sql.exec("SELECT COUNT(*) AS count FROM mission_effects").one(),
    ).toEqual({
      count: 0,
    });
  });

  it("keeps a retryable remote failure nonterminal and later settles the same run", async () => {
    const harness = await createMissions(IdempotentCommandMissionsDO);
    let dispatches = 0;
    harness.rpcCall.mockImplementation(async (target, method, args = []) => {
      if (target === "main" && method === "authority.compileAuthorityPlan")
        return policy();
      if (target === "main" && method === "authority.acquireForTarget")
        return { requestIds: [], grantIds: [], denialIds: [] };
      if (target === "main" && method === "runtime.createEntity")
        return {
          targetId: "do:workers/rollout:RolloutWorker:primary",
          contextId: (args[0] as { contextId?: string })?.contextId,
        };
      if (target === "main" && method === "authority.admitExecution")
        return { authoritySessionId: "admission:retry", nonce: "nonce:retry" };
      if (target === "main" && method === "authority.finishExecution")
        return undefined;
      if (
        target === "do:workers/rollout:RolloutWorker:primary" &&
        method === "check"
      ) {
        dispatches += 1;
        if (dispatches === 1)
          throw Object.assign(new Error("transport unavailable"), {
            code: "EUNAVAILABLE",
          });
        return { ready: true };
      }
      if (target === "main" && method.startsWith("workspace-state.alarm"))
        return undefined;
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    const mission = await harness.callAs<MissionRecord>(alice, "launch", {
      name: "Rollout check",
      charter: methodCharter(),
    });
    const first = await harness.callAs<MissionRunRecord>(
      alice,
      "runNow",
      mission.missionId,
    );
    expect(first).toMatchObject({
      phase: "executing",
      failure: { code: "EUNAVAILABLE", retry: "automatic" },
    });
    harness.sql.exec(
      "UPDATE mission_runs SET progress_at=? WHERE run_id=?",
      Date.now() - 60_001,
      first.runId,
    );

    await harness.instance.alarm();

    expect(dispatches).toBe(2);
    expect(
      await harness.callAs<MissionRunRecord>(alice, "getRun", first.runId),
    ).toMatchObject({
      runId: first.runId,
      phase: "terminal",
      outcome: "succeeded",
    });
  });

  it("switches revisions before closing old executions and retiring old authority", async () => {
    const harness = await createMissions(IdempotentCommandMissionsDO);
    let compileCount = 0;
    const lifecycleObservations: Array<{
      method: string;
      revision: number;
      state: string;
    }> = [];
    harness.rpcCall.mockImplementation(async (target, method, args = []) => {
      if (target === "main" && method === "authority.compileAuthorityPlan") {
        compileCount += 1;
        return policy(compileCount === 1 ? HASH_C : HASH_B);
      }
      if (target === "main" && method === "authority.acquireForTarget")
        return { requestIds: [], grantIds: [], denialIds: [] };
      if (target === "main" && method === "runtime.createContext")
        return { contextId: "ctx:lifecycle" };
      if (target === "main" && method === "runtime.createEntity") {
        const input = args[0] as { className?: string };
        return input.className === "PubSubChannel"
          ? {
              targetId: "do:workers/pubsub-channel:PubSubChannel:lifecycle",
              contextId: "ctx:lifecycle",
            }
          : {
              targetId: "do:workers/summary:SummaryAgent:lifecycle",
              contextId: "ctx:lifecycle",
            };
      }
      if (method === "subscribeChannel" || method === "runAutomationTurn")
        return undefined;
      if (target === "main" && method === "authority.admitExecution")
        return {
          authoritySessionId: "admission:lifecycle",
          nonce: "nonce:lifecycle",
        };
      if (
        target === "main" &&
        (method === "authority.finishExecution" ||
          method === "authority.retireTarget")
      ) {
        const row = harness.sql
          .exec("SELECT revision,state FROM missions")
          .one();
        lifecycleObservations.push({
          method,
          revision: Number(row["revision"]),
          state: String(row["state"]),
        });
        return method === "authority.retireTarget"
          ? { cancelledRequestCount: 0, revokedGrantCount: 0 }
          : undefined;
      }
      if (target === "main" && method.startsWith("workspace-state.alarm"))
        return undefined;
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    const mission = await harness.callAs<MissionRecord>(alice, "launch", {
      name: "Daily summary",
      charter: agentCharter(),
    });
    await harness.callAs<MissionRunRecord>(alice, "runNow", mission.missionId);

    await harness.callAs<MissionRecord>(alice, "edit", mission.missionId, {
      charter: agentCharter("Prepare a focused summary"),
    });

    expect(lifecycleObservations).toEqual([
      { method: "authority.finishExecution", revision: 2, state: "active" },
      { method: "authority.retireTarget", revision: 2, state: "active" },
    ]);
  });
});
