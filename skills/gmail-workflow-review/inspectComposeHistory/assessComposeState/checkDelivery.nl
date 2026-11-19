---
description: Determine when an unresolved delivery must be reconciled.
args:
  state: ComposeHistoryState
returns: ComposeHistoryDecision
---
If status is sent and sentIdentity is true, return delivery-recorded, explaining the card recorded a sent identity. Otherwise return reconcile-delivery and explain whether a stable MIME identity is available to check. A card awaiting reconciliation does not authorize a retry.
