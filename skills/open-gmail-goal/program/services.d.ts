declare module "natlang:services" {
  export const gmailGoalCatalog: { discover(): Promise<import("./types.js").ComposeSelection[]> };
  export const gmailGoalCompose: { read(id: string): Promise<import("./types.js").RetainedCompose> };
  export const gmailGoalProvider: {
    getDraft(composeId: string, draftId: string): Promise<import("./types.js").ReadResult>;
    findDrafts(composeId: string, cursor: string | null): Promise<import("./types.js").SearchResult>;
    verifyDraft(composeId: string, draftId: string, digest: string): Promise<import("./types.js").ReadResult>;
    readSent(composeId: string): Promise<import("./types.js").ReadResult>;
  };
}
