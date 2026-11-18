export type GoogleReadiness = {
  state:
    | "needs-setup"
    | "needs-consent"
    | "needs-verification"
    | "needs-drive-scope"
    | "verification-failed"
    | "ready";
};
export type GoogleFolderRow = {
  id: string;
  name: string;
  mimeType: string;
  modifiedAt: string | null;
  shortcut: boolean;
};
export type GooglePermission = {
  id: string;
  principalKind: string;
  principal: string | null;
  role: string;
  discovery: boolean;
  deleted: boolean;
};
export type GoogleChange = {
  fileId: string;
  removed: boolean;
  name: string | null;
  time: string | null;
};
export type GoogleFolderPage = {
  rows: GoogleFolderRow[];
  next: string | null;
  incomplete: boolean;
};
export type GooglePermissionsPage = {
  rows: GooglePermission[];
  next: string | null;
};
export type GoogleChangesPage = {
  rows: GoogleChange[];
  next: string | null;
  checkpoint: string | null;
};
export type GoogleInventoryRequest = {
  kind: "inventory";
  folderId: string;
  goal: string;
  media: string[];
  modifiedSince: string | null;
};
export type GoogleSharingRequest = {
  kind: "sharing";
  fileId: string;
  goal: string;
  allowedDomains: string[];
  allowWriters: boolean;
};
export type GoogleSyncRequest = { kind: "sync"; cursor: string; goal: string };
export type GoogleWorkflowRequest =
  | { kind: "setup"; goal: string }
  | GoogleInventoryRequest
  | GoogleSharingRequest
  | GoogleSyncRequest;
export type GoogleWorkflowReport = {
  status: "ready" | "action-needed" | "complete" | "partial";
  action:
    | "none"
    | "open-setup"
    | "connect"
    | "verify"
    | "add-drive-scope"
    | "diagnose";
  ids: string[];
  findings: string[];
  checkpoint: string | null;
};
