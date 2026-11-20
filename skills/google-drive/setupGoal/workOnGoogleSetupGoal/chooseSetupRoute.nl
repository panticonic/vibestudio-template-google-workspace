---
description: Choose a next operator route from current setup, exact permission coverage, and retained confirmation.
args:
  goal: string
  latest: SetupObservation
returns: SetupDecision
---
1. Resolve whether the user needs Gmail-only or broader Workspace coverage. Keep that requested scope independent of what the renderer currently displays.
2. Prefer the current checkpoint over historical state. Route a current revocation to recover-authorization. Route an account-only ownership question to account-owner and an audit of saved rules to permissions-owner, using only the corresponding visible owned route.
3. For other readiness questions, choose configure-desktop for missing configuration; review-consent for configured app details awaiting owned consent (including a declined attempt); verify-connection for an unverified connection or an unavailable current check; review-missing-permissions for verified coverage that does not include the requested workflow; verify-connection when the goal needs durability and the grant is session-only; workspace-ready for a verified full Workspace grant; gmail-ready for a sufficient Gmail grant with a live Gmail launch link.
4. Include the exact latest current.id and the relevant retained checkpoint IDs in their observed order. With no relevant history use an empty list. Copy the current launchEnabled exactly. Explain the decisive current and retained evidence and give a concise next step without entering details or acting on credentials.
