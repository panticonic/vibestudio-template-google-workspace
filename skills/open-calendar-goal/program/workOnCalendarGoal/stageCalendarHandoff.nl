---
description: Save the current scheduling decision to an authorized workspace handoff.
args:
  decision: CalendarDecision
returns: 'CalendarHandoff | null'
---
Stage selected decisions with the verified provider event. Stage a held decision when its observed blockers substantiate it. For incomplete or stale evidence return null. Call calendarGoalHandoff.stage with the exact decision and return its actual readback receipt.
