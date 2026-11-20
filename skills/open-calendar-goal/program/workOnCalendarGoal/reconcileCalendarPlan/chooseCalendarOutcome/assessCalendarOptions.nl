---
description: Find the eligible proposal and resource records after reconciling latest provider revisions and overlap.
args:
  goal: string
  windows: CalendarWindow[]
returns: 'RecordAssessment[]'
---
1. Ignore older versions of the same calendar event ID when a later provider updated time is visible. A cancelled event is evidence that a previously blocked interval is no longer occupied.
2. Match proposals to the work requested by the user. Distinguish the current event windows from draft or unrelated proposals.
3. For each candidate check all required resource calendars. A blocking timed event overlaps only if it starts before the proposal ends and ends after the proposal starts. Use the normalized absolute bounds. Use the calendar's local day for all-day closures. Respect any explicit policy about tentative bookings.
4. Return the candidate records with exact relevant blockers or cancellations and mark incomplete when critical bounds or identities are unknown.
