---
description: Apply Gmail incoming eligibility, prior reply and batched model conditions.
args:
  input: GmailAttention["readback"]
returns: GmailReview
---
For a candidate, apply these in order. Mail that is read or outside Inbox is ready / outside-triage-eligibility. A prior reply with the shortcut enabled is ready / known-sender-wake. When onboarding is incomplete and no prefs exist, return waiting / triage-onboarding-required. At 12 runs per hour return waiting / triage-hourly-cap. A batch greater than 25 is attention / triage-batch-overflow. A retryable model attempt gives waiting / triage-retry-pending. Exhausted model retries yield ready / fallback-prior-reply-wake for a prior-reply candidate and ready / fallback-surface-quiet otherwise. Other eligible candidates give ready / batched-triage-path. Cite the readback ID. Other kinds return blocked / unsupported-attention-readback.
