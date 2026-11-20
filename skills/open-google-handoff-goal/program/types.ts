export type HandoffPlan = {
  stage: "none" | "ready" | "decision";
};
export type MailMessage = {
  id: string; from: string; subject: string; receivedAt: string; body: string; fileIds: string[];
};
export type MailThread = { id: string; messages: MailMessage[] };
export type MailObservation = { complete: boolean; threads: MailThread[] };
export type ReviewMode = "metadata" | "content" | "audience" | "content-and-audience";
export type AssetIntent = { messageId: string; fileId: string; mode: ReviewMode };
export type MailDecision = {
  status: "approved" | "withdrawn" | "unresolved" | "incomplete";
  mailIds: string[];
  requested: AssetIntent[];
};
export type PermissionEvidence = {
  id: string; type: string; role: string; address: string | null; deleted: boolean; pendingOwner: boolean;
  directRoles: string[];
};
export type AssetEvidence = {
  id: string; status: "current" | "missing" | "inaccessible" | "unavailable" | "trashed" | "shortcut";
  name: string | null; mimeType: string | null; version: string | null;
  content: { text: string; sha256: string } | null;
  permissions: PermissionEvidence[] | null;
  missingChecks: ("content" | "audience")[];
};
export type HandoffDecision = {
  status: "ready" | "held" | "incomplete" | "stale";
  reason: "approved" | "withdrawn" | "unresolved" | "missing" | "inaccessible" | "trashed" |
    "shortcut" | "audience" | "content" | "provider" | "changed";
  mailIds: string[];
  assetIds: string[];
  facts?: { fileId: string; quote: string }[];
};
export type HandoffReceipt = { path: string; sha256: string };
export type HandoffOutcome = { decision: HandoffDecision; handoff: HandoffReceipt | null };
