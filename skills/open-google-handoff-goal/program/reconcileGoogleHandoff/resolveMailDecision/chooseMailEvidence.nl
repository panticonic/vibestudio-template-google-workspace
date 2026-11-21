---
description: Find the exact controlling mail and select the set of linked assets the request needs.
args:
  goal: string
  threads: MailThread[]
returns: MailDecision
---
Make this decision entirely from `goal` and the observed `threads`. The caller owns mail, asset reads, and handoff. If `threads` lack the deciding evidence, return unresolved so the caller can handle it.

1. Find messages about the requested decision or deliverable. Determine the authority from the user's request and the original sender and message. A quoted or forwarded approval has the observed sender of that message. Distinguish original approval, conditions, replacement, revocation, and unrelated mail.
2. Resolve versions and timing across threads. Prefer the controlling decision for the requested scope. If approval was withdrawn or the evidence does not establish usable approval, return withdrawn or unresolved with the exact decisive message IDs and no asset requests.
3. Otherwise choose linked files explicitly covered by the approval and requested by the user. If a previous approval still governs an independent asset, keep the evidence for that asset. Use exact file IDs and source message IDs. Choose metadata when confirming a file exists and is current, content for inspecting bytes or text, audience for reviewing direct sharing, or content-and-audience when both are needed. Return approved with the exact supporting messages.
