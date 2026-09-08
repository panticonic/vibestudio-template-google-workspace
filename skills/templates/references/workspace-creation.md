# Add a workspace

Use this workflow when the user wants to run a workspace from a local checkout or
Git endpoint. The result is a separate workspace with its own panels, runtime
data, membership and approvals. Existing workspaces are selected in the sidebar.

## Open the creation surface

The sidebar Add action and the onboarding **Add workspace** link open the same
creation surface. Offer **Start fresh** to create a workspace from the configured Base, or select a source.
For panel navigation, use `createShellSurfaceLink` from
`@vibestudio/shared/shellSurface`:

```ts
const href = createShellSurfaceLink({ kind: "workspace-chooser" });
```

Navigate this link in the initiating client. Do not call a host filesystem API
from an agent or substitute a guessed path. Opening the surface does not create
or approve a workspace.

## From a folder

Select **Folder**, then **Choose folder…** in the desktop creation surface. Select the root of a
workspace source checkout, containing `meta/vibestudio.yml` and its inventoried
repositories. The current folder acquisition expects a Git checkout with an
origin URL; it captures tracked and non-ignored untracked source changes into an owned
snapshot without committing or changing the original checkout.

Review the returned name and contents, then create the workspace from that exact
snapshot. The checkpoint can be unpublished: do not ask the templates extension
to fetch its pin from remote Git. Canceling the native picker leaves the source
unselected. A folder belongs to the computer that can read it; a remote desktop
session cannot silently interpret a client-local path as a server path.

For development, `pnpm dev --template-checkout PATH` presents a checkout as an
available source. `pnpm dev --workspace-checkout PATH` starts with that checkout
as an additional workspace alongside Personal and System. Both preserve the
selected checkout's visible source state through the same acquisition owner.

## From a Git URL or website

Select **Git URL** and paste a credential-free HTTP(S) Git URL into **Workspace source address**, then
choose **Review workspace** (mobile: **Review source**). Private repositories
use a connected account; never put a password or token in a link.

A website can prefill the same review surface:

```ts
const href = createShellSurfaceLink({
  kind: "workspace-chooser",
  sourceUrl: "https://github.com/owner/workspace",
});
```

Use the returned string as an anchor href. The encoded protocol form is
`vibestudio://surface?v=1&kind=workspace-chooser&source=ENCODED_GIT_URL`.
Both in-place links and new-window links in a desktop browser panel enter the
creation surface. Mobile routes the surface to its creation sheet. The link
carries source input only; it cannot supply a local filesystem path, create a
workspace, or grant access to the website.

Inspection resolves the Git source to an exact commit and content digest,
validates the workspace manifest and complete source inventory, and shows a
review. Creation consumes that inspected pin. It does not re-resolve a moving
branch after review. The new workspace may then need ordinary unit/authority
review before its initial panels run.

## Create from a panel, worker, or connected website

Use the shared runtime clients. Websites must first complete explicit workspace
connection; installed panels and workers use their ordinary admitted runtime.

```ts
import { templates, workspaces } from "@workspace/runtime";

const inspected = await templates.inspect({ url: "https://github.com/owner/workspace" });
// Retain this exact request in caller-scoped durable storage before submitting.
const request = {
  operationId: crypto.randomUUID(),
  workspace: "My app",
  rootTemplate: inspected.pin,
};
const receipt = await workspaces.create(request);
```

On an uncertain submission, reconnect if necessary and call
`workspaces.receipt({ operationId: request.operationId })`. A receipt identifies
the existing result; a null receipt permits resubmitting the original request.
Never generate a new operation ID as a network retry. A deleted result stays
deleted. Changed input needs a deliberately new operation after resolving the
previous submission.

The hub owns creation, initial membership and receipts for both links and RPC.
It derives the account and source identity from authenticated host evidence;
callers cannot choose them. Website receipt ownership is stable across fresh
documents for the same user, source workspace and origin, while each delivery
requires current connection and permission. Panels and workers use their
concrete authenticated runtime identity. Receipts contain no routing credential
or authority to inspect the created workspace; opening remains a separate
trusted workspace action.

## Outcomes and recovery

- A failed inspection creates no workspace. Report the concrete source or
  manifest error; do not substitute a different snapshot.
- A creation interrupted by a connection failure has a retained operation ID.
  Use **Continue previous creation** to reconcile it instead of submitting a
  second workspace.
- If creation succeeded but opening failed, use **Open workspace** to reopen the
  existing result. Do not create again.
- A new source link replaces the idle review session. Old inspection results
  must not replace its selection. A pending creation is reconciled separately.

To edit selected files in the current workspace, use the existing source-copy or
VCS import/merge workflows instead. Workspace creation does not import an
installed template layer, share another workspace's runtime, or inherit grants.
See [workspace RPC](../../workspace-dev/RPC.md) for explicit cross-workspace
integration after creation, and [authoring](template-authoring.md) to publish a
self-contained source that others can add.
