---
description: Interpret the effective compose state using the original and latest native observations.
args:
  events: ComposeHistoryReceipt["events"]
returns: ComposeHistoryDecision
---
1. Use the last effective state, including state carried by a failed update. If status is saving or discarding, return wait. If status is sending, delivery-unknown or sent, call checkDelivery with the state.
2. If status is discarded, return discarded. If the From alias is unknown, return hold.
3. Otherwise call checkDraft with the state, event kind, and the last non-null draft ID before this event. Return its result.
