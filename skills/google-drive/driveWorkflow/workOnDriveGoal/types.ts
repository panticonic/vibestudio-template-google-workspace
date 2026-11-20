import type { GoogleInventoryRequest, GoogleSyncRequest } from "../types.js";

export type DriveGoalScope = {
  folders: { id: string; name: string; description: string }[];
  changeSources: { cursor: string; name: string }[];
};
export type DriveFolderGoalPlan = {
  kind: "folder";
  inventory: GoogleInventoryRequest;
  audit: { allowedDomains: string[]; allowWriters: boolean } | null;
};
export type DriveGoalPlan =
  | DriveFolderGoalPlan
  | { kind: "changes"; request: GoogleSyncRequest };
