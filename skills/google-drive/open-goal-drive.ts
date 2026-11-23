import {assessSemanticOutcome,type SemanticOutcomeContract} from "@workspace-skills/system-testing/semantic-outcome-contract";
import { isDeepStrictEqual } from "node:util";
import { observePages } from "./page-observations.js";
import { bindTestDriveTransport } from "./test-drive-transport.js";
import type { DriveGoalScope } from "./driveWorkflow/workOnDriveGoal/types.js";
import type {
  GoogleChange,
  GoogleFolderRow,
  GoogleFolderPage,
  GooglePermissionsPage,
  GooglePermission,
  GoogleSharingGate,
  GoogleWorkflowReport,
} from "./driveWorkflow/types.js";

type Page = { cursor: string | null; response: object | null };
type Folder = DriveGoalScope["folders"][number] & { driveId: string; pages: readonly Page[] };
type ChangeSource = DriveGoalScope["changeSources"][number] & { driveId: string; pages: readonly Page[] };
type Profile = { allowedDomains: readonly string[]; allowWriters: boolean };
type Answer = {
  status: "complete" | "partial";
  ids: readonly string[];
  requiredTerms: readonly string[];
};
type FolderAnswer = Answer & {
  mode: "inventory" | "audit";
  folderId: string;
  inventoryIds: readonly string[];
  gate?: GoogleSharingGate;
  profile?: Profile;
};
type ChangeAnswer = Answer & { mode: "changes"; checkpoint: string };
export type OpenDriveWorld = {
  goal: string;
  folders: readonly Folder[];
  permissionPages?: Record<string, readonly Page[]>;
  changeSource?: ChangeSource;
  expected: FolderAnswer | ChangeAnswer;
};
type Request = { kind: "folder" | "permissions" | "changes"; resource: string; cursor: string | null; status: number };
type FolderRead = { rows: GoogleFolderRow[]; complete: boolean; incomplete: boolean };

function permissionRisks(rows: GooglePermission[], profile: Profile) {
  return rows.filter((row) => {
    if (row.deleted) return false;
    const domain = row.principal?.split("@").at(-1)?.toLowerCase();
    return !["user", "group", "domain"].includes(row.principalKind) ||
      !domain || !profile.allowedDomains.includes(domain) ||
      (!profile.allowWriters && ["writer", "organizer", "fileOrganizer"].includes(row.role));
  });
}

export function prepareOpenGoalDrive({ contextId, caseId }: {
  contextId: string;
  caseId: string;
}, world: OpenDriveWorld) {
  const { goal, folders, changeSource, permissionPages = {}, expected } = world;
  const scope: DriveGoalScope = {
    folders: folders.map(({ id, name, description }) => ({ id, name, description })),
    changeSources: changeSource ? [{ cursor: changeSource.cursor, name: changeSource.name }] : [],
  };
  const requests: Request[] = [];
  const folderReads = new Map<string, FolderRead>();
  const folderPageReads = new Map<string, Map<string | null, GoogleFolderPage>>();
  const permissionPageReads = new Map<string, Map<string | null, GooglePermissionsPage>>();
  const permissionComplete = new Map<string, boolean>();
  const permissionReads = new Map<string, GooglePermission[]>();
  const changes: GoogleChange[] = [];
  let terminal: string | null = null;
  let discoveries = 0;
  let readinessReads = 0;
  function reply(kind: Request["kind"], resource: string, cursor: string | null, pages: readonly Page[]) {
    const page = pages.find((entry) => entry.cursor === cursor);
    if (!page) throw new Error("Continue with a cursor observed for this Drive resource");
    const status = page.response ? 200 : 503;
    requests.push({ kind, resource, cursor, status });
    return page.response ? Response.json(page.response)
      : Response.json({ error: { message: "The provider's continuation page is unavailable" } }, { status });
  }
  const binding = bindTestDriveTransport({
    folders: folders.map(({ id, driveId }) => ({ id, driveId })),
    sharingFileIds: Object.keys(permissionPages),
    ...(changeSource ? { changes: { initialCursor: changeSource.cursor, driveId: changeSource.driveId } } : {}),
  }, async (url) => {
    const query = url.searchParams;
    const cursor = query.get("pageToken");
    if (query.get("supportsAllDrives") !== "true") throw new Error("Read the shared Drive view");
    if (url.pathname === "/drive/v3/files") {
      const folder = folders.find(({ id }) => query.get("q") === `'${id}' in parents and trashed = false`);
      if (!folder || query.get("driveId") !== folder.driveId || query.get("corpora") !== "drive" ||
          query.get("includeItemsFromAllDrives") !== "true")
        throw new Error("Drive folder is outside the current shared drives");
      return reply("folder", folder.id, cursor, folder.pages);
    }
    if (url.pathname === "/drive/v3/changes") {
      if (!changeSource || query.get("driveId") !== changeSource.driveId ||
          query.get("includeRemoved") !== "true" || query.get("includeItemsFromAllDrives") !== "true")
        throw new Error("Change read is outside the current shared drives");
      return reply("changes", changeSource.name, cursor, changeSource.pages);
    }
    const file = /^\/drive\/v3\/files\/([\w-]+)\/permissions$/u.exec(url.pathname)?.[1];
    if (!file || !Object.hasOwn(permissionPages, file)) throw new Error("Permission read is outside the current shared drives");
    return reply("permissions", file, cursor, permissionPages[file]!);
  });

  const services = {
    googleGoalDiscovery: {
      async discover() {
        discoveries++;
        return structuredClone(scope);
      },
    },
    googleWorkspaceRead: {
      async readiness() {
        readinessReads++;
        return binding.readiness();
      },
      async listFolder(id: string, token: string | null) {
        const page = await binding.listFolder(id, token);
        const pages = folderPageReads.get(id) ?? new Map<string | null, GoogleFolderPage>();
        pages.set(token, structuredClone(page));
        folderPageReads.set(id, pages);
        folderReads.set(id, observePages(pages));
        return page;
      },
      async readPermissions(id: string, token: string | null) {
        if (![...folderReads.values()].some(({ rows, complete, incomplete }) => complete && !incomplete &&
          rows.some((row) => row.id === id && !row.shortcut)))
          throw new Error("Confirm the current file in a complete Drive listing before reading its permissions");
        const page = await binding.readPermissions(id, token);
        const pages = permissionPageReads.get(id) ?? new Map<string | null, GooglePermissionsPage>();
        pages.set(token, structuredClone(page));
        permissionPageReads.set(id, pages);
        const observed = observePages(pages);
        permissionReads.set(id, observed.rows);
        permissionComplete.set(id, observed.complete);
        return page;
      },
      async readChanges(cursor: string) {
        const page = await binding.readChanges(cursor);
        changes.push(...structuredClone(page.rows));
        terminal = page.checkpoint;
        return page;
      },
    },
  };

  function verify(value: unknown) {
    const report = value as GoogleWorkflowReport | null;
    const hasAudit = expected.mode === "audit";
    const observedDelta = expected.mode === "changes"
      ? [...new Map(changes.map((change) => [change.fileId, change])).values()]
      : undefined;
    const checks = {
      discoveredDriveScope: discoveries > 0 && readinessReads > 0,
      boundDriveObservations: expected.mode === "changes"
        ? terminal === expected.checkpoint
        : Boolean(folderReads.has(expected.folderId) &&
            (expected.status !== "complete" || (folderReads.get(expected.folderId)!.complete && !folderReads.get(expected.folderId)!.incomplete)) &&
            (expected.mode !== "audit" || expected.gate !== "audited" ||
              expected.inventoryIds.every(id => permissionComplete.get(id) === true))),
      boundDriveOutcome: report?.action === "none" && report.status === expected.status &&
        isDeepStrictEqual(report.ids, expected.ids) &&
        isDeepStrictEqual(report.driveDelta, observedDelta) &&
        report.checkpoint === (expected.mode === "changes" ? expected.checkpoint : null) &&
        (hasAudit ? isDeepStrictEqual(report.inventoryAudit, {
          gate: expected.gate, inventoryIds: expected.inventoryIds,
        }) : report.inventoryAudit === undefined),
      groundedDriveFindings: Array.isArray(report?.findings) && report.findings.every((item) => typeof item === "string") &&
        expected.requiredTerms.every((item) => report.findings.join(" ").toLowerCase().includes(item.toLowerCase())),
      preservedReadOnlyScope: report?.checkpointWrite === undefined && report?.panelFindings === undefined,
    };
    const contract:SemanticOutcomeContract={effects:{checks:["discoveredDriveScope", "boundDriveObservations"],rationale:"Independent native observations, authority and persisted state establish application effects."},returnedValue:{checks:["boundDriveOutcome", "groundedDriveFindings", "preservedReadOnlyScope"],required:true,rationale:"These are the actual requested domain findings or query values; mutation-only calls retain their separately observed effects."},incidentalValues:{checks:[],rationale:"Optional incorrect mutation returns are recorded against the actual invocation, without invalidating correct native effects."}};
    return assessSemanticOutcome({
      contextId, caseId, goal, mode: expected.mode, gate: expected.mode === "audit" ? expected.gate : null,
      passed: Object.values(checks).every(Boolean), checks, requests: structuredClone(requests),
      discovery: structuredClone(scope), readinessReads, discoveries,
      observed: { folders: [...folderReads], permissions: [...permissionReads], changes, terminal },
    },contract);
  }

  async function qualify() {
    if ((await services.googleWorkspaceRead.readiness()).state !== "ready")
      throw new Error("The isolated Drive connection did not verify");
    await services.googleGoalDiscovery.discover();
    const report: GoogleWorkflowReport = { action: "none", status: "partial", ids: [], findings: [], checkpoint: null };
    if (expected.mode === "changes") {
      const start = changeSource!.cursor;
      let cursor: string | null = start;
      while (cursor !== null) {
        try {
          cursor = (await services.googleWorkspaceRead.readChanges(cursor)).next;
        } catch (error) {
          if (requests.at(-1)?.status !== 503) throw error;
          break;
        }
      }
      report.status = terminal ? "complete" : "partial";
      report.checkpoint = terminal ?? start;
      const latest = new Map(changes.map((change) => [change.fileId, change]));
      report.driveDelta = [...latest.values()];
      report.ids = [...latest.keys()];
      report.findings = [...latest.values()].map((change) => `${change.name ?? change.fileId}: ${change.removed ? "removed" : "updated"}`);
      if (!terminal) report.findings.push("Partial change coverage. Keep the original checkpoint.");
    } else {
      let cursor: string | null = null;
      do {
        try {
          cursor = (await services.googleWorkspaceRead.listFolder(expected.folderId, cursor)).next;
        } catch (error) {
          if (requests.at(-1)?.status !== 503) throw error;
          break;
        }
      } while (cursor !== null);
      const read = folderReads.get(expected.folderId);
      const selected = expected.inventoryIds.filter((id) => read?.rows.some((row) => row.id === id && !row.shortcut));
      report.status = read?.complete && !read.incomplete ? "complete" : "partial";
      report.ids = selected;
      report.findings = read?.rows.filter((row) => selected.includes(row.id)).map((row) => row.name) ?? [];
      if (expected.mode === "audit") {
        const gate = report.status === "partial" ? "inventory-partial"
          : selected.length === 1 ? "audited" : "target-unconfirmed";
        report.inventoryAudit = { gate, inventoryIds: selected };
        report.ids = [];
        if (gate === "audited") {
          const [file] = selected;
          cursor = null;
          do {
            cursor = (await services.googleWorkspaceRead.readPermissions(file!, cursor)).next;
          } while (cursor !== null);
          const risky = permissionRisks(permissionReads.get(file!) ?? [], expected.profile!);
          report.ids = risky.map(({ id }) => id);
          report.findings = risky.map((row) => `${row.principal ?? row.principalKind}: ${row.role}`);
        } else {
          report.status = "partial";
          report.findings.push(gate === "inventory-partial" ? "Partial inventory. Direct access review held."
            : "No unambiguous current file. Direct access review held.");
        }
      }
    }
    return verify(report);
  }

  return { goal, services, verify, qualify };
}
