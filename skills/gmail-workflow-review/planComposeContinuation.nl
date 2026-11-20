---
description: Decide how to resume one retained Gmail compose card after the assigned setup review.
args:
  request: ComposeHistoryRequest
returns: ComposeContinuationReport
uses: [auditComposeHistory]
---
1. Read gmailContinuationRead.launchEvidence. It is the observed Gmail launch control after the setup check.
2. Call auditComposeHistory with request. Keep the full audit.
3. Call decideContinuation with the launch evidence and audit. Return the audit and the continuation it produced.
