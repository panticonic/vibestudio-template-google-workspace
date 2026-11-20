---
description: Inspect, recover, and read back the saved draft without changing it.
budget: { maxTurns: 28 }
args:
  goal: string
  compose: RetainedCompose
returns: GmailGoalReport
---
1. If compose has a draftId, call gmailGoalProvider.getDraft on that ID. An unavailable provider read returns unavailable and preserves the existing record. Do not treat failure as evidence of absence.
2. If the attached draft is missing or there is no attached ID, call findOwnedDraft only when the goal asks to locate or recover the draft or the retained save is awaiting confirmation. For a request limited to the attached draft, return missing and null provider. For search, return its status with null provider if no exact result is selected. Otherwise read the selected draft, preserving a missing or unavailable outcome. Mark a successful continuation through this path as recovered.
3. Call assessDraftIdentity with the retained compose and actual draft. If provider MIME or thread identity differs, return stale with the observed provider record. A partial draft can be read back without a recipient.
4. Call gmailGoalProvider.verifyDraft with the observed draft ID and digest. If it returns a different digest, MIME, or thread, return stale with the latest actual provider record. If the second read is missing, report stale with null provider. If it is unavailable, report unavailable with null provider.
5. With stable readback, use incomplete when the provider recipient is absent. Otherwise return recovered if the draft was discovered by MIME lookup, or confirmed for the retained draft. Include compose.id, the retained event IDs, and the authoritative latest provider record.
