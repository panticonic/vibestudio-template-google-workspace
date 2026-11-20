---
description: Continue the assigned Drive feed and commit a verified checkpoint to the owned workspace.
uses: [guideGoogleWorkspace/continueSync]
args:
  request: GoogleCheckpointRequest
returns: GoogleWorkflowReport
---
1. Call readCheckpoint once. Pass that exact cursor and request.goal to continueSync as a sync request.
2. If continuation is partial or its checkpoint is null, leave the saved cursor as read and return its IDs and findings with checkpointWrite state held and the saved cursor. Do not call commitCheckpoint.
3. If continuation completed with a checkpoint, call commitCheckpoint with the cursor you read and the exact terminal checkpoint. Preserve the continuation's IDs and findings. Return the receipt under checkpointWrite and the receipt's cursor as checkpoint. Use complete if the receipt is saved and partial otherwise.
