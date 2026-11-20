---
description: Decide whether the inventory can support a file-specific sharing review.
args:
  status: GoogleWorkflowStatus
  selectedIds: string[]
  fileId: string
returns: GoogleSharingGate
---
Return inventory-partial unless status is complete. For a complete listing, return audited only if selectedIds contains the exact fileId. Otherwise return target-unconfirmed.
