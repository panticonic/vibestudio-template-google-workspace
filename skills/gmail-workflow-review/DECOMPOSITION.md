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
