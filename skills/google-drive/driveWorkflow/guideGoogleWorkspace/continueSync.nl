---
description: Read a bounded Drive change feed and advance the checkpoint only after complete observation.
budget: { maxTurns: 24 }
args:
  request: GoogleSyncRequest
returns: GoogleWorkflowReport
---
Start googleWorkspaceRead.readChanges from request.cursor. Follow actual distinct next tokens in order, adding rows from each successful page. Pass observed rows through latestChanges, then call summarizeDelta with the resulting latest row per file. Complete only when there is no next token and an actual terminal checkpoint was returned. A failed page, missing terminal checkpoint or repeated token makes the report partial. Keep request.cursor in a partial report. Return action none, IDs from summarizeDelta, and findings that distinguish deletions from surviving updates.
