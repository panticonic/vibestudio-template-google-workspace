---
description: Discover available Drive resources and fulfill a user's inventory, direct access review, or change summary request.
budget: { maxTurns: 22 }
uses: [guideGoogleWorkspace]
args:
  goal: string
returns: GoogleWorkflowReport
---
1. Call googleGoalDiscovery.discover. Pass its current resource names and the user's goal to chooseGoalRoute. If it returns null, return a partial, read-only report explaining what needs clarification, with no IDs or checkpoint.
2. For a folder plan return reviewFolderGoal(plan). For a change plan return guideGoogleWorkspace(plan.request). The existing workflow verifies Drive readiness and delegates the change read. Preserve the child's coverage limits and observed identifiers.
