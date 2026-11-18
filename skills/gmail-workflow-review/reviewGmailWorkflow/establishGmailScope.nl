---
description: Establish the selected channel and original Gmail mailbox binding.
args:
  scope: GmailScope
returns: GmailReview | null
---
A different channel yields blocked / gmail-channel-mismatch. A different mailbox yields blocked / gmail-account-mismatch. For a native tool receipt, a changed or absent original binding (native-mismatch) yields blocked / gmail-offer-mismatch. Check them in order and cite target then observed for any issue. The channel-readback path uses only the channel and mailbox checks. Otherwise return null.
