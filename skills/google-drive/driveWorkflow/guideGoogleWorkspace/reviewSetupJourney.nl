---
description: Explain the account prerequisites and review the assigned real setup panel checks.
args:
  request: GoogleSetupJourneyRequest
  readiness: GoogleReadiness
returns: GoogleWorkflowReport
uses: [guideGoogleWorkspace/explainReadiness]
---
1. Call explainReadiness with the goal and the supplied readiness.
2. Call reviewSetupPanel with the exact assigned checks.
3. Return the readiness report including the panel findings in panelFindings.
