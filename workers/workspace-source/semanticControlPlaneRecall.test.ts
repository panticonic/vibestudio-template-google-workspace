/** Builtin recall deduplication across copied trajectory and channel projections. */
import { describe, expect, it, beforeEach } from "vitest";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { GadWorkspaceDO } from "./index.js";

type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;
type PrivateReach = {
  indexMemoryRow(row: {
    text: string;
    kind: "message" | "file" | "commit";
    logId?: string | null;
    head?: string | null;
    eventId?: string | null;
    path?: string | null;
    contentHash?: string | null;
    anchor?: Record<string, unknown> | null;
  }): void;
};
const reach = (doi: GadWorkspaceDO): PrivateReach => doi as unknown as PrivateReach;

describe("GadWorkspaceDO — recall deduplication", () => {
  let gad: TestGad;
  let doi: GadWorkspaceDO;

  beforeEach(async () => {
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad-recall-soft" });
    doi = gad.instance;
  });

  it("dedup keeps the page full: a duplicate copy is collapsed without stealing a slot", () => {
    // Six distinct items sharing the term "widget", each a distinct event id.
    for (let i = 1; i <= 6; i += 1) {
      reach(doi).indexMemoryRow({
        text: `widget number ${["one", "two", "three", "four", "five", "six"][i - 1]}`,
        kind: "message",
        logId: "traj:D",
        head: "h-main",
        eventId: `e-w${i}`,
      });
    }
    // A published/fork COPY of the first item: same (kind, event_id), other head.
    reach(doi).indexMemoryRow({
      text: "widget number one",
      kind: "message",
      logId: "traj:D",
      head: "h-fork",
      eventId: "e-w1",
    });

    const results = doi.recallMemory({ query: "widget", limit: 5 }).results;
    // Full page (a naive dedup-after-fetch under a limit-5 SQL page would return
    // 4 here, since the copy sits inside the first five inserted rows).
    expect(results).toHaveLength(5);
    const ids = results.map((r) => r.eventId);
    expect(new Set(ids).size).toBe(5);
    expect(ids.filter((id) => id === "e-w1").length).toBeLessThanOrEqual(1);
  });

  it("dedup prefers the trajectory-log copy over a channel republish", () => {
    gad.sql.exec(
      `INSERT INTO log_heads (log_id, head, log_kind, owner_json, created_at)
       VALUES ('traj:X', 'main', 'trajectory', '{}', '2026-01-01T00:00:00.000Z'),
              ('chan:Y', 'main', 'channel', '{}', '2026-01-01T00:00:00.000Z')`
    );
    // Insert the channel copy FIRST so the swap branch (adopt the trajectory
    // copy over an already-kept non-trajectory one) is exercised.
    reach(doi).indexMemoryRow({
      text: "shared echo of a published message",
      kind: "message",
      logId: "chan:Y",
      head: "main",
      eventId: "e-shared",
    });
    reach(doi).indexMemoryRow({
      text: "shared echo of a published message",
      kind: "message",
      logId: "traj:X",
      head: "main",
      eventId: "e-shared",
    });

    const results = doi.recallMemory({ query: "shared echo" }).results;
    expect(results).toHaveLength(1);
    expect(results[0]!.logId).toBe("traj:X");
  });

  it("widens an empty multi-term query so a scope hint cannot mask distinctive memory", () => {
    reach(doi).indexMemoryRow({
      text: "Retire Harbor Lantern after launch; use Retention Service in support records",
      kind: "commit",
      eventId: "event:retire-codename",
    });

    const results = doi.recallMemory({
      query: "projects/customer-retention Retire",
      kinds: ["commit"],
    }).results;

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "commit",
      eventId: "event:retire-codename",
      snippet: expect.stringContaining("Retire Harbor Lantern"),
    });
  });

  it("recalls a commit from the authored intent when its title uses different words", () => {
    gad.sql.exec(
      `INSERT INTO gad_workspace_events
         (event_id, command_id, kind, result_workspace_fact_root_id, message, created_at)
       VALUES ('event:retention-launch', 'command:commit', 'commit',
               'root:retention-launch', 'Finish the post-launch documentation pass',
               '2026-01-02T00:00:00.000Z');
       INSERT INTO gad_work_units
         (work_unit_id, command_id, kind, intent_summary, author_context_id,
          content_class, external_lineage_json, normalization_protocol, created_at)
       VALUES ('work:retention-launch', 'command:edit', 'edit',
               'Retire the Harbor Lantern rollout codename so support and audit records use Retention Service',
               'context:author', 'internal', '[]', 'semantic-v1',
               '2026-01-01T00:00:00.000Z');
       INSERT INTO gad_work_unit_applications
         (application_id, work_unit_id, basis_kind, basis_id,
          result_workspace_fact_root_id, semantic_protocol)
       VALUES ('application:retention-launch', 'work:retention-launch', 'event',
               'event:parent', 'root:retention-launch', 'semantic-v1');
       INSERT INTO gad_workspace_event_applications (event_id, ordinal, application_id)
       VALUES ('event:retention-launch', 0, 'application:retention-launch')`
    );
    reach(doi).indexMemoryRow({
      text: "Finish the post-launch documentation pass",
      kind: "commit",
      eventId: "event:retention-launch",
      anchor: {
        workspaceEventId: "event:retention-launch",
        workspaceFactRootId: "root:retention-launch",
      },
    });

    const results = doi.recallMemory({
      query: "Harbor Lantern rollout codename",
      kinds: ["commit"],
    }).results;

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "commit",
      eventId: "event:retention-launch",
      snippet: expect.stringContaining("Harbor Lantern rollout codename"),
    });
  });
});
