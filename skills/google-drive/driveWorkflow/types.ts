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
export type GoogleInventorySharingRequest = {
  kind: "inventory-sharing";
  goal: string;
  inventory: GoogleInventoryRequest;
  sharing: GoogleSharingRequest;
};
export type GoogleSharingGate =
  | "audited"
  | "inventory-partial"
  | "target-unconfirmed";
export type GoogleSyncRequest = { kind: "sync"; cursor: string; goal: string };
export type GoogleCheckpointRequest = { kind: "sync-checkpoint"; goal: string };
export type GoogleCheckpointReceipt = {
  state: "saved" | "held" | "stale";
  cursor: string;
};
export type GoogleSetupCheck =
  | { kind: "owners" }
  | { kind: "launch-gate"; afterReload: boolean }
  | { kind: "viewport"; width: number }
  | { kind: "scope-choice"; scope: "gmail" | "workspace" }
  | { kind: "browser-choice"; opening: "here" | "external" }
  | { kind: "choice-reload" };
export type GoogleSetupControls = {
  scope: "gmail" | "workspace";
  opening: "here" | "external";
  guidance: "gmail" | "workspace" | "unknown";
  connectEnabled: boolean;
  gmailEnabled: boolean;
};
export type GoogleSetupReceipt = {
  id: string;
  check: GoogleSetupCheck;
  stage: string;
  accountOwner: boolean;
  permissionsOwner: boolean;
  gmailEnabled: boolean;
  inheritedLaunch: boolean | null;
  overflow: boolean;
  viewportWidth: number | null;
  controls?: { before: GoogleSetupControls; after: GoogleSetupControls };
};
export type GoogleSetupFinding = {
  check: GoogleSetupCheck;
  code:
    | "owner-routes"
    | "owner-route-missing"
    | "gmail-closed"
    | "gmail-open"
    | "gmail-inconsistent-after-reload"
    | "viewport-fits"
    | "viewport-overflow"
    | "setup-scope-confirmed"
    | "setup-browser-confirmed"
    | "setup-defaults-restored"
    | "setup-choice-inconsistent"
    | "setup-gate-open";
  evidenceId: string;
};
export type GoogleSetupJourneyRequest = {
  kind: "setup-journey";
  goal: string;
  checks: GoogleSetupCheck[];
};
export type GoogleWorkflowRequest =
  | GoogleSetupJourneyRequest
  | { kind: "setup"; goal: string }
  | GoogleInventoryRequest
  | GoogleInventorySharingRequest
  | GoogleSharingRequest
  | GoogleSyncRequest
  | GoogleCheckpointRequest;
export type GoogleWorkflowStatus =
  | "ready"
  | "action-needed"
  | "complete"
  | "partial";
export type GoogleWorkflowReport = {
  status: GoogleWorkflowStatus;
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
  driveDelta?: GoogleChange[];
  panelFindings?: GoogleSetupFinding[];
  checkpointWrite?: GoogleCheckpointReceipt;
  inventoryAudit?: { gate: GoogleSharingGate; inventoryIds: string[] };
};
