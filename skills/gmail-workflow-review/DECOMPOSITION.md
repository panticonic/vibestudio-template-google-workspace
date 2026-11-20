# Gmail workflow review

The Gmail worker's tools and channel receivers retain their own authorization and effects. This program reviews projected readbacks for one selected Gmail channel and mailbox. The projection uses opaque account, thread, compose and receipt references. It carries no credentials, message contents, contact addresses, or delivery data.

| Worker surface | Natural-language stages | Evidence |
| --- | --- | --- |
| Account and channel | Establish the channel and original account binding before calling any branch. | Selected channel and opaque mailbox reference, observed channel and account, native offer match. |
| Setup | Check the verified workspace audience and Gmail permissions. Then confirm the channel participant, renderer and first-run state. | Workspace verification flags and scoped channel installation receipt. |
| Search, read and contacts | Apply the read contract for the selected model, participant or contact lookup path. | Thread pagination projection, transient body flags, lookup source and channel card evidence. |
| Attention | Apply candidate prefiltering and classify queue, model fallback, or caller/confirmation evidence. | Inbox and related-sender flags, capped queue state, preference receipt and wake digest readback. |
| Compose | Confirm the owned card and apply the distinct drafting, authorization or reconciliation rule. | Draft/save lineage, alias check, user authority and canonical compose checks. |
| Sync | Interpret the matched mailbox's history or verified router state. | Caller and mailbox match flags, watch and polling state, baseline or incremental history result. |

The runtime supplies scoped evidence. Typed natural-language lambdas decide what it supports. The fixture verifier compares each status, finding and evidence citation to an independently authored expected result.

## Channel compose history

The caller assigns one channel, an exact compose message ID, its owner, and an ordered
bounded set of native envelopes. The binding checks the context, envelope identity,
sender and sequence, then folds the supplied compose state using the same shallow
update semantics as the renderer. It projects status and presence evidence without
forwarding subject, body or recipient addresses.

The Natlang workflow interprets the current card, distinguishes accepted draft
identity from interrupted delivery, and chooses the next review action. It can
explain a saved or sent status at that cursor. The supplied history contains
workspace card evidence; external Gmail reconciliation remains its own operation.

## Managed compose audit

The audit first calls the channel-history skill, then selects a draft or delivery
readback and calls the Gmail workflow review with that evidence. The channel
adapter builds the typed readback from the same persisted cursor and carries the
assigned channel coordinate into the scope. The audit reports both decisions and
their original evidence IDs. Delivery attempts require a separate provider check.

## Retained compose continuation

`planComposeContinuation` reads the launch control from the caller's completed
setup inspection and delegates the retained card to `auditComposeHistory`.
`decideContinuation` combines the observed gate and the audit and cites both
before returning a next action. The caller owns the browser readback and channel
scope. This workflow makes no provider calls.
