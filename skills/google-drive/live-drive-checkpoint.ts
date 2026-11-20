import { isDeepStrictEqual } from "node:util";
import { fs } from "@workspace/runtime";
import { bindTestDriveTransport } from "./test-drive-transport.js";
import type {
  GoogleCheckpointReceipt,
  GoogleChange,
  GoogleWorkflowReport,
} from "./driveWorkflow/types.js";

type World = {
  id: string;
  goal: string;
  driveId: string;
  initial: string;
  pages: readonly {
    cursor: string;
    response: { nextPageToken?: string; newStartPageToken?: string } | null;
  }[];
  competitor: string | null;
  expected: GoogleCheckpointReceipt & {
    ids: readonly string[];
    attempts: number;
  };
};

export async function prepareDriveCheckpoint(world: World) {
  const directory = await fs.mkdtemp("drive-checkpoint");
  const checkpointPath = directory + "/cursor";
  async function readFile() {
    const cursor = await fs.readFile(checkpointPath, "utf8");
    if (typeof cursor !== "string") throw new Error("Drive checkpoint must contain text");
    return cursor;
  }
  async function persist(cursor: string) {
    const staged = directory + "/.pending";
    await fs.writeFile(staged, cursor);
    await fs.rename(staged, checkpointPath);
    if ((await readFile()) !== cursor)
      throw new Error("Checkpoint readback differs from the replacement");
  }
  await persist(world.initial);
  const requests: { cursor: string; driveId: string; status: number }[] = [];
  let terminal: string | undefined;
  let observed: string | undefined;
  let commitStarted = false;
  let competitorApplied = false;
  let receipt: GoogleCheckpointReceipt | undefined;
  const googleWorkspaceRead = bindTestDriveTransport(
    {
      changes: { initialCursor: world.initial, driveId: world.driveId },
      maxPageReads: world.pages.length,
    },
    async (url) => {
      const coordinate = world.pages[requests.length];
      if (
        !coordinate ||
        url.pathname !== "/drive/v3/changes" ||
        url.searchParams.get("pageToken") !== coordinate.cursor ||
        url.searchParams.get("driveId") !== world.driveId ||
        url.searchParams.get("includeRemoved") !== "true" ||
        url.searchParams.get("includeItemsFromAllDrives") !== "true" ||
        url.searchParams.get("supportsAllDrives") !== "true"
      )
        throw new Error(
          "Unexpected request to the assigned Drive change transport",
        );
      const response = coordinate.response;
      requests.push({
        cursor: coordinate.cursor,
        driveId: world.driveId,
        status: response ? 200 : 503,
      });
      if (!response)
        return Response.json(
          { error: { message: "Unavailable Drive tail" } },
          { status: 503 },
        );
      if (!response.nextPageToken && response.newStartPageToken) {
        if (world.competitor) {
          await persist(world.competitor);
          competitorApplied = true;
        }
        terminal = response.newStartPageToken;
      }
      return Response.json(response);
    },
  );
  const driveCheckpoint = {
    async read() {
      if (observed !== undefined)
        throw new Error("Read the assigned checkpoint once");
      return (observed = await readFile());
    },
    async commit(
      expected: string,
      next: string,
    ): Promise<GoogleCheckpointReceipt> {
      if (
        commitStarted ||
        observed === undefined ||
        observed !== expected ||
        !terminal ||
        next !== terminal
      )
        throw new Error(
          "Commit requires the observed cursor and the exact terminal Drive checkpoint",
        );
      commitStarted = true;
      const stored = await readFile();
      if (stored !== expected)
        return (receipt = { state: "stale", cursor: stored });
      await persist(next);
      return (receipt = { state: "saved", cursor: await readFile() });
    },
  };
  const request = { kind: "sync-checkpoint" as const, goal: world.goal };
  async function verify(report: GoogleWorkflowReport | null) {
    const persisted = await readFile();
    const checks = {
      exactTransport: isDeepStrictEqual(
        requests,
        world.pages.map(({ cursor, response }) => ({
          cursor,
          driveId: world.driveId,
          status: response ? 200 : 503,
        })),
      ),
      exactRead: observed === world.initial,
      exactWrite:
        Number(commitStarted) === world.expected.attempts &&
        competitorApplied === Boolean(world.competitor) &&
        persisted === world.expected.cursor &&
        (world.expected.attempts === 0
          ? receipt === undefined
          : isDeepStrictEqual(receipt, {
              state: world.expected.state,
              cursor: world.expected.cursor,
            })),
      exactReport:
        report?.action === "none" &&
        report.status ===
          (world.expected.state === "saved" ? "complete" : "partial") &&
        report.checkpoint === persisted &&
        isDeepStrictEqual(report.checkpointWrite, {
          state: world.expected.state,
          cursor: persisted,
        }) &&
        isDeepStrictEqual(report.ids, world.expected.ids),
    };
    return {
      passed: Object.values(checks).every(Boolean),
      caseId: world.id,
      request,
      requests,
      observed,
      terminal: terminal ?? null,
      persisted,
      receipt: receipt ?? null,
      checks,
    };
  }
  return {
    request,
    services: { driveCheckpoint, googleWorkspaceRead },
    verify,
    async qualify() {
      const ready = await googleWorkspaceRead.readiness();
      if (ready.state !== "ready")
        throw new Error(
          "The assigned fixture transport did not verify readiness",
        );
      const initial = await driveCheckpoint.read();
      let earlyRejected = false;
      try {
        await driveCheckpoint.commit(initial, "ignore-intermediate-checkpoint");
      } catch (error) {
        earlyRejected =
          error instanceof Error && /exact terminal/u.test(error.message);
      }
      const latest = new Map<string, GoogleChange>();
      let cursor: string | null = initial;
      let completed: string | null = null;
      while (cursor !== null) {
        try {
          const page = await googleWorkspaceRead.readChanges(cursor);
          for (const row of page.rows) latest.set(row.fileId, row);
          cursor = page.next;
          completed = page.checkpoint;
        } catch {
          break;
        }
      }
      const checkpointWrite = completed
        ? await driveCheckpoint.commit(initial, completed)
        : { state: "held" as const, cursor: initial };
      const report: GoogleWorkflowReport = {
        status: checkpointWrite.state === "saved" ? "complete" : "partial",
        action: "none",
        ids: [...latest.keys()],
        findings: [],
        checkpoint: checkpointWrite.cursor,
        checkpointWrite,
      };
      return {
        earlyRejected,
        report,
        verification: await verify(report),
      };
    },
    async close() {
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}
