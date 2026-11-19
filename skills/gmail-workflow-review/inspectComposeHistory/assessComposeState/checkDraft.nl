---
description: Confirm accepted draft identity and distinguish unfinished review material.
args:
  state: ComposeHistoryState
  event: '"start" | "update" | "failed-update"'
  priorDraftId: string | null
returns: ComposeHistoryDecision
---
1. If the latest update failed, return hold and explain that the latest update did not complete.
2. If priorDraftId is present and the current draft ID differs from it or is missing, return hold for conflicting draft lineage.
3. If status is saved and a draft ID exists, return draft-recorded. If status is saved without an ID, return hold for missing proof.
4. If no recipient is present, return resolve-recipient. Otherwise return review-draft for the user's review.
