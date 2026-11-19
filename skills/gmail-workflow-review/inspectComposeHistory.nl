---
description: Decide the next safe review step from the assigned Gmail compose card's actual channel history.
args:
  request: ComposeHistoryRequest
returns: ComposeHistoryReport
---
1. Read the assigned receipt with gmailComposeHistory.read. Call assessComposeState with the exact event sequence.
2. Call citeComposeHistory with that sequence and the assessment. Return the exact receipt, decision and ordered evidence IDs.
