---
description: Explain the next owner action from observed Workspace and Drive readiness.
args:
  goal: string
  readiness: GoogleReadiness
returns: GoogleWorkflowReport
---
Give the action that addresses the observed stage. Use open-setup when there is no client setup, connect when consent is missing, verify when connected but still unverified, add-drive-scope for an identity-verified account without Drive grants, and diagnose when verification failed. Ready maps to none. Return ready only with a ready observation. Use action-needed in other states. List no resource IDs and no checkpoint. Explain what was established in plain language, without requesting secrets. The owner setup panel handles consent and credential actions.
