declare module "natlang:services" {
  export const googleHandoffMail: {
    discover(): Promise<{ ids: string[]; complete: boolean }>;
    read(id: string): Promise<import("./types.js").MailThread | null>;
  };
  export const googleHandoffDrive: {
    inspect(asset: import("./types.js").AssetIntent): Promise<import("./types.js").AssetEvidence>;
  };
  export const googleHandoffFreshness: {
    verify(decision: import("./types.js").HandoffDecision): Promise<"current" | "changed" | "unavailable">;
  };
  export const googleHandoffScratch: {
    stage(decision: import("./types.js").HandoffDecision): Promise<import("./types.js").HandoffReceipt>;
  };
}
