---
description: Reconcile scheduled proposals against the user's calendars and leave a verified workspace handoff when requested.
budget: { maxTurns: 18 }
args:
  goal: string
returns: CalendarReport
---
1. Get the Calendar catalog with `calendarGoalCatalog.discover()` and pass it with the original `goal` to `chooseCalendarPlan(goal, catalog)`. The planning call returns the source IDs and time bounds.
2. If the plan is null, return an incomplete decision and no handoff. Otherwise call `reconcileCalendarPlan(goal, plan)` to read the provider windows, consider changes, and verify a selected event. Keep its observed selection and evidence.
3. When the plan requests a handoff, use `stageCalendarHandoff` with the verified decision. Return the decision and the actual receipt, or no handoff if the decision could not be staged.
