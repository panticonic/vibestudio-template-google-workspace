import {openGoogleSetup} from "natlang:services";
import type {SetupDecision, SetupHandoff, SetupObservation} from "../types.js";
/** Save a requested next-step handoff in the currently observed owned setup. */
export default async function stageSetupHandoff(latest: SetupObservation, decision: SetupDecision):Promise<SetupHandoff | null>{
 return openGoogleSetup.stage(latest.id, decision);
}
