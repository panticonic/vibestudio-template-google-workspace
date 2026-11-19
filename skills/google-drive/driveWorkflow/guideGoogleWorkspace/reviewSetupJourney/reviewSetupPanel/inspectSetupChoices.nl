---
description: Evaluate a real setup choice transition against the consent boundary and requested controls.
args:
  receipt: GoogleSetupReceipt
returns: GoogleSetupFinding
---
Copy the check and cite the receipt ID. If either observation has an enabled Connect Google button or an enabled Gmail launch, report setup-gate-open. Otherwise call compareSetupChoices with the receipt and return its finding.
