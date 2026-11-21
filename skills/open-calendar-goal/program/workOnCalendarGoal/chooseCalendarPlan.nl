---
description: Select authorized proposal and resource calendars and the requested examination window.
args:
  goal: string
  calendarSources: CalendarSource[]
returns: 'CalendarPlan | null'
---
1. Match the proposal calendar and each resource named in `goal` to the observed entries in `calendarSources`. Put the proposal ID in `proposals`, and put the resource IDs in `resources` in the order requested.
2. Resolve the requested date and interval using the timezone supplied by the goal or the applicable observed calendar. Return the absolute RFC 3339 bounds as `start` and `end`. Set `stage` when the user asks for a durable handoff.
3. Return the plan from these inputs, or return null if an identity or time bound remains unresolved. Your caller has already read the catalog and will use your plan to read events and stage any handoff. This call uses only `goal` and `calendarSources`.
