import { isDeepStrictEqual } from "node:util";
import { bindTestDriveTransport } from "./test-drive-transport.js";
import eligibleRows from "./driveWorkflow/guideGoogleWorkspace/inspectFolder/eligibleRows.js";
import type {
  GoogleFolderRow,
  GoogleInventoryRequest,
  GoogleInventorySharingRequest,
  GooglePermission,
  GoogleSharingGate,
  GoogleSharingRequest,
  GoogleWorkflowReport,
} from "./driveWorkflow/types.js";

type Page = { cursor: string | null; response: object | null };
type World = {
  id: string;
  goal: string;
  driveId: string;
  inventory: GoogleInventoryRequest;
  sharing: GoogleSharingRequest;
  folderPages: readonly Page[];
  permissionPages: readonly Page[];
  expected: {
    gate: GoogleSharingGate;
    inventoryIds: readonly string[];
    ids: readonly string[];
  };
};

export function prepareDriveSharing(world: World) {
  const request: GoogleInventorySharingRequest = {
    kind: "inventory-sharing",
    goal: world.goal,
    inventory: world.inventory,
    sharing: world.sharing,
  };
  const requests: {
    kind: "folder" | "permissions";
    cursor: string | null;
    status: number;
  }[] = [];
  const rows: GoogleFolderRow[] = [];
  const permissions: GooglePermission[] = [];
  let complete = false;
  let incomplete = false;
  const binding = bindTestDriveTransport(
    {
      folder: { id: world.inventory.folderId, driveId: world.driveId },
      sharingFileId: world.sharing.fileId,
      maxPageReads: world.folderPages.length + world.permissionPages.length,
    },
    async (url) => {
      const query = url.searchParams;
      const folder = url.pathname === "/drive/v3/files";
      if (query.get("supportsAllDrives") !== "true")
        throw new Error("The assigned Drive read must support shared drives");
      if (folder) {
        if (
          query.get("q") !==
            `'${world.inventory.folderId}' in parents and trashed = false` ||
          query.get("corpora") !== "drive" ||
          query.get("driveId") !== world.driveId ||
          query.get("includeItemsFromAllDrives") !== "true"
        )
          throw new Error(
            "Folder listing is outside the assigned shared drive",
          );
      } else if (
        url.pathname !== `/drive/v3/files/${world.sharing.fileId}/permissions`
      ) {
        throw new Error("Permission request is outside the assigned file");
      }
      const kind = folder ? "folder" : "permissions";
      const pages = folder ? world.folderPages : world.permissionPages;
      const page =
        pages[requests.filter((entry) => entry.kind === kind).length];
      const cursor = query.get("pageToken");
      if (!page || page.cursor !== cursor)
        throw new Error("Unexpected Drive page token");
      requests.push({ kind, cursor, status: page.response ? 200 : 503 });
      return page.response
        ? Response.json(page.response)
        : Response.json(
            { error: { message: "Folder tail unavailable" } },
            { status: 503 },
          );
    },
  );
  const inventoryIds = () =>
    eligibleRows(request.inventory, rows).map(({ id }) => id);
  const gate = (): GoogleSharingGate => {
    if (!complete || incomplete) return "inventory-partial";
    return inventoryIds().includes(request.sharing.fileId)
      ? "audited"
      : "target-unconfirmed";
  };
  const googleWorkspaceRead = {
    ...binding,
    async listFolder(folderId: string, token: string | null) {
      const page = await binding.listFolder(folderId, token);
      rows.push(...page.rows);
      incomplete ||= page.incomplete;
      complete = page.next === null;
      return page;
    },
    async readPermissions(fileId: string, token: string | null) {
      if (gate() !== "audited")
        throw new Error(
          "Sharing requires a complete inventory and the assigned current file",
        );
      const page = await binding.readPermissions(fileId, token);
      permissions.push(...page.rows);
      return page;
    },
  };
  function verify(report: GoogleWorkflowReport | null) {
    const expectedRequests = (["folder", "permissions"] as const).flatMap(
      (kind) =>
        (kind === "folder" ? world.folderPages : world.permissionPages).map(
          ({ cursor, response }) => ({
            kind,
            cursor,
            status: response ? 200 : 503,
          }),
        ),
    );
    const checks = {
      exactTransport: isDeepStrictEqual(requests, expectedRequests),
      inventoryGate:
        gate() === world.expected.gate &&
        isDeepStrictEqual(inventoryIds(), world.expected.inventoryIds),
      exactReport:
        report?.action === "none" &&
        report.checkpoint === null &&
        report.status ===
          (world.expected.gate === "audited" ? "complete" : "partial") &&
        isDeepStrictEqual(report.inventoryAudit, {
          gate: world.expected.gate,
          inventoryIds: world.expected.inventoryIds,
        }) &&
        isDeepStrictEqual(report.ids, world.expected.ids),
    };
    return {
      passed: Object.values(checks).every(Boolean),
      request,
      caseId: world.id,
      requests,
      inventoryIds: inventoryIds(),
      permissions,
      checks,
    };
  }
  return {
    request,
    services: { googleWorkspaceRead },
    verify,
    async qualify() {
      if ((await binding.readiness()).state !== "ready")
        throw new Error("Drive fixture is unavailable");
      let earlyRejected = false;
      try {
        await googleWorkspaceRead.readPermissions(world.sharing.fileId, null);
      } catch (error) {
        earlyRejected =
          error instanceof Error && /complete inventory/u.test(error.message);
      }
      let token: string | null = null;
      do {
        try {
          token = (
            await googleWorkspaceRead.listFolder(
              world.inventory.folderId,
              token,
            )
          ).next;
        } catch {
          break;
        }
      } while (token !== null);
      const outcome = gate();
      let heldPermissionRejected = outcome === "audited";
      if (outcome === "audited") {
        token = null;
        do {
          token = (
            await googleWorkspaceRead.readPermissions(
              world.sharing.fileId,
              token,
            )
          ).next;
        } while (token !== null);
      } else {
        try {
          await googleWorkspaceRead.readPermissions(world.sharing.fileId, null);
        } catch (error) {
          heldPermissionRejected =
            error instanceof Error && /complete inventory/u.test(error.message);
        }
      }
      const ids = permissions
        .filter((row) => {
          if (row.deleted) return false;
          const domain = row.principal?.split("@").at(-1)?.toLowerCase();
          return (
            row.principalKind === "anyone" ||
            !domain ||
            !world.sharing.allowedDomains.includes(domain) ||
            (!world.sharing.allowWriters &&
              ["writer", "organizer", "fileOrganizer"].includes(row.role))
          );
        })
        .map(({ id }) => id);
      return {
        earlyRejected: earlyRejected && heldPermissionRejected,
        verification: verify({
          action: "none",
          status: outcome === "audited" ? "complete" : "partial",
          ids,
          checkpoint: null,
          findings: [],
          inventoryAudit: { gate: outcome, inventoryIds: inventoryIds() },
        }),
      };
    },
  };
}
