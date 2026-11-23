---
description: Find the one retained Gmail draft matching the exact compose identity across the actual provider pages.
budget: { maxTurns: 16 }
args:
  compose: RetainedCompose
returns: DraftChoice
---
1. Call gmailGoalProvider.findDrafts using the observed compose identity and null for the first page. Follow returned opaque tokens to the end; stop a continuation cycle within the current pagination chain. Retrying or rereading an issued page is allowed.
2. An unavailable page or a repeated continuation leaves the search unavailable. Otherwise count distinct draft IDs across the completed result.
3. Select only a unique ID. Report missing with none and ambiguous with multiple. Return null ID for every unselected outcome.
