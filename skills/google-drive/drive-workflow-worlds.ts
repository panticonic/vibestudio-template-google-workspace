import type {
  DriveChangeList,
  DriveFileList,
  DrivePermissionList,
} from "@workspace/google-workspace";
import type {
  GoogleReadiness,
  GoogleWorkflowRequest,
  GoogleWorkflowReport,
} from "./driveWorkflow/types.js";
import type { GoogleWorkspaceAssignment } from "./drive-workflow-binding.js";

type Expectation = Omit<GoogleWorkflowReport, "findings">;
export type GoogleWorkflowWorld = {
  id: string;
  group: string;
  state: GoogleReadiness["state"];
  request: GoogleWorkflowRequest;
  assignment: GoogleWorkspaceAssignment;
  pages: (DriveFileList | DrivePermissionList | DriveChangeList | null)[];
  expected: Expectation;
};

function report(
  status: Expectation["status"],
  ids: string[] = [],
  checkpoint: string | null = null,
): Expectation {
  return { status, ids, checkpoint, action: "none" };
}
const sheet = "application/vnd.google-apps.spreadsheet";
const pdf = "application/pdf";
const shortcut = "application/vnd.google-apps.shortcut";
const folder = "application/vnd.google-apps.folder";

export const googleWorkflowWorlds = [
  {
    id: "inventory-quarterly-sheets",
    group: "file-inventory",
    state: "ready",
    request: {
      kind: "inventory",
      goal: "Find the quarterly budget spreadsheets updated from April onward for the controller handoff.",
      folderId: "budget",
      media: [sheet],
      modifiedSince: "2025-04-01T00:00:00Z",
    },
    assignment: { folder: { id: "budget", driveId: "finance" } },
    pages: [
      {
        nextPageToken: "budget-tail",
        files: [
          {
            id: "budget-q1",
            name: "Quarterly budget Q1",
            mimeType: sheet,
            modifiedTime: "2025-03-31T23:59:59Z",
          },
          {
            id: "budget-q2",
            name: "Quarterly budget Q2",
            mimeType: sheet,
            modifiedTime: "2025-04-01T00:00:00Z",
          },
        ],
      },
      {
        files: [
          {
            id: "budget-fake",
            name: "Quarterly budget Q2",
            mimeType: shortcut,
          },
          {
            id: "budget-q3",
            name: "Quarterly budget Q3",
            mimeType: sheet,
            modifiedTime: "2025-07-01T00:00:00Z",
          },
        ],
      },
    ],
    expected: report("complete", ["budget-q2", "budget-q3"]),
  },
  {
    id: "inventory-warehouse-checklists",
    group: "file-inventory",
    state: "ready",
    request: {
      kind: "inventory",
      goal: "Find the warehouse safety checklists as PDFs, including on a partially observed inventory. Exclude training slides and folders.",
      folderId: "warehouse",
      media: [pdf],
      modifiedSince: null,
    },
    assignment: { folder: { id: "warehouse" } },
    pages: [
      {
        incompleteSearch: true,
        files: [
          {
            id: "loading-safety",
            name: "Loading dock safety checklist",
            mimeType: pdf,
          },
          {
            id: "safety-templates",
            name: "Safety checklists",
            mimeType: folder,
          },
          { id: "lunch-policy", name: "Lunch break policy", mimeType: pdf },
        ],
      },
    ],
    expected: report("partial", ["loading-safety"]),
  },
  {
    id: "inventory-exhibition-labels",
    group: "file-inventory",
    state: "ready",
    request: {
      kind: "inventory",
      goal: "Find published exhibition label PDFs, excluding the label shortcut. Mark an incomplete inventory explicitly.",
      folderId: "exhibition",
      media: [pdf],
      modifiedSince: null,
    },
    assignment: { folder: { id: "exhibition" } },
    pages: [
      {
        nextPageToken: "exhibit-tail",
        files: [
          {
            id: "north-label",
            name: "North Gallery published wall label",
            mimeType: pdf,
          },
          {
            id: "label-shortcut",
            name: "Published wall label",
            mimeType: shortcut,
          },
        ],
      },
      null,
    ],
    expected: report("partial", ["north-label"]),
  },
  {
    id: "sharing-board-packet",
    group: "direct-sharing",
    state: "ready",
    request: {
      kind: "sharing",
      goal: "Flag public and external access to the board packet. Internal editors are allowed.",
      fileId: "board-packet",
      allowedDomains: ["example.org"],
      allowWriters: true,
    },
    assignment: { sharingFileId: "board-packet" },
    pages: [
      {
        nextPageToken: "packet-tail",
        permissions: [
          { id: "public-link", type: "anyone", role: "reader" },
          {
            id: "internal-owner",
            type: "user",
            role: "owner",
            emailAddress: "secretary@example.org",
          },
        ],
      },
      {
        permissions: [
          {
            id: "outside-consultant",
            type: "user",
            role: "reader",
            emailAddress: "consultant@vendor.example",
          },
          {
            id: "internal-editors",
            type: "group",
            role: "writer",
            emailAddress: "board@example.org",
          },
        ],
      },
    ],
    expected: report("complete", ["public-link", "outside-consultant"]),
  },
  {
    id: "sharing-research-readers",
    group: "direct-sharing",
    state: "ready",
    request: {
      kind: "sharing",
      goal: "Check a research folder that allows employees to read and comment, with editing reserved for its owner.",
      fileId: "research",
      allowedDomains: ["example.org"],
      allowWriters: false,
    },
    assignment: { sharingFileId: "research" },
    pages: [
      {
        permissions: [
          {
            id: "owner",
            type: "user",
            role: "owner",
            emailAddress: "owner@example.org",
          },
          {
            id: "comment",
            type: "user",
            role: "commenter",
            emailAddress: "reviewer@EXAMPLE.ORG",
          },
          {
            id: "editing-group",
            type: "group",
            role: "writer",
            emailAddress: "research@example.org",
          },
          {
            id: "suffix-decoy",
            type: "domain",
            role: "reader",
            domain: "notexample.org",
          },
          {
            id: "deleted-old-editor",
            type: "user",
            role: "writer",
            emailAddress: "old@vendor.example",
            deleted: true,
          },
        ],
      },
    ],
    expected: report("complete", ["editing-group", "suffix-decoy"]),
  },
  {
    id: "sharing-unknown-direct-principal",
    group: "direct-sharing",
    state: "ready",
    request: {
      kind: "sharing",
      goal: "Review the archive's direct access and flag permissions whose audience cannot be established.",
      fileId: "archive",
      allowedDomains: ["example.org"],
      allowWriters: true,
    },
    assignment: { sharingFileId: "archive" },
    pages: [
      {
        permissions: [
          { id: "unknown-reader", type: "user", role: "reader" },
          {
            id: "internal-domain",
            type: "domain",
            role: "reader",
            domain: "example.org",
          },
        ],
      },
    ],
    expected: report("complete", ["unknown-reader"]),
  },
  {
    id: "sync-resolved-moves",
    group: "change-feed",
    state: "ready",
    request: {
      kind: "sync",
      goal: "Continue the archive's change checkpoint and explain current state after duplicate changes and removals.",
      cursor: "archive-base",
    },
    assignment: {
      changes: { initialCursor: "archive-base", driveId: "archive-drive" },
    },
    pages: [
      {
        nextPageToken: "archive-cont",
        changes: [
          {
            id: "delta-a",
            fileId: "manual",
            file: { id: "manual", name: "Training manual" },
          },
          { id: "delta-b", fileId: "old-faq", removed: true },
        ],
      },
      {
        newStartPageToken: "archive-next",
        changes: [
          { id: "delta-c", fileId: "manual", removed: true },
          {
            id: "delta-d",
            fileId: "faq",
            file: { id: "faq", name: "Revised FAQ" },
          },
        ],
      },
    ],
    expected: report("complete", ["manual", "old-faq", "faq"], "archive-next"),
  },
  {
    id: "sync-due-to-unavailable-page",
    group: "change-feed",
    state: "ready",
    request: {
      kind: "sync",
      goal: "Continue the handover feed, retaining the original checkpoint if the continuation is unavailable.",
      cursor: "handover-base",
    },
    assignment: { changes: { initialCursor: "handover-base" } },
    pages: [
      {
        nextPageToken: "handover-tail",
        changes: [
          {
            id: "delta-1",
            fileId: "handover",
            file: { id: "handover", name: "New handover" },
          },
        ],
      },
      null,
    ],
    expected: report("partial", ["handover"], "handover-base"),
  },
  {
    id: "sync-empty-page-with-checkpoint",
    group: "change-feed",
    state: "ready",
    request: {
      kind: "sync",
      goal: "Check whether the schedule feed has updates, and move the checkpoint if the read completed.",
      cursor: "schedule-previous",
    },
    assignment: { changes: { initialCursor: "schedule-previous" } },
    pages: [{ changes: [], newStartPageToken: "schedule-current" }],
    expected: report("complete", [], "schedule-current"),
  },
  {
    id: "setup-desktop-client-missing",
    group: "connection-readiness",
    state: "needs-setup",
    request: {
      kind: "setup",
      goal: "Help me connect this workspace so I can later inspect Drive. I have not configured a Desktop OAuth client.",
    },
    assignment: {},
    pages: [],
    expected: { ...report("action-needed"), action: "open-setup" },
  },
  {
    id: "setup-account-verified-drive-unavailable",
    group: "connection-readiness",
    state: "needs-drive-scope",
    request: {
      kind: "inventory",
      goal: "I just verified Google identity. Find the signed invoices once the account has the Drive grant.",
      folderId: "signed-invoices",
      media: [pdf],
      modifiedSince: null,
    },
    assignment: { folder: { id: "signed-invoices" } },
    pages: [],
    expected: { ...report("action-needed"), action: "add-drive-scope" },
  },
  {
    id: "setup-drive-verification-failed",
    group: "connection-readiness",
    state: "verification-failed",
    request: {
      kind: "sharing",
      goal: "Review the direct audience of the QA materials once Drive has been verified.",
      fileId: "qa",
      allowedDomains: ["example.org"],
      allowWriters: false,
    },
    assignment: { sharingFileId: "qa" },
    pages: [],
    expected: { ...report("action-needed"), action: "diagnose" },
  },
] satisfies GoogleWorkflowWorld[];

export function verifyGoogleWorkflowOutcome(
  world: GoogleWorkflowWorld,
  observed: GoogleWorkflowReport,
): boolean {
  return (
    observed.status === world.expected.status &&
    observed.action === world.expected.action &&
    observed.checkpoint === world.expected.checkpoint &&
    observed.ids.length === world.expected.ids.length &&
    world.expected.ids.every((id, index) => observed.ids[index] === id) &&
    observed.findings.some((item) => item.trim().length > 0)
  );
}
