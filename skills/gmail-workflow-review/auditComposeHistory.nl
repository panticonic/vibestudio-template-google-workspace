---
description: Audit the assigned Gmail compose card by joining persisted channel lineage with the Gmail workflow review.
args:
  request: ComposeHistoryRequest
returns: ComposeAuditReport
uses: [inspectComposeHistory, reviewGmailWorkflow]
---
1. Call inspectComposeHistory with request. Keep its exact report as history.
2. Select reconcile when the latest card state is sending, delivery-unknown or sent. Otherwise select draft.
3. Read the typed review input with gmailComposeAudit.project using request.operationId and the selected kind. Call reviewGmailWorkflow with that exact input.
4. Return history and the exact review result as review. This task is read-only.
