---
description: Check the observed setup preferences and guidance in both snapshots.
args:
  receipt: GoogleSetupReceipt
returns: GoogleSetupFinding
---
Copy the check and cite the receipt ID. Report setup-choice-inconsistent when the observations are missing or their guidance disagrees with the selected scope. For scope-choice report setup-scope-confirmed if the requested scope is active afterward and the browser choice was preserved. For browser-choice report setup-browser-confirmed if the requested browser is active afterward and the scope was preserved. For choice-reload report setup-defaults-restored if Gmail and My browser are selected afterward. Use setup-choice-inconsistent for any unsatisfied condition.
