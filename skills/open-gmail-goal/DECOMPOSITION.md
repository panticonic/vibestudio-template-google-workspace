# Open Gmail draft goals

The goal names retained work to inspect. The workflow discovers authorized
compose records, then uses the observed Gmail identity to inspect the provider
side of the draft. User goals may ask for a recovery decision, for revalidation
of a provider revision, or for verification of an already retained delivery
receipt.

| Responsibility | Implementation |
| --- | --- |
| Identify the relevant compose | `chooseCompose` interprets the goal and observed catalog. Ambiguous title matches are held. |
| Read exact retained state | The existing Gmail compose history binding verifies PubSub ownership and ordered envelopes. The caller supplies provider coordinates only from those verified events. |
| Select current, saved or recovered draft | `inspectDraftContinuity` and its delegated search and assessment lambdas decide which authorized reads the goal needs. |
| Read a provider revision | The installed Gmail client follows registered provider IDs and a bounded exact Message-ID query. A second provider read detects a stale draft without writing it. |
| Verify a retained delivery receipt | A read-only lambda checks the persisted provider message, MIME identity, thread and Sent label. Missing evidence leaves delivery unconfirmed. |
| Qualify and independently judge outcomes | The owned provider transport keeps exact accepted requests and response revisions. The managed verifier independently reopens the native compose envelopes and inspects the provider state. |

The model receives the original goal and actual observed state. It receives no
expected outcomes or preselected operations. The fixture transport implements
the Gmail reads used by the real API client and declines every write.
