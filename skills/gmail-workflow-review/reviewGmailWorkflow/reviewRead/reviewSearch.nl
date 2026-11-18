---
description: Check Gmail thread pagination or silent cache-first participant search.
args:
  input: GmailRead["readback"]
returns: GmailReview
---
For search, compare requested versus observed query and page first. A mismatch is blocked / search-page-mismatch. A limit outside 1 to 50, too many threads, or card publication different from the mirror request is attention / search-contract-mismatch. A valid result with a next page is ready / search-has-next-page; otherwise ready / search-exhausted.
For participant-query, a positive cached match count requires the cache path; no matches requires the API path. A different source, search card publication, or more than 25 threads is attention / participant-query-contract. Otherwise return ready / silent-participant-query.
Cite the readback ID. If called for another kind, return blocked / unsupported-readback with its ID.
