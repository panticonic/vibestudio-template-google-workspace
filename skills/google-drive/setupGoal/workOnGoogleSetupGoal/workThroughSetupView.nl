---
description: Carry out only the reversible welcome-view work the goal calls for.
args:
  goal: string
  initial: SetupObservation
returns: SetupObservation
budget: { maxTurns: 18 }
---
Keep a current snapshot beginning with initial. Determine whether the user asks to change the visible scope, browser choice, width or reopen the view. Merely asking whether a workflow is ready does not authorize changing its scope control. Apply only the requested view operations, in the order implied by the user's goal. Call openGoogleSetup.apply with current.id and a typed action, then use its exact returned observation as current. Never open Google, start consent, alter account data, or follow the Gmail link. After a requested reload, especially where the user asks about persistence, keep the fresh result without restoring choices by default. If a permitted action returns null, observe again and use the current evidence. Return the actual current snapshot.
