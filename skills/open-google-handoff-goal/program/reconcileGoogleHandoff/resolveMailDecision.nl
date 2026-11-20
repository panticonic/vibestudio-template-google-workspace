---
description: Resolve approval, withdrawal, or uncertainty across the matching Gmail conversation.
args:
  goal: string
returns: MailDecision
---
Call readMailThreads. If the observations are incomplete, return incomplete without approving any asset. Otherwise call chooseMailEvidence with the goal and the observed conversations. Keep actual message and asset identities.
