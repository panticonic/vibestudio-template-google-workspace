---
description: Confirm the targeted channel participant and first-run readback.
args:
  input: GmailSetup["channel"]
returns: GmailReview
---
A workspace registration does not establish channel membership. If the participant is not subscribed, return waiting / gmail-channel-unsubscribed. If the participant is subscribed but the action bar or renderers are missing, return attention / channel-ui-incomplete. If channel setup is incomplete, return waiting / gmail-attention-onboarding. Otherwise return ready / gmail-channel-ready. Cite the channel receipt.
