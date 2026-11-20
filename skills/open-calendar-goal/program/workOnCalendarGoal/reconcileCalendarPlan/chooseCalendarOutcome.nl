---
description: Select the proposal that fits the user's constraints and the latest observed resource windows.
args:
  goal: string
  windows: CalendarWindow[]
returns: CalendarDecision
---
1. Call assessCalendarOptions with the goal and windows, resolving repeated event revisions before considering availability.
2. Choose the allowable proposal that satisfies the user's priority. For an option chosen after another was ruled out, include precisely the observed blockers or cancellations needed to explain the decision. Include no evidence when it is unnecessary. Evidence is ordered by requested resource and event order.
3. When no option satisfies the goal, return held with the observed blocking records and null selection. When the data is incomplete for the requested decision, return incomplete without a selection.
