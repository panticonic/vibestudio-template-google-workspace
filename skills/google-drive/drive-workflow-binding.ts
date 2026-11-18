import {
  createGoogleDriveClient,
  getGoogleDriveOnboardingStatus,
} from "./index.js";
import {
  bindGoogleWorkspaceRead,
  type GoogleWorkspaceAssignment,
  type GoogleWorkspaceSource,
} from "./drive-workflow-read.js";

export type {
  GoogleWorkspaceRead,
  GoogleWorkspaceAssignment,
} from "./drive-workflow-read.js";

export function createGoogleWorkspaceRead(
  assignment: GoogleWorkspaceAssignment,
  source: GoogleWorkspaceSource = {
    inspect: getGoogleDriveOnboardingStatus,
    drive: createGoogleDriveClient,
  },
) {
  return bindGoogleWorkspaceRead(assignment, source);
}
