---
description: Separate transient message readbacks from offline or history-first contact resolution.
args:
  input: GmailRead["readback"]
returns: GmailReview
---
For message, the wrong observed object is blocked / message-object-mismatch. Nontransient content, a body in metadata mode or an unsanitized included body in full mode is blocked / read-privacy-mismatch. Otherwise return ready / transient-message-read.
For contacts, suggest must avoid Google. Resolve should use local history whenever it found candidates. A violation is attention / contact-source-mismatch. Otherwise suggest gives ready / offline-contact-suggestions and resolve gives ready / contact-resolution-confirmed.
Cite the readback ID. If called for another kind, return blocked / unsupported-readback with its ID.
