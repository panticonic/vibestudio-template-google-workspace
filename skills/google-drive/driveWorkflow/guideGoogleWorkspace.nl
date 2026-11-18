---
description: Determine readiness and complete assigned read-only Google Workspace work.
budget: { maxTurns: 24 }
args:
  request: GoogleWorkflowRequest
returns: GoogleWorkflowReport
---
Read googleWorkspaceRead.readiness() first. For a setup-journey request, call reviewSetupJourney(request, readiness) and return its report, including the exact panel findings from that call. If it is not ready, call explainReadiness(request.goal, readiness) and return its result. For a setup request, call explainReadiness even when ready, so the response states the verified scope. Once ready, choose the skill that matches the request and return its actual report. Drive inventory uses inspectFolder, a direct sharing review uses reviewSharing, and change continuation uses continueSync.
