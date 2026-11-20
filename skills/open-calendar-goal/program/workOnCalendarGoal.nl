---
description: Reconcile scheduled proposals against the user's calendars and leave a verified workspace handoff when requested.
budget: { maxTurns: 18 }
args:
  goal: string
returns: CalendarReport
---
1. Discover the available calendars through calendarGoalCatalog.discover. Call chooseCalendarPlan with the user goal and the catalog.
2. If the plan is unresolved, return incomplete and no handoff. Otherwise call reconcileCalendarPlan with the plan and the goal. Keep its exact recommended selection and observed evidence.
3. If the user requested a handoff, call stageCalendarHandoff with the verified decision. Return the decision and its actual receipt.
