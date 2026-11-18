---
description: Review the selected Gmail worker workflow using an attributable account and channel receipt.
args:
  request: GmailReviewRequest
returns: GmailReview
---
1. Call establishGmailScope with request.scope. Return any finding it provides.
2. Call reviewSetup, reviewRead, reviewAttention, reviewCompose, or reviewSync for the corresponding request kind.
3. Return the branch result unchanged. A result has one finding with its code and ordered evidence IDs. Review the supplied evidence only.
