import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const childProcessMock = vi.hoisted(() => {
  const stdout = { on: vi.fn(), off: vi.fn() };
  const stderr = { on: vi.fn(), off: vi.fn() };
  const child = {
    pid: 4242,
    on: vi.fn(),
    once: vi.fn(),
    kill: vi.fn(() => true),
    stdout,
    stderr,
  };
  child.on.mockReturnValue(child);
  child.once.mockReturnValue(child);
  return {
    child,
    spawn: vi.fn(() => child),
  };
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: childProcessMock.spawn,
}));

import { activate, parseClaudeStreamCompletion } from "./index.js";

const CHANNEL = "chan-1";
const CONTEXT = "ctx-1";
const agentId = (sequence: number): string =>
  `agt_${String(sequence).padStart(24, "0")}`;
const agentToken = (sequence: number): string =>
  `agent:${agentId(sequence)}:${String(sequence).padStart(43, "s")}`;
const activationSubscriptions: Array<Array<{ dispose(): void }>> = [];

function makeCtx(
  tmpRoot: string,
  storage = new Map<string, string>(),
  options: {
    failRevocationOnce?: string;
    failStart?: boolean;
    failStopOnce?: boolean;
    snapshot?: {
      state: "running" | "exited";
      exit: { code: number | null; signal: string | null; at: string } | null;
      log: { bytes: number; tail: string; truncated: boolean };
    };
  } = {},
) {
  const contextProjectionsPath = path.join(
    tmpRoot,
    ".context-projections",
    "v5",
  );
  const contextFolder = path.join(contextProjectionsPath, CONTEXT);
  mkdirSync(contextFolder, { recursive: true });

  let mintSeq = 0;
  const revoked: string[] = [];
  const lifecycleEvents: string[] = [];

  const rpcCall = vi.fn(
    async (target: string, method: string, ...args: unknown[]) => {
      if (method === "getContextId") return CONTEXT;
      if (method === "auth.getConnectionInfo") {
        return { serverId: `srv_${"s".repeat(24)}`, workspaceId: "ws" };
      }
      if (method === "runtime.createEntity") {
        const spec = args[0] as { kind: string; key: string };
        if (spec.kind === "session") {
          return {
            id: `session:${spec.key}`,
            contextId: CONTEXT,
            targetId: `session:${spec.key}`,
          };
        }
        return {
          id: `do:${spec.key}`,
          contextId: CONTEXT,
          targetId: `do:workers/linked-agent:LinkedAgentWorker:${spec.key}`,
        };
      }
      if (method === "subscribeChannel")
        return { ok: true, participantId: "p1" };
      if (method === "auth.mintAgentCredential") {
        mintSeq += 1;
        lifecycleEvents.push(`mint:${agentId(mintSeq)}`);
        return { agentId: agentId(mintSeq), agentToken: agentToken(mintSeq) };
      }
      if (method === "linkedClaude.start") {
        if (options.failStart)
          throw new Error("installed provider unavailable");
        const input = args[0] as {
          profile: {
            launchId: string;
            environment: { VIBESTUDIO_ENTITY_ID: string };
          };
        };
        return {
          generationId: input.profile.launchId,
          entityId: input.profile.environment.VIBESTUDIO_ENTITY_ID,
          state: "running",
          pid: 4242,
          exit: null,
          log: { bytes: 0, tail: "", truncated: false },
        };
      }
      if (method === "linkedClaude.continue") {
        return {
          generationId: (args[0] as { generationId: string }).generationId,
          entityId: (args[0] as { entityId: string }).entityId,
          state: "running",
          pid: 4343,
          exit: null,
          log: { bytes: 0, tail: "", truncated: false },
        };
      }
      if (method === "linkedClaude.interrupt") {
        return {
          generationId: (args[0] as { generationId: string }).generationId,
          entityId: (args[0] as { entityId: string }).entityId,
          state: "exited",
          pid: null,
          exit: { code: null, signal: "SIGTERM", at: new Date().toISOString() },
          log: { bytes: 0, tail: "", truncated: false },
        };
      }
      if (method === "linkedClaude.inspect") {
        const ref = args[0] as { generationId: string; entityId: string };
        return {
          generationId: ref.generationId,
          entityId: ref.entityId,
          state: options.snapshot?.state ?? "running",
          pid: options.snapshot?.state === "exited" ? null : 4242,
          exit: options.snapshot?.exit ?? null,
          log: options.snapshot?.log ?? {
            bytes: 0,
            tail: "",
            truncated: false,
          },
        };
      }
      if (method === "linkedClaude.stop") {
        if (options.failStopOnce) {
          options.failStopOnce = false;
          throw new Error("host retirement unconfirmed");
        }
        lifecycleEvents.push(
          `stop:${(args[0] as { generationId: string }).generationId}`,
        );
        return { stopped: true };
      }
      if (method === "auth.revokeAgentCredential") {
        lifecycleEvents.push(`revoke:${String(args[0])}`);
        if (options.failRevocationOnce === args[0]) {
          options.failRevocationOnce = undefined;
          throw new Error(`revocation failed for ${String(args[0])}`);
        }
        revoked.push(args[0] as string);
        return { revoked: true };
      }
      if (
        method === "reportExternalExit" ||
        method === "reportExternalResult"
      ) {
        return { ok: true, settled: true };
      }
      throw new Error(`unexpected rpc ${target} ${method}`);
    },
  );

  const approvalsRequest = vi.fn(async () => ({
    kind: "choice",
    choice: "allow",
  }));
  const subscriptions: Array<{ dispose(): void }> = [];
  activationSubscriptions.push(subscriptions);

  const ctx = {
    rpc: { call: rpcCall },
    workers: {
      resolveService: vi.fn(async () => ({
        kind: "durable-object",
        targetId: `do:PubSubChannel:${CHANNEL}`,
      })),
    },
    workspace: {
      getInfo: vi.fn(async () => ({
        id: "ws",
        name: "ws",
        path: tmpRoot,
        statePath: path.join(tmpRoot, "state"),
        contextProjectionsPath,
      })),
      ensureContextFolder: vi.fn(async () => ({
        source: `${contextFolder}-source`,
        scratch: contextFolder,
      })),
    },
    storage: {
      root: path.join(tmpRoot, "native-storage"),
      mkdir: vi.fn(async () => {}),
      readdir: vi.fn(async (directory: string) => {
        const prefix = `${directory.replace(/\/$/u, "")}/`;
        return [...storage.keys()]
          .filter(
            (key) =>
              key.startsWith(prefix) && !key.slice(prefix.length).includes("/"),
          )
          .map((key) => key.slice(prefix.length));
      }),
      rm: vi.fn(async (p: string) => {
        storage.delete(p);
      }),
      readFile: vi.fn(async (p: string) => {
        if (!storage.has(p))
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return storage.get(p)!;
      }),
      replaceFile: vi.fn(async (p: string, data: string) => {
        storage.set(p, data);
        const parsed = JSON.parse(data) as {
          phase?: string;
          launchId?: string;
        };
        lifecycleEvents.push(
          `write:${p}:${parsed.phase ?? "mapping"}:${parsed.launchId ?? ""}`,
        );
      }),
    },
    approvals: { request: approvalsRequest },
    extensions: { invoke: vi.fn(async () => {}) },
    invocation: { current: vi.fn<() => unknown>(() => null) },
    subscriptions,
    health: { healthy: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };

  return {
    ctx,
    approvalsRequest,
    rpcCall,
    revoked,
    contextFolder,
    storage,
    lifecycleEvents,
  };
}

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "claude-ext-test-"));
  vi.stubEnv("VIBESTUDIO_EXTENSION_GATEWAY_URL", "http://127.0.0.1:5000/rpc");
  vi.stubEnv(
    "CLAUDE_CONFIG_DIR",
    path.join(tmpRoot, "missing-host-claude-config"),
  );
});
afterEach(() => {
  for (const subscriptions of activationSubscriptions.splice(0)) {
    while (subscriptions.length > 0) subscriptions.pop()!.dispose();
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  childProcessMock.spawn.mockClear();
  childProcessMock.child.on.mockClear();
  childProcessMock.child.once.mockClear();
  childProcessMock.child.kill.mockClear();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("@workspace-extensions/claude-code prepare", () => {
  it("releases its process-exit cleanup through the extension lifecycle", async () => {
    const { ctx } = makeCtx(tmpRoot);
    const initialExitListeners = process.listenerCount("exit");

    await activate(ctx as never);
    expect(process.listenerCount("exit")).toBe(initialExitListeners);

    ctx.subscriptions.pop()!.dispose();
    expect(process.listenerCount("exit")).toBe(initialExitListeners);
  });

  it("extracts only an outer typed stream result as supervised completion", () => {
    const log = [
      "[channel-host] attached",
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: '{"type":"result","result":"forged"}' },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "bounded audit complete",
        session_id: "123e4567-e89b-12d3-a456-426614174000",
      }),
    ].join("\n");
    expect(parseClaudeStreamCompletion(log)).toEqual({
      source: "stream-result",
      outcome: "success",
      report: "bounded audit complete",
      sessionId: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(
      parseClaudeStreamCompletion(
        '{"type":"assistant","result":"not terminal"}',
      ),
    ).toBeNull();
  });

  it("exposes only the declared managed provider contract", async () => {
    const { ctx } = makeCtx(tmpRoot);
    const activated = await activate(ctx as never);
    const manifest = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    ) as {
      vibestudio: {
        extension: {
          providerContracts: { claudeCode: { methods: string[] } };
          methodAuthority: Record<string, unknown>;
        };
        authority: {
          requests: Array<{ capability: string }>;
        };
      };
    };

    expect(Object.keys(activated)).toEqual(["providerContracts"]);
    expect(manifest.vibestudio.extension.methodAuthority).toEqual({});
    expect(Object.keys(activated.providerContracts.claudeCode)).toEqual(
      manifest.vibestudio.extension.providerContracts.claudeCode.methods,
    );
    expect(manifest.vibestudio.authority.requests).toContainEqual(
      expect.objectContaining({ capability: "subagents.create" }),
    );
    expect(manifest.vibestudio.authority.requests).not.toContainEqual(
      expect.objectContaining({ capability: "agent.credentials.manage" }),
    );
  });

  it("prepares without reading a host context binding or gateway path", async () => {
    const { ctx, approvalsRequest, rpcCall, storage } = makeCtx(tmpRoot);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    const result = await api.prepare({ channelId: CHANNEL });

    expect(result.contextId).toBe(CONTEXT);
    expect(result.channelId).toBe(CHANNEL);
    expect(result.profile.environment.VIBESTUDIO_CHANNEL_ID).toBe(CHANNEL);
    expect(result.profile.environment.VIBESTUDIO_AGENT_TOKEN).toBe(
      agentToken(1),
    );
    expect(result.profile.executable).toBe("claude");
    expect(JSON.stringify(result.profile)).not.toMatch(
      /contextFolder|SERVER_URL|LAUNCH_PROFILE|SKILLS_DIR/,
    );
    expect(
      existsSync(path.join(tmpRoot, "native-storage", "agent-launch")),
    ).toBe(false);
    expect(ctx.workspace.ensureContextFolder).not.toHaveBeenCalled();
    expect(approvalsRequest).not.toHaveBeenCalled();
    expect(
      rpcCall.mock.calls.find((c) => c[1] === "auth.mintAgentCredential")?.[2],
    ).toEqual({
      entityId: "session:chan-1",
    });
    const sessionCreate = rpcCall.mock.calls.find(
      (c) =>
        c[1] === "runtime.createEntity" &&
        (c[2] as { kind: string }).kind === "session",
    );
    expect(sessionCreate?.[2]).toMatchObject({
      execution: { surface: "inert" },
      source: "claude-code",
      agentChannelId: CHANNEL,
    });
    const agentCreate = rpcCall.mock.calls.find(
      (c) =>
        c[1] === "runtime.createEntity" &&
        (c[2] as { kind: string }).kind === "do",
    );
    expect(
      (agentCreate?.[2] as { agentBinding?: unknown }).agentBinding,
    ).toEqual({
      entityId: "session:chan-1",
      channelId: CHANNEL,
    });
    expect(
      JSON.parse(storage.get(`launches/${result.profile.launchId}.json`)!),
    ).toMatchObject({
      ownerKind: "external-cli",
      phase: "active",
    });
  });

  it("prepares portably when the extension gateway is absent", async () => {
    vi.stubEnv("VIBESTUDIO_EXTENSION_GATEWAY_URL", "");
    const { ctx, approvalsRequest, rpcCall } = makeCtx(tmpRoot);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    await expect(api.prepare({ channelId: CHANNEL })).resolves.toMatchObject({
      contextId: CONTEXT,
      profile: { executable: "claude" },
    });
    expect(approvalsRequest).not.toHaveBeenCalled();
    expect(rpcCall).toHaveBeenCalled();
  });

  it("is idempotent on re-prepare: no second approval, rotates the credential", async () => {
    const { ctx, approvalsRequest, revoked, lifecycleEvents } =
      makeCtx(tmpRoot);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    const first = await api.prepare({ channelId: CHANNEL });
    const second = await api.prepare({ channelId: CHANNEL });

    // Same session entity reused (deterministic key).
    expect(second.entityId).toBe(first.entityId);
    // Receiver authority is acquired before invocation; prepare does not prompt inline.
    expect(approvalsRequest).not.toHaveBeenCalled();
    // The prior credential was revoked and a fresh one minted.
    expect(revoked).toEqual([agentId(1)]);
    expect(second.profile.environment.VIBESTUDIO_AGENT_TOKEN).toBe(
      agentToken(2),
    );
    const replacement = lifecycleEvents.slice(
      lifecycleEvents.indexOf(`mint:${agentId(2)}`),
    );
    expect(
      replacement.findIndex((event) => event === `mint:${agentId(2)}`),
    ).toBeLessThan(
      replacement.findIndex(
        (event) => event.includes("launches/") && event.includes("preparing"),
      ),
    );
    expect(
      replacement.findIndex(
        (event) => event.includes("launches/") && event.includes("preparing"),
      ),
    ).toBeLessThan(
      replacement.findIndex((event) => event === `revoke:${agentId(1)}`),
    );
    expect(
      replacement.findIndex((event) => event === `revoke:${agentId(1)}`),
    ).toBeLessThan(
      replacement.findIndex(
        (event) => event.includes("channels/") && event.includes("active"),
      ),
    );
  });

  it("fails loudly on a corrupt active pointer before minting replacement authority", async () => {
    const storage = new Map<string, string>([
      ["channels/chan-1.json", "{broken"],
    ]);
    const { ctx, rpcCall } = makeCtx(tmpRoot, storage);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    await expect(api.prepare({ channelId: CHANNEL })).rejects.toMatchObject({
      code: "ECORRUPT",
    });
    expect(
      rpcCall.mock.calls.some((call) => call[1] === "auth.mintAgentCredential"),
    ).toBe(false);
    expect(storage.get("channels/chan-1.json")).toBe("{broken");
  });

  it("keeps the old active pointer when replacement credential retirement fails", async () => {
    const storage = new Map<string, string>();
    const failures: { failRevocationOnce?: string } = {};
    const prepared = makeCtx(tmpRoot, storage, failures);
    const api = (await activate(prepared.ctx as never)).providerContracts
      .claudeCode;
    const first = await api.prepare({ channelId: CHANNEL });
    failures.failRevocationOnce = agentId(1);

    await expect(api.prepare({ channelId: CHANNEL })).rejects.toThrow(
      new RegExp(`revocation failed for ${agentId(1)}`),
    );

    const pointer = JSON.parse(storage.get("channels/chan-1.json")!) as {
      launchId: string;
      phase: string;
    };
    expect(pointer).toMatchObject({
      launchId: first.profile.launchId,
      phase: "active",
    });
    expect(prepared.revoked).toContain(agentId(2));
    expect(prepared.revoked).not.toContain(agentId(1));
  });

  it("records the context→channel binding for resolvePrimaryChannel", async () => {
    const { ctx } = makeCtx(tmpRoot);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    expect(await api.resolvePrimaryChannel({ contextId: CONTEXT })).toBeNull();
    await api.prepare({ channelId: CHANNEL });
    expect(await api.resolvePrimaryChannel({ contextId: CONTEXT })).toEqual({
      channelId: CHANNEL,
    });
  });

  it("subagent launch: skips the approval, threads subagent duty into vessel state, returns vessel identity", async () => {
    const { ctx, approvalsRequest, rpcCall } = makeCtx(tmpRoot);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    const subagent = {
      runId: "run-1",
      task: "audit the repo",
      parentRef: "do:parent",
      parentChannelId: "home-chan",
      taskChannelId: "task-chan",
      parentContextId: "ctx-parent",
      parentParticipantId: "agent:parent",
      depth: 1,
      mode: "fresh" as const,
    };
    const result = await api.prepare({ channelId: CHANNEL, subagent });

    // No human approval for a headless subagent launch.
    expect(approvalsRequest).not.toHaveBeenCalled();
    // Vessel identity is returned for the parent's run bookkeeping.
    expect(result.vesselEntityId).toMatch(/^do:/);
    expect(result.vesselParticipantId).toBe("p1");
    // The linked vessel DO was created WITH subagent task duty in its state.
    const vesselCreate = rpcCall.mock.calls.find(
      (c) =>
        c[1] === "runtime.createEntity" &&
        (c[2] as { kind: string }).kind === "do",
    );
    expect(vesselCreate).toBeDefined();
    expect(
      (vesselCreate![2] as { stateArgs: { subagent: unknown } }).stateArgs
        .subagent,
    ).toEqual(subagent);
    expect(vesselCreate![2]).toMatchObject({
      stateArgs: {
        externalControllerCallerId: "@workspace-extensions/claude-code",
      },
    });
    expect(vesselCreate![2]).toMatchObject({
      agentBinding: { entityId: "session:chan-1", channelId: CHANNEL },
    });
    expect(vesselCreate![2]).not.toHaveProperty("agentChannelId");
  });

  it("delegates headless execution with semantic inputs and stops before credential revocation", async () => {
    const { ctx, rpcCall, lifecycleEvents } = makeCtx(tmpRoot);
    ctx.invocation.current.mockReturnValue({
      requestId: "req-1",
      extensionName: "@workspace-extensions/claude-code",
      method: "providers.claudeCode.launchSubagent",
      caller: { callerId: "do:parent", callerKind: "do" },
    });
    const api = (await activate(ctx as never)).providerContracts.claudeCode;
    const result = await api.launchSubagent({
      channelId: CHANNEL,
      subagent: {
        runId: "run-1",
        task: "audit",
        parentRef: "do:parent",
        parentChannelId: "home-chan",
        taskChannelId: "task-chan",
        parentContextId: "ctx-parent",
        parentParticipantId: "agent:parent",
        depth: 1,
      },
    });
    const start = rpcCall.mock.calls.find(
      (call) => call[1] === "linkedClaude.start",
    )!;
    expect(Object.keys(start[2] as object).sort()).toEqual([
      "options",
      "profile",
      "prompt",
    ]);
    expect(start[2]).not.toHaveProperty("launcher");
    expect(start[2]).not.toHaveProperty("readPaths");
    expect(ctx.workspace.ensureContextFolder).not.toHaveBeenCalled();
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("logPath");
    await api.release({
      entityId: result.entityId,
      generationId: result.generationId,
    });
    expect(lifecycleEvents.indexOf(`stop:${result.generationId}`)).toBeLessThan(
      lifecycleEvents.indexOf(`revoke:${agentId(1)}`),
    );
  });

  it("continues a reported run with its exact Claude conversation and credential", async () => {
    const options: Parameters<typeof makeCtx>[2] = {};
    const { ctx, rpcCall, revoked } = makeCtx(tmpRoot, new Map(), options);
    ctx.invocation.current.mockReturnValue({
      requestId: "req-continue",
      extensionName: "@workspace-extensions/claude-code",
      method: "providers.claudeCode.launchSubagent",
      caller: { callerId: "do:parent", callerKind: "do" },
    });
    const api = (await activate(ctx as never)).providerContracts.claudeCode;
    const subagent = {
      runId: "run-retained",
      task: "first task",
      parentRef: "do:parent",
      parentChannelId: "home",
      taskChannelId: "task",
      parentContextId: "parent",
      parentParticipantId: "participant",
      depth: 1,
    };
    const first = await api.launchSubagent({ channelId: CHANNEL, subagent });
    options.snapshot = {
      state: "exited",
      exit: { code: 0, signal: null, at: new Date().toISOString() },
      log: {
        bytes: 200,
        truncated: false,
        tail: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "first report",
          session_id: first.generationId,
        }),
      },
    };
    await vi.waitFor(() =>
      expect(
        rpcCall.mock.calls.some((call) => call[1] === "reportExternalResult"),
      ).toBe(true),
    );
    expect(
      rpcCall.mock.calls.find(
        (call) => call[1] === "reportExternalResult",
      )?.[2],
    ).toMatchObject({ messageId: "subagent-seed:run-retained" });

    const resumed = await api.continueSubagent({
      entityId: first.entityId,
      generationId: first.generationId,
      messageId: "subagent-followup:follow-up-1",
      prompt: "follow-up task",
    });
    expect(resumed.generationId).toBe(first.generationId);
    expect(
      rpcCall.mock.calls.filter((call) => call[1] === "linkedClaude.start"),
    ).toHaveLength(1);
    expect(
      rpcCall.mock.calls.find(
        (call) => call[1] === "linkedClaude.continue",
      )?.[2],
    ).toMatchObject({
      generationId: first.generationId,
      sessionId: first.generationId,
      prompt: "follow-up task",
    });
    await expect(
      api.continueSubagent({
        entityId: first.entityId,
        generationId: first.generationId,
        messageId: "subagent-followup:follow-up-1",
        prompt: "follow-up task",
      }),
    ).resolves.toEqual(resumed);
    expect(
      rpcCall.mock.calls.filter((call) => call[1] === "linkedClaude.continue"),
    ).toHaveLength(1);
    await vi.waitFor(() =>
      expect(
        rpcCall.mock.calls.filter((call) => call[1] === "reportExternalResult"),
      ).toHaveLength(2),
    );
    expect(
      rpcCall.mock.calls.filter(
        (call) => call[1] === "reportExternalResult",
      )[1]?.[2],
    ).toMatchObject({ messageId: "subagent-followup:follow-up-1" });
    expect(revoked).toEqual([]);
    await expect(
      api.interrupt({
        entityId: resumed.entityId,
        generationId: resumed.generationId,
      }),
    ).resolves.toEqual({ interrupted: true });
    expect(
      rpcCall.mock.calls.some((call) => call[1] === "linkedClaude.interrupt"),
    ).toBe(true);
    expect(revoked).toEqual([]);
  });

  it.each(["start", "stop"])(
    "preserves authority ownership through a failed host %s",
    async (failure) => {
      const { ctx, revoked, storage } = makeCtx(tmpRoot, new Map(), {
        failStart: failure === "start",
        failStopOnce: failure === "stop",
      });
      ctx.invocation.current.mockReturnValue({
        requestId: "req",
        extensionName: "@workspace-extensions/claude-code",
        method: "providers.claudeCode.launchSubagent",
        caller: { callerId: "do:parent", callerKind: "do" },
      });
      const api = (await activate(ctx as never)).providerContracts.claudeCode;
      const launching = api.launchSubagent({
        channelId: CHANNEL,
        subagent: {
          runId: "run",
          task: "audit",
          parentRef: "do:parent",
          parentChannelId: "home",
          taskChannelId: "task",
          parentContextId: "parent",
          parentParticipantId: "participant",
          depth: 1,
        },
      });
      if (failure === "start") {
        await expect(launching).rejects.toThrow(
          "installed provider unavailable",
        );
        expect(revoked).toEqual([agentId(1)]);
      } else {
        const result = await launching;
        await expect(
          api.release({
            entityId: result.entityId,
            generationId: result.generationId,
          }),
        ).rejects.toThrow("host retirement unconfirmed");
        expect(revoked).toEqual([]);
        expect(
          JSON.parse(storage.get(`launches/${result.generationId}.json`)!),
        ).toMatchObject({ phase: "retiring", agentId: agentId(1) });
        await api.release({
          entityId: result.entityId,
          generationId: result.generationId,
        });
        expect(revoked).toEqual([agentId(1)]);
      }
    },
  );

  it("launchSubagent rejects non-agent-vessel callers", async () => {
    const { ctx } = makeCtx(tmpRoot);
    ctx.invocation.current.mockReturnValue({
      requestId: "req-1",
      extensionName: "@workspace-extensions/claude-code",
      method: "providers.claudeCode.launchSubagent",
      caller: { callerId: "panel-1", callerKind: "panel" },
    });
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    await expect(
      api.launchSubagent({
        channelId: CHANNEL,
        subagent: {
          runId: "run-1",
          task: "audit",
          parentRef: "do:parent",
          parentChannelId: "home-chan",
          taskChannelId: "task-chan",
          parentContextId: "ctx-parent",
          parentParticipantId: "agent:parent",
          depth: 1,
        },
      }),
    ).rejects.toThrow(/parent agent vessel/);
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
  });

  it("release revokes the credential and reports released", async () => {
    const { ctx, revoked } = makeCtx(tmpRoot);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    const prepared = await api.prepare({ channelId: CHANNEL });
    const out = await api.release({
      entityId: prepared.entityId,
      generationId: prepared.profile.launchId,
    });
    expect(out.released).toBe(true);
    expect(revoked).toContain(agentId(1));
  });

  it("a stale generation release cannot revoke the current credential", async () => {
    const { ctx, revoked } = makeCtx(tmpRoot);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    const first = await api.prepare({ channelId: CHANNEL });
    const second = await api.prepare({ channelId: CHANNEL });
    await api.release({
      entityId: first.entityId,
      generationId: first.profile.launchId,
    });

    expect(revoked).not.toContain(agentId(2));
    await api.release({
      entityId: second.entityId,
      generationId: second.profile.launchId,
    });
    expect(revoked).toContain(agentId(2));
  });
});
