---
description: Review actual direct Drive access against the caller's stated rules.
budget: { maxTurns: 24 }
args:
  request: GoogleSharingRequest
returns: GoogleWorkflowReport
---
Read permissions for request.fileId, starting with null in googleWorkspaceRead.readPermissions. Follow only the returned continuation tokens for the same file. Read retries and repeated observations are allowed. Call classifyAccess on all observed rows. Return the identified permission IDs. Findings describe the observed access and any incomplete coverage. Use partial for an unrecovered page failure or a continuation cycle in the current pagination chain. Use complete after the final observed page. Return action none and checkpoint null. Do not infer the membership of a group or inherited access from an unexplained permission entry.
