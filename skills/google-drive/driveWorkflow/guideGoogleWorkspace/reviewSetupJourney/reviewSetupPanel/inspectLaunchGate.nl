---
description: Verify the Gmail launch gate from the observed control and, when supplied, its previous state.
args:
  receipt: GoogleSetupReceipt
returns: GoogleSetupFinding
---
Copy the check and cite the receipt ID. If inheritedLaunch is known and differs from gmailEnabled, use gmail-inconsistent-after-reload. Otherwise use gmail-open for an enabled destination and gmail-closed for a disabled one.
