---
description: Find documents relevant to a user goal and review the direct access of an unambiguous current file when requested.
uses: [guideGoogleWorkspace]
args:
  plan: DriveFolderGoalPlan
returns: GoogleWorkflowReport
---
1. Call guideGoogleWorkspace with plan.inventory. Return its actual result if it needs a connection action or if the user only requested an inventory.
2. For an audit, use inventory-partial if the inventory is partial, or target-unconfirmed if the complete inventory does not identify exactly one file. Return a partial report with empty permission IDs, null checkpoint, action none, and inventoryAudit containing the gate and actual selected inventory IDs.
3. For a complete inventory with one identified file, call guideGoogleWorkspace with a sharing request carrying its exact ID, the user's goal, and the policy in plan.audit. Return its actual read-only result with inventoryAudit containing gate audited and the exact inventory IDs.
