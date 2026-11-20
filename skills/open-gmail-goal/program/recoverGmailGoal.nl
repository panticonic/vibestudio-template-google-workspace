---
description: Recover and verify the user's retained Gmail draft or delivery receipt.
budget: { maxTurns: 18 }
args:
  goal: string
returns: GmailGoalReport
---
1. Discover available compose records through gmailGoalCatalog.discover. Call chooseCompose with the user's goal and the observed catalog. If the choice is unresolved, return ambiguous with null composeId, no evidence, and null provider.
2. Read the selected record through readRetainedCompose. Use verifyRetainedDelivery when the user asks whether a message was already delivered or the retained record is sent or delivery-unknown. For a draft inspection or recovery, including an explicit request to leave it unsent, use inspectDraftContinuity.
3. Return the actual result. Never treat the local compose record alone as a provider receipt.
