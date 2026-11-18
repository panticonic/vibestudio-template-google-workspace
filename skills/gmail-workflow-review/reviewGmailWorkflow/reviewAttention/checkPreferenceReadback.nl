---
description: Review the attention preference caller and scope of its dry run.
args:
  input: GmailAttention["readback"]
returns: GmailReview
---
For preferences, a write by another worker is blocked / preference-write-denied. A whole mailbox dry run claim is attention / dry-run-scope-overclaim. A write without a saved receipt is waiting / preferences-not-confirmed. Otherwise return ready / scoped-preferences-readback. Cite the readback ID. Other kinds return blocked / unsupported-attention-readback.
