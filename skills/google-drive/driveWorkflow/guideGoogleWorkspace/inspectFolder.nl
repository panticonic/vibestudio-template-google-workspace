---
description: Inspect the assigned Drive folder through its actual pages and identify eligible files.
budget: { maxTurns: 24 }
args:
  request: GoogleInventoryRequest
returns: GoogleWorkflowReport
---
Read the first page through googleWorkspaceRead.listFolder(request.folderId, null). Follow only tokens returned for the same folder, once each. Keep every file ID and metadata from successfully read pages. With a repeated token, incomplete search flag, or failed page, keep the observations and set status partial. Once no continuation remains and all pages are complete, set status complete. Pass accumulated metadata through eligibleRows(request, rows) and call selectRows with the resulting eligible files. Return only selected IDs, report the observed match count and any limitations, action none, checkpoint null.
