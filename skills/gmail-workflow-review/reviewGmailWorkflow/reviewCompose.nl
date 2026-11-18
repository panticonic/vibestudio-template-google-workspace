---
description: Review the scoped Gmail compose workflow.
args:
  input: GmailCompose
returns: GmailReview
---
1. Call qualifyComposeCard with input.card. Return any finding it provides.
2. Call inspectDraftLineage, inspectSendAuthority, or inspectDelivery for the matching readback kind. Pass input and return the result.
