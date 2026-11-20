---
description: Observe the requested Drive assets against the user's requested kinds of evidence.
args:
  requested: AssetIntent[]
returns: AssetEvidence[]
---
Call checkLinkedAsset for each requested asset, preserving its observed identity. Return every observation, including unavailable results.
