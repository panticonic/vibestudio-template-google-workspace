/**
 * Fold cache (WS1 §2.3) — P1 cache with derivation "fold of the log through
 * folded_seq", validated against the gad store's head hash on wake. Never
 * authority: deleting the row at any moment forces a cold refold with
 * identical behavior.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import {
  applyEvent,
  initialAgentState,
  normalizeForkControlState,
  overlayInputConfig,
  type AgentLoopConfig,
  type AgentState,
  MODEL_CONTEXT_VERSION,
} from "@workspace/agent-loop";
import type { LogEnvelope } from "@workspace/agentic-protocol";

export interface GadPort {
  call<T = unknown>(method: string, args: Record<string, unknown>): Promise<T>;
}

export function ensureFoldCacheSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS fold_cache (
      log_id      TEXT NOT NULL,
      head        TEXT NOT NULL,
      folded_seq  INTEGER NOT NULL,
      head_hash   TEXT NOT NULL,
      state_blob  TEXT NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (log_id, head)
    )
  `);
}

const PAGE = 500;

export class FoldCache {
  constructor(
    private readonly sql: SqlStorage,
    private readonly gad: GadPort
  ) {
    ensureFoldCacheSchema(sql);
  }

  write(state: AgentState): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO fold_cache (log_id, head, folded_seq, head_hash, state_blob, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      state.logId,
      state.head,
      state.lastSeq,
      state.lastHash,
      JSON.stringify(state),
      Date.now()
    );
  }

  private read(logId: string, head: string): AgentState | null {
    const rows = this.sql
      .exec(`SELECT * FROM fold_cache WHERE log_id = ? AND head = ?`, logId, head)
      .toArray();
    if (rows.length === 0) return null;
    try {
      const state = JSON.parse(String(rows[0]!["state_blob"])) as AgentState;
      // The cache is disposable. A projection-version mismatch must cold-fold
      // the journal so historical assistant identity is reconstructed from
      // the exact message.started request rather than guessed from live config.
      return state.modelContextVersion === MODEL_CONTEXT_VERSION ? state : null;
    } catch {
      return null;
    }
  }

  delete(logId: string, head: string): void {
    this.sql.exec(`DELETE FROM fold_cache WHERE log_id = ? AND head = ?`, logId, head);
  }

  /** Wake protocol (§2.3): validate-or-refold. */
  async loadState(input: {
    logId: string;
    head: string;
    channelId: string;
    config: AgentLoopConfig;
    /** This agent's participant/actor id — folded into state so the fold filters out
     *  foreign-authored turn lifecycle events (see AgentState.selfId). */
    selfId: string;
    lineageSelfIds?: string[];
  }): Promise<AgentState> {
    const remote = await this.gad.call<{
      seq: number;
      hash: string;
      forkSeq: number | null;
      forkHash: string | null;
    } | null>("getLogHead", { logId: input.logId, head: input.head });

    const forkSeq = remote?.forkSeq ?? 0;
    const empty = (): AgentState =>
      initialAgentState({
        channelId: input.channelId,
        logId: input.logId,
        head: input.head,
        config: input.config,
        forkSeq,
        lastSeq: forkSeq,
        selfId: input.selfId,
        lineageSelfIds: input.lineageSelfIds,
        ...(remote?.forkHash ? { lastHash: remote.forkHash } : {}),
      });

    if (!remote) return empty();

    const cached = this.read(input.logId, input.head);
    if (cached && cached.lastSeq === remote.seq && cached.lastHash === remote.hash) {
      // Input settings overlay, but fold-owned config (roster) is preserved —
      // input.config carries an empty sentinel roster, so a naive overlay
      // would wipe the folded roster and silently break channel tools.
      return normalizeForkControlState({
        ...cached,
        forkSeq,
        selfId: input.selfId,
        lineageSelfIds: input.lineageSelfIds ?? [],
        config: overlayInputConfig(cached.config, input.config),
      });
    }

    let state: AgentState;
    if (cached && remote.seq > cached.lastSeq) {
      // fold the tail; verify continuity on the first tail envelope
      const tail = await this.readAll(input.logId, input.head, cached.lastSeq);
      if (tail.length > 0 && tail[0]!.prevHash !== cached.lastHash) {
        state = await this.coldRefold(empty(), input.logId, input.head, forkSeq);
      } else {
        state = {
          ...cached,
          forkSeq,
          ...(input.selfId ? { selfId: input.selfId } : {}),
          lineageSelfIds: input.lineageSelfIds ?? [],
          config: overlayInputConfig(cached.config, input.config),
        };
        // a forked head's inherited prefix may begin BELOW the cached seq of a
        // pre-fork cache — the prevHash check above catches that mismatch
        for (const envelope of tail) state = applyEvent(state, envelope);
      }
    } else {
      state = await this.coldRefold(empty(), input.logId, input.head, forkSeq);
    }
    state = normalizeForkControlState(state);
    this.write(state);
    return state;
  }

  private async coldRefold(
    initial: AgentState,
    logId: string,
    head: string,
    forkSeq: number
  ): Promise<AgentState> {
    // lineage reads include the parent prefix; the inherited part starts at 0
    let state: AgentState = { ...initial, lastSeq: 0, lastHash: initial.lastHash };
    const envelopes = await this.readAll(logId, head, 0);
    // re-base hash baseline for refolds that begin before the fork point
    if (envelopes.length > 0) state = { ...state, lastHash: envelopes[0]!.prevHash };
    for (const envelope of envelopes) state = applyEvent(state, envelope);
    if (envelopes.length === 0) {
      state = { ...state, lastSeq: forkSeq };
    }
    return { ...state, forkSeq };
  }

  private async readAll(logId: string, head: string, afterSeq: number): Promise<LogEnvelope[]> {
    const all: LogEnvelope[] = [];
    let cursor = afterSeq;
    for (;;) {
      const page = await this.gad.call<LogEnvelope[]>("readLog", {
        logId,
        head,
        afterSeq: cursor,
        limit: PAGE,
      });
      if (page.length === 0) break;
      all.push(...page);
      cursor = page[page.length - 1]!.seq;
      if (page.length < PAGE) break;
    }
    return all;
  }
}
