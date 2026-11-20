---
description: Select authorized proposal and resource calendars and the requested examination window.
args:
  goal: string
  calendarSources: CalendarSource[]
returns: 'CalendarPlan | null'
---
Identify the proposal calendar, then each required resource calendar in request order. Use exact observed calendar identities. Interpret the requested date and time range and return absolute RFC 3339 bounds. Set stage only when the user asks for a durable handoff. If the scope, date or required resources cannot be resolved, return null.
