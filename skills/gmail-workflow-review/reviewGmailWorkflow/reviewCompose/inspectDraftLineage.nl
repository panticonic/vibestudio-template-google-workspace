---
description: Review participant drafting, recipient completeness and retained draft ID.
args:
  input: GmailCompose
returns: GmailReview
---
For draft, a participant-origin card in review is ready / participant-draft-review citing the card. Otherwise, a recipient-less card still drafting is waiting / draft-needs-recipient citing the card. If saving replaced or lost an existing draft ID, return attention / saved-draft-lineage-mismatch with the readback ID. If existing ID was retained, return ready / saved-draft-updated with the readback ID. For other complete reads return ready / compose-readback with the card ID. Other kinds return blocked / unsupported-compose-readback with the readback ID.
