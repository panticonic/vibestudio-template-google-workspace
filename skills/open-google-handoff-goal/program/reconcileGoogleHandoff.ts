import chooseHandoffPlan from "./reconcileGoogleHandoff/chooseHandoffPlan.nl";
import resolveMailDecision from "./reconcileGoogleHandoff/resolveMailDecision.nl";
import reviewLinkedAssets from "./reconcileGoogleHandoff/reviewLinkedAssets.js";
import chooseHandoffDecision from "./reconcileGoogleHandoff/chooseHandoffDecision.nl";
import finishHandoff from "./reconcileGoogleHandoff/finishHandoff.nl";
import type {HandoffOutcome} from "./types.js";
export default async function reconcileGoogleHandoff(goal:string):Promise<HandoffOutcome>{
 const plan=await chooseHandoffPlan(goal),mail=await resolveMailDecision(goal);
 const assets=await reviewLinkedAssets(mail.requested);
 return finishHandoff(plan,await chooseHandoffDecision(goal,mail,assets));
}
