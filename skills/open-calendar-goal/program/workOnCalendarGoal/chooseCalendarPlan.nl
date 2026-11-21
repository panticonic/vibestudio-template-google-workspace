---
description: Identify which calendar IDs and time interval a later event search should read.
args:
  goal: string
  calendarSources: CalendarSource[]
returns: 'CalendarPlan | null'
---
Your output tells the next function what to read. The scheduling decision follows that read. The catalog and the goal are sufficient to produce a plan whenever they identify the sources and time bounds.

1. Match the proposal calendar and each resource named in `goal` to the observed entries in `calendarSources`. Put the proposal ID in `proposals` and the resource IDs in `resources`.
2. Resolve the requested date and interval using the timezone supplied by the goal or the applicable observed calendar. Return the absolute RFC 3339 bounds as `start` and `end`. Set `stage` when the user asks for a durable handoff.
3. Return the plan once the calendar IDs and time bounds are resolved. Return null when a required ID or time bound remains unresolved.
