---
description: Check that the provider draft belongs to the retained compose rather than a similarly titled draft.
args:
  compose: RetainedCompose
  draft: ProviderRecord
returns: boolean
---
Return true only when both the provider Message-ID and thread ID equal the corresponding retained compose identities.
