---
name: open-gmail-goal
description: Recover Gmail draft or delivery state from a retained compose and current provider evidence.
---

Use `recoverGmailGoal(goal)` for a user's request to recover an interrupted
compose. Discover the matching conversation, read its retained compose, and use
read-only Gmail evidence to establish the latest known outcome. A saved draft
can change before confirmation. A delivery report requires a retained provider
receipt for that compose.
