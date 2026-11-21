---
description: Verify an already retained delivery receipt against Gmail without sending or retrying.
args:
  compose: RetainedCompose
returns: GmailGoalReport
---
If compose.sentId is null, return delivery-unconfirmed and null provider. Otherwise call gmailGoalProvider.readSent. Return delivery-confirmed only if the provider record has `messageId === compose.sentId`, `mimeId === compose.mimeId`, `threadId === compose.threadId`, and `sent === true`. Return unavailable for a failed provider read or delivery-unconfirmed when the receipt does not agree. Keep the retained event IDs and the actual provider record when observed.
