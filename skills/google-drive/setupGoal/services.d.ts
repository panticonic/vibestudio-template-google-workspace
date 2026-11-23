declare module "natlang:services" {
  export const openGoogleSetup: {
    observe(): Promise<import("./types.js").SetupObservation>;
    apply(
      revision: string,
      action: import("./types.js").SetupAction,
    ): Promise<import("./types.js").SetupObservation | null>;
    stage(
      revision: string,
      decision: import("./types.js").SetupDecision,
    ): Promise<import("./types.js").SetupHandoff | null>;
  };
}
