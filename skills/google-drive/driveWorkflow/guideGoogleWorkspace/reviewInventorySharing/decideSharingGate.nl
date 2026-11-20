---
description: Decide whether the inventory can support a file-specific sharing review.
args:
  inventory: GoogleWorkflowReport
  fileId: string
returns: GoogleSharingGate
---
Return inventory-partial if the listing did not complete. For a complete listing, return audited only if inventory.ids contains the exact fileId. Otherwise return target-unconfirmed.
