# Website authority and escalation

The same authority machinery serves installed code and browser documents.
Website identity changes admission and available grant subjects; it does not
create another RPC or approval stack. See [website development](../../workspace-dev/WEBSITES.md)
for connection code and the current implementation limits.

## Three independent decisions

| Boundary | Meaning |
| --- | --- |
| Workspace connection | Separate explicit user approval allowing this authenticated document to participate at all. Disconnected calls fail before discovery or acquisition. |
| Method eligibility | The receiver explicitly declares `website: { kind: "eligible", rationale }` or `{ kind: "closed", reason }`. Closed methods cannot be unlocked by a grant. |
| Operation authority | The ordinary receiver tier, principals, resource, relationship, integrity and disclosure rules determine whether the eligible call needs a grant or fresh decision. |

`open`, `gated`, and `critical` describe operation authority. They do not replace
the connection gate or website eligibility. An operation open to installed
workspace code can still have a website-specific protected resource requirement.
Eligibility alone grants nothing. Critical effects retain their fresh-operation
ceiling. Cross-workspace exposure and both workspaces' boundary policies are
additional independent requirements.

“Acquire” means the real operation enters normal acquisition when it lacks an
eligible grant. Do not add approval to let a caller ask for another resource
approval. The one intentional separate prerequisite is workspace connection.
Never implicitly connect while discovering or attempting a protected operation.

## Authenticated subjects and duration

The host binds a website subject to the authenticated user, workspace, and
canonical HTTP(S) origin. Each live document has fresh execution evidence and
a revocation generation. Pages cannot supply or override these facts.

Saved website permissions bind to that durable subject, plus the recorded
constraints. Page-scoped permission ends with that document/connection.
Remembered permission can apply to future explicitly connected documents from
the same origin in the same user/workspace scope. A different site never inherits
authority merely by occupying the same panel. Invalidated generations, withdrawn
connection grants, lost membership, and retired document evidence cannot be
repaired by replaying saved handles.

An origin includes scheme, host, and port, not repository path. For example,
`https://owner.github.io/project-a/` and `/project-b/` share a subject boundary.
A path is not an independent security identity. Use separate origins where
independent trust is required. HTTP pages also need disclosure that network
intermediaries can change the code receiving workspace data.

Continuing website access includes mutable future site code. Do not invent a
reviewed version from a URL, ETag, title, or panel ID. Installed code may have
exact execution-digest evidence; preserve per-version choices where sensible,
particularly model-provider credential use. Receiver policy chooses the
recommendation from enforceable offered choices. Session, expiry, requester
version, and provider-build bounds can coexist; display all of them truthfully.
General installed mutable-identity migration is not yet complete.

## Review the effect and result audience

A browser-panel approval must visibly identify the authenticated origin and
website provenance even when an installed receiver performs the operation.
Use trusted workspace chrome for consent and subtle browser/connected-browser
background hues with accessible trust descriptions;
a website-rendered badge, title, favicon, or prompt is not evidence of trust.
The approval explains the resource, effect, result disclosure, and offered
lifetime. Detailed identity evidence may include the source workspace,
initiating document, and reviewed receiver/requester version when available.

Connecting a website is a trust decision about mutable website code. A reviewed
receiver performs an approved operation under its normal implementation authority.
Website attribution helps review and audit; it is not a permanent ownership or
security label on conversations, data, agent turns, queues, or downstream effects.
Transparent forwarding must not bypass the website's entry restrictions, but the
system does not promise to confine a trusted receiver's entire implementation to
website grants.

Conversations initiated by websites are ordinary conversations in the connected
workspace. Transcripts, tool logs, sharing and retention follow that workspace's
normal rules. A private live RPC reply does not establish private retained storage.
Use a private workspace when the user wants private workspace data.

Disconnect retires new website calls and live result delivery. It does not undo
completed changes or automatically cancel work already accepted by a service.
Long-running operations use their owner's explicit cancellation and receipt APIs.

## Diagnose instead of widening

| Evidence | Next action |
| --- | --- |
| Provider unavailable | Render ordinary page content and explain how to open it in a supported Vibestudio host. |
| `EWORKSPACE_DISCONNECTED` | Offer explicit Connect; do not start discovery or resource acquisition. |
| Fresh-user-action required | Wait for a new intentional Connect action; never loop. |
| Website method closed or missing from filtered discovery | Review the receiver's policy with its owner; a broader grant cannot expose it. |
| Missing eligible resource grant | Let the actual operation request its exact ordinary approval and preserve its structured result. |
| Explicit denial, stale document, revoked generation, or lost membership | End that invocation and clear retained UI results; follow only the returned remediation. |
| Uncertain mutating result | Reconcile through the real owner's operation receipt before retrying; a replacement document must obtain fresh delivery authority. |

Do not catch a denial and retry through an installed parent, agent, extension,
native endpoint, different workspace, raw fetch, or credential extraction.
Do not mark every receiver closed to avoid designing a usable website contract.
Review each operation's resource and disclosure semantics, including filesystem
search/handles, subscriptions, callbacks, private template metadata, streams,
and downstream provider effects. Annotation coverage is not a security review.
