---
description: Review the scoped Gmail setup workflow.
args:
  input: GmailSetup
returns: GmailReview
---
1. Call qualifyWorkspace with input.workspace. Return its finding if present.
2. Return inspectChannelSetup(input.channel).
