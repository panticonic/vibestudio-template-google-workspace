declare module "natlang:services" {
  export const googleWorkspaceRead: {
    readiness(): Promise<import("./types.js").GoogleReadiness>;
    listFolder(
      folderId: string,
      pageToken: string | null,
    ): Promise<import("./types.js").GoogleFolderPage>;
    readPermissions(
      fileId: string,
      pageToken: string | null,
    ): Promise<import("./types.js").GooglePermissionsPage>;
    readChanges(
      cursor: string,
    ): Promise<import("./types.js").GoogleChangesPage>;
  };
}
