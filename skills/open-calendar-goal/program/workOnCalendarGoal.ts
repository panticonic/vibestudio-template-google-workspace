import {calendarGoalCatalog} from "natlang:services";
import chooseCalendarPlan from "./workOnCalendarGoal/chooseCalendarPlan.nl";
import reconcileCalendarPlan from "./workOnCalendarGoal/reconcileCalendarPlan.nl";
import stageCalendarHandoff from "./workOnCalendarGoal/stageCalendarHandoff.nl";
import type {CalendarReport} from "./types.js";
export default async function workOnCalendarGoal(goal:string):Promise<CalendarReport>{
 const plan=await chooseCalendarPlan(goal,await calendarGoalCatalog.discover());
 if(!plan)return {decision:{status:"incomplete",selection:null,evidence:[]},handoff:null};
 const decision=await reconcileCalendarPlan(goal,plan);
 return {decision,handoff:plan.stage?await stageCalendarHandoff(decision):null};
}
