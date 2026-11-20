---
description: Read current calendar evidence, reconsider changed records, and independently verify the selected provider event.
budget: { maxTurns: 28 }
uses: [workOnCalendarGoal/readCalendarWindows]
args:
  goal: string
  plan: CalendarPlan
returns: CalendarDecision
---
1. Read initial calendar windows with readCalendarWindows. If any are unavailable, return incomplete, null selection and no evidence.
2. Call chooseCalendarOutcome on the initial observations. When plan.stage is true, refresh the same windows through readCalendarWindows to cover changes before the handoff. If any refresh is unavailable, return incomplete. Otherwise call chooseCalendarOutcome again and use this fresh result instead of the initial one.
3. If the fresh decision has a selection, call calendarGoalReadback.verify on that exact observed event. For current, return the decision unchanged. For changed or missing, return stale with null selection. Keep the actual changed event alone as evidence when present. For unavailable, return incomplete without a selection. If there is no selection to verify, return the observed decision.
