---
description: Reconcile an original user goal across Gmail decisions, current Drive assets, and an authorized workspace handoff.
budget: { maxTurns: 20 }
args:
  goal: string
returns: HandoffOutcome
---
1. Call chooseHandoffPlan with the user's request.
2. Call resolveMailDecision with the goal. If its decision calls for inspecting linked assets, use reviewLinkedAssets to observe them.
3. Call chooseHandoffDecision with the user goal and those observations. Call finishHandoff with the chosen outcome and the handoff plan. Return the actual result.
