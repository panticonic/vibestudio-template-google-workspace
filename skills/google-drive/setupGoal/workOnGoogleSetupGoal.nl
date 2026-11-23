---
description: Diagnose and stage the requested next step in an owned Google Workspace onboarding.
args:
  goal: string
returns: OpenGoogleSetupReport
budget: { maxTurns: 22 }
---
1. Call openGoogleSetup.observe. Keep the exact initial observation.
2. Call workThroughSetupView with the goal and initial observation. Keep its exact latest observation.
3. Call chooseSetupRoute with the goal and latest observation. Record its actual decision, including the exact current and relevant retained confirmation IDs. Set launchEnabled from the latest rendered Gmail link.
4. For an explicit request to leave or stage a handoff, call stageSetupHandoff for that exact latest observation and decision. For advice or inspection alone, leave handoff null.
5. Return the actual decision and handoff. The observed UI state and history remain internal to the onboarding hierarchy.
