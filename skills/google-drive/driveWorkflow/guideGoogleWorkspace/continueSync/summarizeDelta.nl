---
description: Summarize final per-file changes without treating an earlier version as current.
args:
  changes: GoogleChange[]
returns: { ids: string[]; findings: string[] }
---
Each input row is the final observation for one file ID. A removed row indicates removal even without metadata. Return source IDs in input order and a finding per ID stating whether the last change was a removal or an update. Preserve IDs verbatim.
