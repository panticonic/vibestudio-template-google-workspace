---
description: Verify the digest wake window, cap, and channel projection.
args:
  input: GmailAttention["readback"]
returns: GmailReview
---
For wake, if the oldest queued hit has waited less than 90000 ms return waiting / wake-debounce-open. If four turns already happened during the preceding hour, return waiting / wake-cap-keeps-queue. One summary chat message and one digest card with one to five rows and digestRows plus moreCount equal to queuedHitCount support ready / single-wake-digest; other shapes give attention / wake-card-mismatch. Cite the readback ID. Other kinds return blocked / unsupported-attention-readback.
