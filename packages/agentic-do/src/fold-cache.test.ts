import { describe, expect, it } from "vitest";
import {
  GENESIS_LAST_HASH,
  initialAgentState,
  MODEL_CONTEXT_VERSION,
  type AgentLoopConfig,
} from "@workspace/agent-loop";
import type { SqlStorage } from "@workspace/runtime/worker";
import { createInMemorySql } from "@workspace/runtime/worker/test-utils";
import { FoldCache } from "./fold-cache.js";

const config = {
  model: "anthropic:claude-sonnet-4-6",
  modelSpec: {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  thinkingLevel: "medium",
  fastMode: false,
  approvalLevel: 2,
  respondPolicy: "all",
  systemPromptHash: "blob:system",
  activeToolNames: [],
  roster: { participants: [] },
} satisfies AgentLoopConfig;

describe("FoldCache model-context projection", () => {
  it("cold-refolds a cache written before assistant model identity was projected", async () => {
    const sql = (await createInMemorySql()) as unknown as SqlStorage;
    const calls: string[] = [];
    const cache = new FoldCache(sql, {
      async call(method) {
        calls.push(method);
        if (method === "getLogHead") {
          return {
            seq: 0,
            hash: GENESIS_LAST_HASH,
            forkSeq: null,
            forkHash: null,
          } as never;
        }
        if (method === "readLog") return [] as never;
        throw new Error(`Unexpected GAD method ${method}`);
      },
    });
    const stale = initialAgentState({ channelId: "channel:cache", config, selfId: "agent:self" });
    delete (stale as Partial<typeof stale>).modelContextVersion;
    stale.entries.push({ kind: "note", seq: 0, text: "stale cached projection" });
    sql.exec(
      `INSERT INTO fold_cache (log_id, head, folded_seq, head_hash, state_blob, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      stale.logId,
      stale.head,
      stale.lastSeq,
      stale.lastHash,
      JSON.stringify(stale),
      0
    );

    const restored = await cache.loadState({
      logId: stale.logId,
      head: stale.head,
      channelId: stale.channelId,
      config,
      selfId: stale.selfId,
    });

    expect(restored.modelContextVersion).toBe(MODEL_CONTEXT_VERSION);
    expect(restored.entries).toEqual([]);
    expect(calls).toEqual(["getLogHead", "readLog"]);
  });
});
