import type {
  SetupAction,
  SetupDecision,
  SetupHandoff,
  SetupObservation,
} from "./types.js";
declare module "natlang:services" {
  export const openGoogleSetup: {
    observe(): Promise<SetupObservation>;
    apply(
      revision: string,
      action: SetupAction,
    ): Promise<SetupObservation | null>;
    stage(
      revision: string,
      decision: SetupDecision,
    ): Promise<SetupHandoff | null>;
  };
}
