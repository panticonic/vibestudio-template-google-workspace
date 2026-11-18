---
description: Check whether sync established a history baseline, advanced it, or should back off.
args:
  input: GmailSync["readback"]
returns: GmailReview
---
For history, if rate limited, observed backoff is waiting / gmail-rate-backoff and missing backoff is attention / gmail-backoff-missing. Otherwise an unchanged cursor is waiting / history-cursor-unproven. A baseline with a new cursor and no claimed thread updates is ready / history-baseline-established; a baseline claiming thread updates is attention / baseline-incremental-confusion. An incrementally advanced cursor is ready / history-increment-confirmed. Cite the readback ID. Other kinds return blocked / unsupported-sync-readback.
