---
description: Verify the assigned file in its folder before reviewing direct access.
uses: [guideGoogleWorkspace/inspectFolder, guideGoogleWorkspace/reviewSharing]
args:
  request: GoogleInventorySharingRequest
returns: GoogleWorkflowReport
---
1. Call inspectFolder with request.inventory and keep the exact selected IDs.
2. Call decideSharingGate with the inventory report and request.sharing.fileId.
3. For inventory-partial or target-unconfirmed, return status partial, action none, ids empty, checkpoint null, and a finding explaining the hold. Include inventoryAudit with the gate and the inventory's IDs.
4. For audited call reviewSharing with request.sharing unchanged. Return its report with inventoryAudit added. Preserve the selected inventory IDs and the audit gate.
