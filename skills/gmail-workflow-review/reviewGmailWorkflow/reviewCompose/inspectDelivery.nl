---
description: Interpret canonical compose delivery readback without retrying.
args:
  input: GmailCompose
returns: GmailReview
---
For reconcile, a matched Sent receipt and resulting sent state give ready / sent-reconciled. A matched Sent receipt with an unupdated card is attention / stale-compose-projection. With no match or no check, return waiting / delivery-unproven. Cite the reconciliation receipt. Other kinds return blocked / unsupported-compose-readback with the readback ID.
