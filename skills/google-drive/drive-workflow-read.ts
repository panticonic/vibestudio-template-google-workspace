import type {
  createGoogleDriveClient,
  getGoogleDriveOnboardingStatus,
} from "./index.js";
import type {
  GoogleReadiness,
  GoogleFolderPage,
  GooglePermissionsPage,
  GoogleChangesPage,
} from "./driveWorkflow/types.js";

export type GoogleWorkspaceRead = {
  readiness(): Promise<GoogleReadiness>;
  listFolder(
    folderId: string,
    pageToken: string | null,
  ): Promise<GoogleFolderPage>;
  readPermissions(
    fileId: string,
    pageToken: string | null,
  ): Promise<GooglePermissionsPage>;
  readChanges(cursor: string): Promise<GoogleChangesPage>;
};

export type GoogleWorkspaceSource = {
  inspect: typeof getGoogleDriveOnboardingStatus;
  drive: typeof createGoogleDriveClient;
};

export type GoogleWorkspaceAssignment = {
  folder?: { id: string; driveId?: string };
  sharingFileId?: string;
  changes?: { initialCursor: string; driveId?: string };
  maxPageReads?: number;
};

const driveIdPattern = /^[A-Za-z0-9_-]+$/u;
const requireId = (id: string) => {
  if (!driveIdPattern.test(id))
    throw new Error("Invalid assigned Drive resource ID");
};

export function bindGoogleWorkspaceRead(
  assignment: GoogleWorkspaceAssignment,
  source: GoogleWorkspaceSource,
): GoogleWorkspaceRead {
  const {
    folder,
    sharingFileId,
    changes,
    maxPageReads = 24,
  } = structuredClone(assignment);
  if (!Number.isSafeInteger(maxPageReads) || maxPageReads < 1)
    throw new Error("Invalid Drive page-read limit");
  for (const id of [
    folder?.id,
    folder?.driveId,
    sharingFileId,
    changes?.driveId,
  ]) {
    if (id !== undefined) requireId(id);
  }
  let client: ReturnType<GoogleWorkspaceSource["drive"]> | undefined;
  let remaining = maxPageReads;

  function pageRead<T>(
    begin: () => void,
    operation: (
      drive: ReturnType<GoogleWorkspaceSource["drive"]>,
    ) => Promise<T>,
  ) {
    if (!client)
      throw new Error("Verify the assigned Drive access before reading");
    if (remaining === 0)
      throw new Error("The assigned Drive page-read limit was reached");
    begin();
    remaining--;
    return operation(client);
  }

  function pager<T extends string | null>(initial: readonly T[]) {
    const permitted = new Set(initial);
    const completed = new Set<T>();
    return {
      begin(token: T) {
        if (!permitted.has(token) || completed.has(token))
          throw new Error(
            "Drive cursor is outside this assigned read or has already been consumed",
          );
        completed.add(token);
      },
      permit(next: T) {
        if (next !== null) permitted.add(next);
      },
    };
  }
  const folderPages = pager<string | null>([null]);
  const permissionPages = pager<string | null>([null]);
  const changePages = pager<string | null>(
    changes ? [changes.initialCursor] : [],
  );

  return {
    async readiness() {
      client = undefined;
      const observed = await source.inspect({ verify: true });
      const workspace = observed.googleWorkspace;
      let state: GoogleReadiness["state"];
      if (workspace.stage === "needs-setup") state = "needs-setup";
      else if (workspace.stage === "ready-to-connect") state = "needs-consent";
      else if (workspace.stage === "connected") state = "needs-verification";
      else if (workspace.stage !== "verified" || observed.stage === "error")
        state = "verification-failed";
      else if (observed.stage === "needs-google-workspace")
        state = "needs-drive-scope";
      else if (observed.verified && observed.credentialId) {
        client = source.drive({ credentialId: observed.credentialId });
        state = "ready";
      } else state = "verification-failed";
      return { state };
    },
    async listFolder(folderId, pageToken) {
      if (!folder || folder.id !== folderId)
        throw new Error("Folder is outside the assigned Drive read");
      const page = await pageRead(
        () => folderPages.begin(pageToken),
        (drive) =>
          drive.listFiles({
            q: `'${folderId}' in parents and trashed = false`,
            fields:
              "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,shortcutDetails)",
            pageToken: pageToken ?? undefined,
            corpora: folder.driveId ? "drive" : "user",
            driveId: folder.driveId,
            includeItemsFromAllDrives: Boolean(folder.driveId),
          }),
      );
      const next = page.nextPageToken ?? null;
      folderPages.permit(next);
      return {
        next,
        incomplete: page.incompleteSearch === true,
        rows: (page.files ?? [])
          .filter((file) => Boolean(file.id))
          .map((file) => ({
            id: file.id,
            name: file.name ?? "",
            mimeType: file.mimeType ?? "",
            modifiedAt: file.modifiedTime ?? null,
            shortcut:
              file.mimeType === "application/vnd.google-apps.shortcut" ||
              file.shortcutDetails !== undefined,
          })),
      };
    },
    async readPermissions(fileId, pageToken) {
      if (!sharingFileId || sharingFileId !== fileId)
        throw new Error("File is outside the assigned Drive read");
      const page = await pageRead(
        () => permissionPages.begin(pageToken),
        (drive) =>
          drive.listPermissions(fileId, {
            fields:
              "nextPageToken,permissions(id,type,role,emailAddress,domain,deleted,allowFileDiscovery)",
            pageToken: pageToken ?? undefined,
          }),
      );
      const next = page.nextPageToken ?? null;
      permissionPages.permit(next);
      return {
        next,
        rows: (page.permissions ?? [])
          .filter((row) => Boolean(row.id))
          .map((row) => ({
            id: row.id,
            principalKind: row.type,
            principal: row.emailAddress ?? row.domain ?? null,
            role: row.role,
            discovery: row.allowFileDiscovery === true,
            deleted: row.deleted === true,
          })),
      };
    },
    async readChanges(cursor) {
      if (!changes)
        throw new Error("Change feed is outside the assigned Drive read");
      const page = await pageRead(
        () => changePages.begin(cursor),
        (drive) =>
          drive.listChanges({
            pageToken: cursor,
            fields:
              "nextPageToken,newStartPageToken,changes(fileId,time,removed,file(id,name,trashed))",
            driveId: changes.driveId,
            includeItemsFromAllDrives: Boolean(changes.driveId),
            includeRemoved: true,
          }),
      );
      const next = page.nextPageToken ?? null;
      changePages.permit(next);
      return {
        next,
        checkpoint: next === null ? (page.newStartPageToken ?? null) : null,
        rows: (page.changes ?? []).flatMap((row) =>
          row.fileId
            ? [
                {
                  fileId: row.fileId,
                  removed: row.removed === true || row.file?.trashed === true,
                  name: row.file?.name ?? null,
                  time: row.time ?? null,
                },
              ]
            : [],
        ),
      };
    },
  };
}
