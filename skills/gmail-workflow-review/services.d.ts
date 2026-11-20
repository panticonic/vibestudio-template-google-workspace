declare module "natlang:services" {
  export const gmailContinuationRead: {
    launchEvidence(): Promise<import("./types.js").GmailLaunchEvidence>;
  };
  export const gmailComposeAudit: {
    /** Project a compose review from the same owned channel receipt. */
    project(operationId: string, kind: import("./types.js").ComposeAuditKind): Promise<import("./types.js").GmailCompose>;
  };
  export const gmailComposeHistory: {
    /** Read the assigned compose card's bounded native channel history. */
    read(operationId: string): Promise<import("./types.js").ComposeHistoryReceipt>;
  };
}
