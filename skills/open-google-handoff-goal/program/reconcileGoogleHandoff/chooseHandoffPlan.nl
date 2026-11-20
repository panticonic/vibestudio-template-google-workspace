---
description: Determine what the user authorizes saving and when the handoff is useful.
args:
  goal: string
returns: HandoffPlan
---
Return none for a report-only request. Return ready for a handoff conditional on usable approval. Return decision when the user requests a durable record of a supported decision even when the outcome is to hold.
