---
description: Review the actor and user authority attached to a compose without taking action.
args:
  input: GmailCompose
returns: GmailReview
---
For authorization, a participant cannot send. The two accepted actor and authority pairs are a Gmail agent with an explicit user instruction and a user Send click on the owned card. Anything else is blocked / send-authority-missing. An otherwise authorized attempt with card state sending or delivery-unknown is waiting / reconcile-first. An already sent card is ready / compose-already-sent. Other accepted evidence is ready / user-send-authority-recorded. Cite the authorization receipt. Other kinds return blocked / unsupported-compose-readback with the readback ID.
