---
description: Check the shared Google Workspace Gmail prerequisites.
args:
  input: GmailSetup["workspace"]
returns: GmailReview | null
---
In order, a different audience is blocked / wrong-google-audience; an unverified workspace is waiting / google-verification-needed; missing identity, Gmail modify, or Gmail settings permission is waiting / gmail-permissions-incomplete; an unavailable Gmail API is waiting / gmail-api-unavailable. Cite the workspace receipt for any issue. Otherwise return null.
