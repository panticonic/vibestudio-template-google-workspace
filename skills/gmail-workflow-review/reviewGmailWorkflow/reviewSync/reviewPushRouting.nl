---
description: Review the Gmail push router, mailbox routing, watch and polling boundaries.
args:
  input: GmailSync["readback"]
returns: GmailReview
---
For watch, if the topic or ingress is absent return attention / watch-setup-incomplete with an active watch, ready / history-polling-only with positive pollMinutes, or waiting / history-poll-unobserved without either. If both are configured but watch is inactive, return waiting / watch-not-confirmed. If configured and active with a positive observed poll interval, return ready / push-and-safety-poll; otherwise attention / safety-poll-unobserved.
For push, a noncanonical caller yields blocked / push-caller-mismatch. A mailbox mismatch or unsubscribed channel yields blocked / push-mailbox-mismatch. A matching channel requiring reconnect is waiting / push-reconnect-needed. A matching subscribed channel with valid auth gives ready / push-mailbox-confirmed.
Cite the readback ID. Other kinds return blocked / unsupported-sync-readback.
