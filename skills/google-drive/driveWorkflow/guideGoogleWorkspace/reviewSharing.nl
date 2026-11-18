---
description: Review actual direct Drive access against the caller's stated rules.
budget: { maxTurns: 24 }
args:
  request: GoogleSharingRequest
returns: GoogleWorkflowReport
---
Read permissions for request.fileId, starting with null in googleWorkspaceRead.readPermissions. Follow only the returned continuation tokens for the same file, once each. Call classifyAccess on all observed rows. Return the identified permission IDs. Findings describe the observed access and any incomplete coverage. Use partial if a page fails or repeats. Use complete after the final observed page. Return action none and checkpoint null. Do not infer the membership of a group or inherited access from an unexplained permission entry.
