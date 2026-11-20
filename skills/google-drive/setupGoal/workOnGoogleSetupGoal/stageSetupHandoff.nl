---
description: Save a requested next-step handoff in the currently observed owned setup.
args:
  latest: SetupObservation
  decision: SetupDecision
returns: 'SetupHandoff | null'
---
Call openGoogleSetup.stage with latest.id and the actual decision. Return its actual receipt without recreating it yourself.
