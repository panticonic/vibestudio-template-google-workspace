declare module "natlang:services" {
  export const googleGoalDiscovery: {
    discover(): Promise<import("./workOnDriveGoal/types.js").DriveGoalScope>;
  };
  export const driveCheckpoint: {
    read(): Promise<string>;
    commit(
      expected: string,
      terminal: string,
    ): Promise<import("./types.js").GoogleCheckpointReceipt>;
  };
  export const googleSetupPanel: {
    observe(): Promise<import("./types.js").GoogleSetupReceipt[]>;
  };
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
