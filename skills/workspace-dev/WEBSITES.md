# Workspace-enabled websites

Use the same application component and typed `@workspace/runtime` API for an
installed panel and a website. Host admission and document lifetime differ;
RPC methods, envelopes, streams, cancellation, and receiver contracts are shared.
Do not add a website proxy, bearer-token bootstrap, alternate credential route,
or a reduced parallel API to make a call work.

Desktop and mobile use native document hosting with a shared provider contract.
Android compiles and the focused document-lifecycle tests pass; iOS still requires
macOS compilation and device acceptance. The complete endpoint/resource audit and
reviewed Pages publication acceptance are not complete. Consult live contracts
before promising an operation.

## Start with zero workspace access

Importing the standalone SDK does not connect or issue workspace RPC. Read the
local `workspaceConnection.available`, `.connected`, and `.kind` properties to
render ordinary content outside Vibestudio and connection controls inside it.
An installed panel already has its normal admitted runtime; it does not ask for
website connection approval.

```tsx
import { useEffect, useState } from "react";
import { connectWorkspace, workspaceConnection } from "@workspace/runtime";

export function ConnectionControl() {
  const [connected, setConnected] = useState(workspaceConnection.connected);
  const [error, setError] = useState("");
  useEffect(() => workspaceConnection.subscribe(() => {
    setConnected(workspaceConnection.connected);
  }), []);
  if (!workspaceConnection.available) return <p>Open this URL in a Vibestudio browser panel to connect.</p>;
  if (connected) return <p>Workspace connected</p>;
  return <><button onClick={() => {
    setError("");
    void connectWorkspace().catch(reason => setError(String(reason)));
  }}>Connect to workspace</button><p role="status">{error}</p></>;
}
```

Call `connectWorkspace()` directly from a fresh user action. A page cannot open
connection consent from a timer, import, background retry, or resource request.
The host consumes trusted input before asynchronous admission; page message payloads
cannot manufacture that evidence.
After denial, let the user choose Connect again. Never automate the approval
surface or disguise another action as Connect.

Until connection succeeds, **all workspace interactions fail**, including
otherwise open methods, discovery, callbacks/subscriptions, and operations with
saved resource grants. Provider availability is local information, not authority.
Connection has its own approval and does not grant model credentials, filesystem
access, private metadata, or publication authority.

## Call and expose ordinary APIs

Once connected, call the same typed clients as an installed panel. Discover the
actual exposed receiver through live docs. An operation enters its ordinary
resource acquisition flow; do not call a separate permission-request API first.
See [website authority](../capabilities/references/website-authority.md) for
eligibility, resource scope, and denial handling.

Every exposed method, streaming handler, and event intake must make an explicit
website policy choice. For a genuinely public, bounded application receiver:

```ts
rpc.expose("readPublicSummary", () => publicSummary, {
  kind: "eligible",
  rationale: "Returns only the application summary deliberately shared with connected websites.",
});
```

For internal UI control, declare `kind: "closed"` with a concrete `reason`.
Eligibility does not authorize protected resources or bypass ordinary receiver
contracts. Worker `@rpc` options and extension method schemas carry the same
`website` policy; omission is a definition error. Streams and event callbacks
need the same deliberate review as request/response methods.

### Shared workspace conversations

Use the portable conversation client exported by `@workspace/runtime` in both
an installed panel and a connected website:

```ts
const chat = createConversationClient(rpc);
await chat.history(channelTargetId);
await chat.send(channelTargetId, text);
await chat.subscribe(channelTargetId, "website-participant", metadata, onRecord, { signal });
```

`channelTargetId` is the host-resolved exact Durable Object target, for example
`do:workers/pubsub-channel:PubSubChannel:<channel-key>`. It is not a channel
name that the website resolves through `workers.resolveService`; service
discovery remains host-controlled. The channel log is the ordinary workspace
conversation store. Website replay, send, and subscribe are individually
reviewed operations, remain subject to normal workspace membership and model
approvals, and never return account credentials. Abort the subscription when a
document disconnects, unmounts, changes conversation, or the user stops the
stream; accepted durable work is governed by its receiver's cancellation
contract and is not implicitly rolled back by document retirement.

## Treat disconnection as runtime retirement

Subscribe to `workspaceConnection` and dispose the subscription on unmount.
On disconnect or document replacement, clear private results, abort local work,
and reject late results from the retired connection. Bind async UI work to a
connection generation so a response cannot repopulate a newly connected page.
Use `disconnectWorkspace()` for an explicit website Disconnect action.

A stable panel slot, URL path, title, icon, or JavaScript object is not a live
execution identity. Reload/navigation requires a fresh document connection.
Remembered origin permission may satisfy that request after explicit Connect;
it never automatically connects a replacement document.

## Build a static site

The Host checkout currently provides:

```sh
pnpm build:website-runtime --out-dir /tmp/website-sdk
pnpm create:website --out-dir /tmp/my-website --sdk-dir /tmp/website-sdk --name my-website
```

These are Host developer commands, not workspace eval exports. The generated
project vendors the exact shared SDK tarball and lockfile. `npm ci` followed by
`npm run build` produces `docs/` with relative asset URLs, `.nojekyll`, and a
content-hashed build manifest. The same `App.tsx` has installed and static entry
points. Full installed/static application parity still needs acceptance; do not
claim it from a successful static bundle alone.

Commit the SDK artifact, lockfile, source, and reviewed public output. Never
include credentials, document challenges, connection handles, workspace state,
transcripts, tool logs, or private source in public assets. Test ordinary-browser
loading under `/repository/`, disconnected behavior, connection/denial, scoped
operations, document replacement, and revocation in the real host.

GitHub Pages uses the existing [GitHub account workflow](../github/SKILL.md)
and semantic VCS followed by protected-main Git export. Select the exact
repository audience and review the complete public file inventory. Repository
creation, source publication, Pages configuration, and remote push are external
effects requiring their ordinary authority. Never use `gh auth`, copy a token
into the page, or report a URL live merely because a push succeeded. Verify the
reviewed commit, served build manifest, and assets. The automated end-to-end
configuration and observation helpers are documented in [GitHub Pages](../github/PAGES.md);
real public deployment acceptance remains outstanding.

For template offers and exact-source inspection, see [templates](../templates/SKILL.md).
A template link opens trusted review; it grants no website workspace access.
Panels, workers and connected websites share `workspaces.create(input)` and
`workspaces.receipt({ operationId })` from `@workspace/runtime`. Inspect a source
with `templates.inspect()` first and pass its exact pin as `rootTemplate`, with
`workspace` and a durable `operationId`. Persist the ID and exact input before
submitting. On an uncertain result, read the receipt using that same ID; never
mint another ID merely because a page reloaded. A null receipt allows retrying
the original exact request. A deleted receipt is final, not permission to recreate.

The caller does not supply account, source workspace or requester identity. The
host attests those facts. Website receipts survive document replacement in the
same authenticated user/workspace/origin scope, after fresh connection and normal
receipt authorization. They convey no routing credentials or access to the new
workspace. Ordinary panels and workers use their authenticated runtime identity.
Trusted creation links and programmatic creation use the same hub lifecycle owner.
