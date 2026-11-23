---
description: Review the setup panel receipts and preserve the original check order.
args:
  checks: GoogleSetupCheck[]
returns: GoogleSetupFinding[]
---
1. Call observeSetupPanel to get the real receipts in assigned order.
2. For each check, use its matching receipt. Call inspectOwnerRoutes for owners, inspectLaunchGate for launch-gate, inspectViewport for viewport, and inspectSetupChoices for scope-choice, browser-choice, and choice-reload.
3. Return those findings in the original check order with the evidence IDs from the receipts.
