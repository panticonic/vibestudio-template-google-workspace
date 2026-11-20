---
description: Open or refresh the exact bounded provider windows needed to reconcile a scheduling goal.
args:
  plan: CalendarPlan
  prior: CalendarWindow[]
returns: CalendarWindow[]
---
For an empty prior list, open the proposal calendar and each resource calendar in plan order with the exact time range. For a supplied prior list, refresh those window IDs in order. Return the complete list of observations, including unavailable windows.
