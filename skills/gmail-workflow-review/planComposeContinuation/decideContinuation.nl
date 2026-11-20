---
description: Determine the next read-only handoff from the launch control and persisted compose audit.
args:
  gate: GmailLaunchEvidence
  audit: ComposeAuditReport
returns: ComposeContinuationDecision
---
1. Set launch to available when gate.enabled is true and held otherwise.
2. When the history decision is draft-recorded and the review is ready, choose preserve-draft. When the history decision is reconcile-delivery and the review is waiting, choose reconcile-before-retry. Otherwise choose review-before-action.
3. Cite gate.evidenceId and the final compose event ID in that order. The recommendation itself neither launches Gmail nor writes to it.
