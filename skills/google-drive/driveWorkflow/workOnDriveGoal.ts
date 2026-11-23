import {googleGoalDiscovery} from "natlang:services";
import chooseGoalRoute from "./workOnDriveGoal/chooseGoalRoute.nl";
import reviewFolderGoal from "./workOnDriveGoal/reviewFolderGoal.nl";
import guideGoogleWorkspace from "./guideGoogleWorkspace.nl";
import type {GoogleWorkflowReport} from "./types.js";
export default async function workOnDriveGoal(goal:string):Promise<GoogleWorkflowReport>{
 const plan=await chooseGoalRoute(goal,await googleGoalDiscovery.discover());
 if(!plan)return {status:"partial",action:"none",ids:[],findings:["The requested resource or review criteria need clarification."],checkpoint:null};
 return plan.kind==="folder"?reviewFolderGoal(plan):guideGoogleWorkspace(plan.request);
}
