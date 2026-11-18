---
description: Verify ownership, compose identity and the configured send-as alias.
args:
  input: GmailCompose["card"]
returns: GmailReview | null
---
If the channel does not own the card or its message ID differs from the requested ID, return blocked / compose-card-mismatch. If the From alias is unknown, return blocked / unknown-send-as-alias. Cite the card ID. Otherwise return null.
