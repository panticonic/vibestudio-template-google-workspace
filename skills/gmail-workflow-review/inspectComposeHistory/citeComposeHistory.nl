---
description: Cite the start and latest readback without duplicating one-event evidence.
args:
  events: ComposeHistoryReceipt["events"]
  decision: ComposeHistoryDecision
returns: string[]
---
Return the first and last native event IDs in order. If the first is also the last, return it once.
