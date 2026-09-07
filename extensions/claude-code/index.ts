import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@vibestudio/extension";
import {
  claudeLaunchProfile,
  type PreparedClaudeLaunch,
} from "@vibestudio/shared/claudeLaunchProfile";
import type { LinkedClaudeSnapshot } from "@vibestudio/service-schemas/linkedClaude";
import { serializeByKey } from "@vibestudio/shared/keyedSerializer";
import {
  launchAgentIntoChannel,
  subagentFirstTaskPrompt,
  subagentRuntimePrompt,
  type AgentLaunchRpc,
} from "@workspace/agentic-core";
import {
  parseClaudeLaunchRecord,
  type ClaudeLaunchOwnerKind,
  type ClaudeLaunchRecord,
} from "./launchOwnership.js";

const CHANNEL_SERVICE_PROTOCOL = "vibestudio.channel.v1";
const LINKED_AGENT_SOURCE = "workers/linked-agent";
const LINKED_AGENT_CLASS = "LinkedAgentWorker";

function error(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Subagent task-duty binding threaded into the linked vessel's state
 *  (docs/claude-code-channels-plan.md §8.2). When present, the vessel owns
 *  `complete` → terminal-settle back to the parent, and the per-launch approval
 *  gate is skipped (the parent's spawn is the authorization; depth/fan-out gate
 *  it, not a human prompt). Shape mirrors agentic-core's SubagentIdentity. */
export interface PrepareSubagentBinding {
  runId: string;
  task: string;
  parentRef: string;
  parentChannelId: string;
  taskChannelId: string;
  parentContextId: string;
  parentParticipantId: string;
  depth: number;
  mode?: "fresh" | "fork";
}

/** The awaited return of {@link prepare}. */
export interface PrepareResult extends PreparedClaudeLaunch {
  /** Canonical entity id of the linked vessel DO (its RPC caller identity) —
   *  used by a spawning parent as the subagent run's childEntityId. */
  vesselEntityId: string;
  /** The linked vessel's participant id on the channel (task-seed addressing). */
  vesselParticipantId: string | null;
}

/** Claude Code CLI options a parent may set per subagent launch (the
 *  `spawn_subagent` tool's `config` for agentKind 'claude-code'). Whitelisted:
 *  unknown keys are dropped, values are validated so a config value can never
 *  smuggle an extra flag into the argv. */
export interface SubagentCliOptions {
  /** `--model`: alias ('opus', 'sonnet', 'haiku') or a full model name. */
  model?: string;
  /** `--effort`: reasoning effort for the session. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** `--permission-mode`. Defaults to 'auto': the child runs autonomously —
   *  the parent's spawn is the authorization, and a headless `-p` run blocked
   *  on interactive permission prompts would hang the subagent. */
  permissionMode?:
    | "auto"
    | "acceptEdits"
    | "bypassPermissions"
    | "manual"
    | "dontAsk"
    | "plan";
  /** `--fallback-model`: automatic fallback when the model is overloaded. */
  fallbackModel?: string;
  /** `--max-budget-usd`: hard spend ceiling for the session. */
  maxBudgetUsd?: number;
}

export interface LaunchSubagentInput {
  channelId: string;
  title?: string;
  /** Launcher CLI options (see {@link SubagentCliOptions}); forwarded from the
   *  parent's `spawn_subagent` config, whitelisted here. */
  options?: Record<string, unknown>;
  subagent: PrepareSubagentBinding;
}

export interface LaunchSubagentResult {
  entityId: string;
  contextId: string;
  channelId: string;
  vesselRef: string;
  vesselEntityId: string;
  vesselParticipantId: string | null;
  launchId: string;
  /** Exact preparation generation owned by this process. */
  generationId: string;
  pid: number | null;
}

export interface InspectLaunchResult {
  entityId: string;
  generationId: string;
  launchId: string;
  runId: string;
  state: "running" | "exited";
  pid: number | null;
  exit?: {
    code: number | null;
    signal: string | null;
    at: string;
  };
  completion?: {
    source: "stream-result";
    outcome: "success" | "failed";
    report: string;
  };
  log: {
    bytes: number;
    tail: string;
    truncated: boolean;
  };
}

interface ResolvedService {
  kind: string;
  targetId?: string;
}

const CONTROLLER_CALLER_ID = "@workspace-extensions/claude-code";
const MAX_COMPLETION_REPORT_BYTES = 16_384;

export interface ClaudeStreamCompletion {
  source: "stream-result";
  outcome: "success" | "failed";
  report: string;
}

function boundedUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) return value;
  return `…${bytes.subarray(bytes.byteLength - maxBytes + 3).toString("utf8")}`;
}

/**
 * Extract Claude Code's authoritative terminal record from a bounded JSONL
 * tail. Stderr may be interleaved with stdout, so malformed/non-JSON lines are
 * ignored and only an outer `type:"result"` record can settle a run.
 */
export function parseClaudeStreamCompletion(
  logTail: string,
): ClaudeStreamCompletion | null {
  const lines = logTail.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line?.startsWith("{")) continue;
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record["type"] !== "result") continue;
    const success =
      record["subtype"] === "success" && record["is_error"] !== true;
    const rawReport =
      typeof record["result"] === "string" && record["result"].trim()
        ? record["result"].trim()
        : success
          ? "Claude Code completed successfully without a textual report."
          : `Claude Code terminal result reported ${String(record["subtype"] ?? "failure")}.`;
    return {
      source: "stream-result",
      outcome: success ? "success" : "failed",
      report: boundedUtf8Tail(rawReport, MAX_COMPLETION_REPORT_BYTES),
    };
  }
  return null;
}

/** Public API surface of this extension — the awaited return of {@link activate}. */
export type Api = Awaited<ReturnType<typeof activate>>;

export async function activate(ctx: ExtensionContext) {
  interface HeadlessLaunch {
    entityId: string;
    generationId: string;
    launchId: string;
    runId: string;
    vesselRef: string;
    deliberate: boolean;
    monitor: ReturnType<typeof setInterval> | null;
  }
  const headlessLaunches = new Map<string, HeadlessLaunch>();
  const terminalLaunches = new Map<string, InspectLaunchResult>();
  const channelTransactions = new Map<string, Promise<unknown>>();
  const finalizations = new Map<string, Promise<boolean>>();
  const retireHeadlessLaunch = async (
    launch: HeadlessLaunch,
  ): Promise<void> => {
    if (launch.monitor) clearInterval(launch.monitor);
    launch.monitor = null;
    await ctx.rpc.call("main", "linkedClaude.stop", {
      entityId: launch.entityId,
      generationId: launch.generationId,
    });
  };
  ctx.subscriptions.push({
    dispose() {
      for (const launch of headlessLaunches.values()) {
        launch.deliberate = true;
        void retireHeadlessLaunch(launch).catch((failure) =>
          ctx.log.warn?.("Linked Claude retirement failed", {
            error: String(failure),
          }),
        );
      }
    },
  });

  const rpc: AgentLaunchRpc = {
    call: <T>(target: string, method: string, args: unknown[]): Promise<T> =>
      ctx.rpc.call<T>(target, method, ...args),
  };

  // ── Storage helpers (bidirectional channel↔context↔entity bookkeeping) ──
  // Context→channel has no host enumeration surface (there is no channel
  // registry and entity records carry no channelId), so we record the binding
  // here at prepare time and serve resolvePrimaryChannel/adaptLaunch from it.
  const enc = (v: string): string => encodeURIComponent(v);
  const channelKey = (id: string): string => `channels/${enc(id)}.json`;
  const entityKey = (id: string): string => `entities/${enc(id)}.json`;
  const contextKey = (id: string): string => `contexts/${enc(id)}.json`;
  const launchKey = (id: string): string => `launches/${enc(id)}.json`;
  const terminalLaunchKey = (entityId: string, generationId: string): string =>
    `${entityId}\u0000${generationId}`;

  async function readJson<T>(key: string): Promise<T | null> {
    let raw: string | Buffer;
    try {
      raw = await ctx.storage.readFile(key, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return JSON.parse(
        typeof raw === "string" ? raw : raw.toString("utf8"),
      ) as T;
    } catch (error) {
      throw Object.assign(
        new Error(
          `Corrupt Claude extension record ${key}: ${error instanceof Error ? error.message : String(error)}`,
        ),
        { code: "ECORRUPT" },
      );
    }
  }
  async function writeJson(key: string, value: unknown): Promise<void> {
    const dir = path.posix.dirname(key);
    await ctx.storage.mkdir(dir, { recursive: true });
    await ctx.storage.replaceFile(key, JSON.stringify(value, null, 2));
  }

  async function readLaunchRecord(
    key: string,
  ): Promise<ClaudeLaunchRecord | null> {
    const value = await readJson<unknown>(key);
    return value === null ? null : parseClaudeLaunchRecord(value, key);
  }

  async function writeLaunchRecord(record: ClaudeLaunchRecord): Promise<void> {
    const parsed = parseClaudeLaunchRecord(record, launchKey(record.launchId));
    await writeJson(launchKey(parsed.launchId), parsed);
  }

  async function resolveChannelTarget(channelId: string): Promise<string> {
    const resolved = (await ctx.workers.resolveService(
      CHANNEL_SERVICE_PROTOCOL,
      channelId,
    )) as ResolvedService;
    if (resolved?.kind !== "durable-object" || !resolved.targetId) {
      throw error(
        "ENOENT",
        `Channel service did not resolve to a Durable Object for ${channelId}`,
      );
    }
    return resolved.targetId;
  }

  async function resolveContextFromChannel(channelId: string): Promise<string> {
    const target = await resolveChannelTarget(channelId);
    const contextId = await ctx.rpc.call<string | null>(target, "getContextId");
    if (!contextId) {
      throw error("ENOCTX", `Channel ${channelId} is not bound to a context`);
    }
    return contextId;
  }

  function assertHeadlessSubagentCaller(input: LaunchSubagentInput): void {
    const invocation = ctx.invocation.current();
    const callerKind = invocation?.caller.callerKind;
    if (callerKind !== "do" && callerKind !== "worker") {
      throw error(
        "EACCES",
        "Claude Code subagent launch requires a parent agent vessel caller",
      );
    }
    if (
      !input.subagent?.runId ||
      !input.subagent.parentChannelId ||
      !input.subagent.parentRef
    ) {
      throw error(
        "EINVAL",
        "launchSubagent requires a complete subagent binding",
      );
    }
    if (!input.subagent.task.trim()) {
      throw error("EINVAL", "launchSubagent requires a non-empty task");
    }
  }

  function finalizeRecord(
    fallback: ClaudeLaunchRecord,
    live?: HeadlessLaunch,
  ): Promise<boolean> {
    const existing = finalizations.get(fallback.launchId);
    if (existing) return existing;
    const finalization = (async () => {
      let record =
        (await readLaunchRecord(launchKey(fallback.launchId))) ?? fallback;
      if (record.entityId !== fallback.entityId) {
        throw error(
          "ECORRUPT",
          `Launch ${record.launchId} changed entity ownership`,
        );
      }
      if (record.phase === "released") return false;
      record = { ...record, phase: "retiring" };
      await writeLaunchRecord(record);

      if (live) await retireHeadlessLaunch(live);
      else if (record.ownerKind === "host-headless")
        await ctx.rpc.call("main", "linkedClaude.stop", {
          entityId: record.entityId,
          generationId: record.launchId,
        });
      if (record.agentId) {
        await ctx.rpc.call(
          "main",
          "auth.revokeAgentCredential",
          record.agentId,
        );
        record = { ...record, agentId: null };
        await writeLaunchRecord(record);
      }
      record = {
        ...record,
        phase: "released",
        releasedAt: new Date().toISOString(),
      };
      await writeLaunchRecord(record);
      headlessLaunches.delete(record.launchId);
      return true;
    })();
    finalizations.set(fallback.launchId, finalization);
    finalization
      .finally(() => {
        if (finalizations.get(fallback.launchId) === finalization) {
          finalizations.delete(fallback.launchId);
        }
      })
      .catch(() => undefined);
    return finalization;
  }

  async function recoverInterruptedLaunches(): Promise<void> {
    let entries: string[];
    try {
      entries = await ctx.storage.readdir("launches");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;
      const record = await readLaunchRecord(`launches/${entry}`);
      if (!record || record.phase === "released") {
        continue;
      }
      const current = await readLaunchRecord(channelKey(record.channelId));
      if (
        record.ownerKind === "external-cli" &&
        record.phase === "active" &&
        current?.launchId === record.launchId &&
        current.phase === "active"
      ) {
        // The launch record is the canonical effect receipt. Once its matching
        // pointer is durable, the lookup indexes can be reconstructed after a
        // crash between their independent file commits.
        await writeJson(entityKey(record.entityId), {
          channelId: record.channelId,
        });
        await writeJson(contextKey(record.contextId), {
          channelId: record.channelId,
        });
        continue;
      }
      await finalizeRecord(record);
      if (current?.launchId === record.launchId) {
        const released = await readLaunchRecord(launchKey(record.launchId));
        if (released) await writeJson(channelKey(record.channelId), released);
      }
    }
  }

  async function inspectLaunch(input: {
    entityId: string;
    generationId: string;
    maxLogBytes?: number;
  }): Promise<InspectLaunchResult> {
    const terminal = terminalLaunches.get(
      terminalLaunchKey(input.entityId, input.generationId),
    );
    if (terminal) return limitLog(terminal, input.maxLogBytes);
    const launch = headlessLaunches.get(input.generationId);
    if (!launch || launch.entityId !== input.entityId)
      throw error("ENOENT", "No owned Claude generation");
    const snapshot = await ctx.rpc.call<LinkedClaudeSnapshot>(
      "main",
      "linkedClaude.inspect",
      { entityId: input.entityId, generationId: input.generationId },
    );
    return limitLog(snapshotResult(launch, snapshot), input.maxLogBytes);
  }
  function limitLog(
    result: InspectLaunchResult,
    maximum = 65536,
  ): InspectLaunchResult {
    const bytes = Math.max(
      0,
      Math.min(262144, Math.floor(Number.isFinite(maximum) ? maximum : 65536)),
    );
    return {
      ...result,
      log: {
        ...result.log,
        tail: boundedUtf8Tail(result.log.tail, bytes),
        truncated: result.log.truncated || result.log.bytes > bytes,
      },
    };
  }
  function snapshotResult(
    launch: HeadlessLaunch,
    snapshot: LinkedClaudeSnapshot,
  ): InspectLaunchResult {
    const completion =
      snapshot.exit?.code === 0 && snapshot.exit.signal === null
        ? parseClaudeStreamCompletion(snapshot.log.tail)
        : null;
    return {
      entityId: launch.entityId,
      generationId: launch.generationId,
      launchId: launch.launchId,
      runId: launch.runId,
      state: snapshot.state,
      pid: snapshot.pid,
      ...(snapshot.exit ? { exit: snapshot.exit } : {}),
      ...(completion ? { completion } : {}),
      log: {
        ...snapshot.log,
        tail: boundedUtf8Tail(snapshot.log.tail, 65536),
        truncated: snapshot.log.bytes > 65536,
      },
    };
  }
  async function spawnHeadlessClaude(
    prepared: PrepareResult,
    input: LaunchSubagentInput,
  ): Promise<LaunchSubagentResult> {
    const snapshot = await ctx.rpc.call<LinkedClaudeSnapshot>(
      "main",
      "linkedClaude.start",
      {
        profile: prepared.profile,
        prompt: subagentFirstTaskPrompt(input.subagent),
        options: input.options,
      },
    );
    const launch: HeadlessLaunch = {
      entityId: prepared.entityId,
      generationId: prepared.profile.launchId,
      launchId: `claude-code:${input.subagent.runId}`,
      runId: input.subagent.runId,
      vesselRef: prepared.vesselRef,
      deliberate: false,
      monitor: null,
    };
    headlessLaunches.set(launch.generationId, launch);
    const record = await readLaunchRecord(launchKey(launch.generationId));
    if (!record) throw error("ECORRUPT", "Missing prepared Claude generation");
    try {
      await activatePreparedGeneration(record);
    } catch (failure) {
      await finalizeRecord(record, launch);
      throw failure;
    }
    let checking = false;
    launch.monitor = setInterval(() => {
      if (checking) return;
      checking = true;
      void ctx.rpc
        .call<LinkedClaudeSnapshot>("main", "linkedClaude.inspect", {
          entityId: launch.entityId,
          generationId: launch.generationId,
        })
        .then((state) =>
          state.state === "exited"
            ? serializeByKey(channelTransactions, prepared.channelId, () =>
                finalizeHeadlessLaunch(launch, state),
              )
            : undefined,
        )
        .catch((failure) =>
          ctx.log.warn?.("Linked Claude observation failed", {
            error: String(failure),
          }),
        )
        .finally(() => {
          checking = false;
        });
    }, 500);
    return {
      entityId: prepared.entityId,
      contextId: prepared.contextId,
      channelId: prepared.channelId,
      vesselRef: prepared.vesselRef,
      vesselEntityId: prepared.vesselEntityId,
      vesselParticipantId: prepared.vesselParticipantId,
      launchId: launch.launchId,
      generationId: launch.generationId,
      pid: snapshot.pid,
    };
  }
  async function finalizeHeadlessLaunch(
    launch: HeadlessLaunch,
    snapshot: LinkedClaudeSnapshot,
  ): Promise<void> {
    if (launch.monitor) clearInterval(launch.monitor);
    launch.monitor = null;
    const record = await readLaunchRecord(launchKey(launch.generationId));
    if (!record) throw error("ECORRUPT", "Missing owned Claude generation");
    const terminal = snapshotResult(launch, snapshot);
    await finalizeRecord(record, launch);
    terminalLaunches.set(
      terminalLaunchKey(launch.entityId, launch.generationId),
      terminal,
    );
    while (terminalLaunches.size > 64)
      terminalLaunches.delete(terminalLaunches.keys().next().value!);
    if (launch.deliberate) return;
    const exit = snapshot.exit!;
    if (terminal.completion)
      await ctx.rpc.call(launch.vesselRef, "reportExternalResult", {
        runId: launch.runId,
        outcome: terminal.completion.outcome,
        report: terminal.completion.report,
        code: exit.code,
      });
    else
      await ctx.rpc.call(launch.vesselRef, "reportExternalExit", {
        runId: launch.runId,
        code: exit.code,
        signal: exit.signal,
      });
  }

  async function prepareGeneration(
    input: {
      channelId: string;
      title?: string;
      subagent?: PrepareSubagentBinding;
    },
    ownerKind: ClaudeLaunchOwnerKind,
  ): Promise<PrepareResult> {
    const { channelId } = input;
    if (!channelId) throw error("EINVAL", "prepare requires a channelId");
    // Validate the active pointer before minting any replacement authority.
    await readLaunchRecord(channelKey(channelId));
    // 1. Context is the channel's context — never create a channel.
    const contextId = await resolveContextFromChannel(channelId);

    // The development/runtime receivers independently enforce the launch and
    // context effects before they occur.
    // 2. Ensure the runtime session entity (idempotent by canonical key) and
    //    eagerly materialize the context folder.
    const sessionHandle = await ctx.rpc.call<{
      id: string;
      contextId?: string;
    }>("main", "runtime.createEntity", {
      kind: "session",
      execution: { surface: "inert" },
      source: "claude-code",
      key: channelId,
      contextId,
      agentChannelId: channelId,
      ...(input.title ? { title: input.title } : {}),
    });
    const entityId = sessionHandle.id;

    // 4. Ensure the linked-agent vessel and invite it into the channel with the
    //    standard launch primitives (idempotent: reuses the deterministic key).
    const launch = await launchAgentIntoChannel(rpc, {
      channelId,
      contextId,
      source: LINKED_AGENT_SOURCE,
      className: LINKED_AGENT_CLASS,
      key: `linked:${entityId}`,
      agentBinding: { entityId, channelId },
      // `subagent` gives the linked vessel task duty (complete → terminal-settle
      // to the parent, §8.2); `linkedEntityId` binds the bridge credential.
      stateArgs: {
        linkedEntityId: entityId,
        externalControllerCallerId: CONTROLLER_CALLER_ID,
        ...(input.subagent ? { subagent: input.subagent } : {}),
      },
    });
    const vesselRef = launch.handle.targetId;
    const vesselEntityId = launch.handle.id ?? vesselRef;
    const vesselParticipantId = launch.subscription.participantId ?? null;

    // Mint and durably stage the replacement before changing or revoking the
    // active generation. The channel pointer moves only in activatePreparedGeneration.
    const credential = await ctx.rpc.call<{
      agentId: string;
      agentToken: string;
    }>("main", "auth.mintAgentCredential", { entityId });

    try {
      // 6. Return a path-free launch declaration. Workspace skills are exposed
      //    by the bridge as MCP resources; prepare never edits the context tree.
      const profile = claudeLaunchProfile({
        launchId: randomUUID(),
        environment: {
          VIBESTUDIO_AGENT_TOKEN: credential.agentToken,
          VIBESTUDIO_ENTITY_ID: entityId,
          VIBESTUDIO_CONTEXT_ID: contextId,
          VIBESTUDIO_CHANNEL_ID: channelId,
          VIBESTUDIO_VESSEL_REF: vesselRef,
          // Subagent launches carry their duty into the session env so the bridge
          // states it definitively in the MCP instructions (§8.2): the contract is
          // the SAME text a Pi child gets as its immediate prompt.
          ...(input.subagent
            ? {
                VIBESTUDIO_SUBAGENT_RUN_ID: input.subagent.runId,
                VIBESTUDIO_SUBAGENT_PARENT_CHANNEL_ID:
                  input.subagent.parentChannelId,
                VIBESTUDIO_SUBAGENT_CONTRACT: subagentRuntimePrompt(
                  input.subagent,
                  {
                    completionMode: "supervised-process",
                  },
                ),
              }
            : {}),
        },
      });

      const record: ClaudeLaunchRecord = {
        version: 1,
        launchId: profile.launchId,
        entityId,
        contextId,
        channelId,
        ownerKind,
        phase: "preparing",
        agentId: credential.agentId,
        preparedAt: new Date().toISOString(),
      };
      await writeLaunchRecord(record);
      await writeJson(entityKey(entityId), { channelId });
      await writeJson(contextKey(contextId), { channelId });

      return {
        entityId,
        contextId,
        channelId,
        vesselRef,
        vesselEntityId,
        vesselParticipantId,
        profile,
      };
    } catch (error) {
      try {
        await ctx.rpc.call(
          "main",
          "auth.revokeAgentCredential",
          credential.agentId,
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Claude launch preparation failed and credential revocation also failed",
        );
      }
      throw error;
    }
  }

  async function activatePreparedGeneration(
    preparing: ClaudeLaunchRecord,
  ): Promise<ClaudeLaunchRecord> {
    if (preparing.phase !== "preparing") {
      throw error("ECORRUPT", `Launch ${preparing.launchId} is not preparing`);
    }
    const prior = await readLaunchRecord(channelKey(preparing.channelId));
    if (
      prior &&
      prior.launchId !== preparing.launchId &&
      prior.phase !== "released"
    ) {
      const priorLive = headlessLaunches.get(prior.launchId);
      if (priorLive) priorLive.deliberate = true;
      const retiring = { ...prior, phase: "retiring" as const };
      await writeLaunchRecord(retiring);
      await writeJson(channelKey(retiring.channelId), retiring);
      try {
        await finalizeRecord(retiring, priorLive);
      } catch (failure) {
        const failed = await readLaunchRecord(launchKey(prior.launchId));
        const ownershipUnchanged =
          prior.ownerKind === "external-cli" &&
          failed?.agentId === prior.agentId;
        if (prior.phase === "active" && ownershipUnchanged) {
          await writeLaunchRecord(prior);
          await writeJson(channelKey(prior.channelId), prior);
        }
        throw failure;
      }
    }
    const active = { ...preparing, phase: "active" as const };
    await writeLaunchRecord(active);
    await writeJson(channelKey(active.channelId), active);
    return active;
  }

  async function prepare(input: {
    channelId: string;
    title?: string;
    subagent?: PrepareSubagentBinding;
  }): Promise<PrepareResult> {
    return serializeByKey(channelTransactions, input.channelId, async () => {
      const prepared = await prepareGeneration(input, "external-cli");
      const record = await readLaunchRecord(
        launchKey(prepared.profile.launchId),
      );
      if (!record)
        throw error(
          "ECORRUPT",
          `Missing preparing launch ${prepared.profile.launchId}`,
        );
      try {
        await activatePreparedGeneration(record);
        return prepared;
      } catch (failure) {
        try {
          await finalizeRecord(record);
        } catch (cleanupFailure) {
          throw new AggregateError(
            [failure, cleanupFailure],
            "Claude CLI preparation failed and its staged credential could not be revoked",
          );
        }
        throw failure;
      }
    });
  }

  async function release(input: {
    entityId: string;
    generationId: string;
  }): Promise<{ released: boolean }> {
    const { entityId, generationId } = input;
    if (!entityId || !generationId) {
      throw error("EINVAL", "release requires entityId and generationId");
    }
    const record = await readLaunchRecord(launchKey(generationId));
    if (record && record.entityId !== entityId) {
      throw error(
        "EINVAL",
        `Launch ${generationId} does not belong to entity ${entityId}`,
      );
    }
    if (!record) return { released: false };
    return serializeByKey(channelTransactions, record.channelId, async () => {
      const live = headlessLaunches.get(generationId);
      if (live) live.deliberate = true;
      await finalizeRecord(record, live);
      const current = await readLaunchRecord(channelKey(record.channelId));
      if (current?.launchId === generationId) {
        const released = await readLaunchRecord(launchKey(generationId));
        if (released) await writeJson(channelKey(record.channelId), released);
      }
      return { released: true };
    });
  }

  async function launchSubagent(
    input: LaunchSubagentInput,
  ): Promise<LaunchSubagentResult> {
    assertHeadlessSubagentCaller(input);
    return serializeByKey(channelTransactions, input.channelId, async () => {
      const prepared = await prepareGeneration(
        {
          channelId: input.channelId,
          title: input.title,
          subagent: input.subagent,
        },
        "host-headless",
      );
      try {
        return await spawnHeadlessClaude(prepared, input);
      } catch (err) {
        const record = await readLaunchRecord(
          launchKey(prepared.profile.launchId),
        );
        if (record && record.phase !== "released") {
          try {
            await finalizeRecord(record, headlessLaunches.get(record.launchId));
          } catch (cleanupFailure) {
            throw new AggregateError(
              [err, cleanupFailure],
              "Claude headless launch failed and its preparing generation could not be retired",
            );
          }
        }
        throw err;
      }
    });
  }

  async function resolvePrimaryChannel(input: {
    contextId: string;
  }): Promise<{ channelId: string } | null> {
    if (!input.contextId) return null;
    const rec = await readJson<{ channelId: string }>(
      contextKey(input.contextId),
    );
    return rec?.channelId ? { channelId: rec.channelId } : null;
  }

  await recoverInterruptedLaunches();
  ctx.health.healthy({ summary: "Claude Code launch orchestrator activated" });

  return {
    providerContracts: {
      claudeCode: {
        prepare,
        launchSubagent,
        inspectLaunch,
        release,
        resolvePrimaryChannel,
      },
    },
  };
}
