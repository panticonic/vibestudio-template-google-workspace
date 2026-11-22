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
  folders?: readonly { id: string; driveId?: string }[];
  sharingFileId?: string;
  sharingFileIds?: readonly string[];
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
    folders = [],
    sharingFileId,
    sharingFileIds = [],
    changes,
    maxPageReads = 24,
  } = structuredClone(assignment);
  if (!Number.isSafeInteger(maxPageReads) || maxPageReads < 1)
    throw new Error("Invalid Drive page-read limit");
  const declaredFolders = [
    ...(folder ? [folder] : []),
    ...folders,
  ];
  const ownedFolders = new Map(declaredFolders.map((entry) => [entry.id, entry]));
  if (ownedFolders.size !== declaredFolders.length)
    throw new Error("Each assigned Drive folder must have a unique ID");
  const ownedFiles = new Set([
    ...(sharingFileId === undefined ? [] : [sharingFileId]),
    ...sharingFileIds,
  ]);
  for (const id of [
    ...[...ownedFolders.values()].flatMap((entry) => [entry.id, entry.driveId]),
    ...ownedFiles,
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
    const pending = new Map<T, Promise<unknown>>();
    return {
      begin(token: T) {
        if (!permitted.has(token))
          throw new Error(
            "Drive cursor is outside this assigned read",
          );
      },
      async read<R>(token: T, operation: () => Promise<R>): Promise<R> {
        const current = pending.get(token);
        if (current) return current as Promise<R>;
        const result = operation();
        pending.set(token, result);
        try { return await result; }
        finally { if (pending.get(token) === result) pending.delete(token); }
      },
      permit(next: T) {
        if (next !== null) permitted.add(next);
      },
    };
  }
  const folderPages = new Map([...ownedFolders.keys()].map(
    (id) => [id, pager<string | null>([null])],
  ));
  const permissionPages = new Map([...ownedFiles].map(
    (id) => [id, pager<string | null>([null])],
  ));
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
      const target = ownedFolders.get(folderId);
      const pages = folderPages.get(folderId);
      if (!target || !pages)
        throw new Error("Folder is outside the assigned Drive read");
      const page = await pages.read(pageToken, () => pageRead(
        () => pages.begin(pageToken),
        (drive) =>
          drive.listFiles({
            q: `'${folderId}' in parents and trashed = false`,
            fields:
              "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,shortcutDetails)",
            pageToken: pageToken ?? undefined,
            corpora: target.driveId ? "drive" : "user",
            driveId: target.driveId,
            includeItemsFromAllDrives: Boolean(target.driveId),
          }),
      ));
      const next = page.nextPageToken ?? null;
      pages.permit(next);
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
      const pages = permissionPages.get(fileId);
      if (!pages)
        throw new Error("File is outside the assigned Drive read");
      const page = await pages.read(pageToken, () => pageRead(
        () => pages.begin(pageToken),
        (drive) =>
          drive.listPermissions(fileId, {
            fields:
              "nextPageToken,permissions(id,type,role,emailAddress,domain,deleted,allowFileDiscovery)",
            pageToken: pageToken ?? undefined,
          }),
      ));
      const next = page.nextPageToken ?? null;
      pages.permit(next);
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
      const page = await changePages.read(cursor, () => pageRead(
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
      ));
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
