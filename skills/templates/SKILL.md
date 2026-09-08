---
name: templates
description: Discover, inspect, create, and publish exact upstream workspace snapshots.
---

# Workspace templates

`@workspace-extensions/templates` owns catalog discovery, exact acquisition,
manifest inspection, and snapshot publication. A template is a self-contained
upstream workspace source. It is not an installed layer and confers no grants.

Base is an ordinary source-only upstream. A workspace records its adopted
upstream identity and exact source baseline, but runs from its own materialized
source and does not load Base or another workspace at runtime. Copy, compare,
and merge are explicit source operations that preserve provenance and do not
grant authority.

Use [public-contract.json](public-contract.json) for exact method shapes and
[template authoring](references/template-authoring.md) when publishing.

## Discover and create

Open the host workspace chooser to discover development checkouts selected for
the current launch. The host validates and presents those private exact
snapshots; their filesystem paths never enter workspace code. Selecting one
creates a new workspace from its exact pin. Do not send that pin through remote
Git inspection because its checkpoint commit may intentionally be unpublished.

Read `catalog` without arguments for cached rendering. Refresh only after an
explicit user action with `[{ refresh: true }]`. Catalog selections remain
bound to the returned `coordinates.commit` and `coordinates.snapshot`.
The result is `null` when no catalog is cached. Otherwise `entries` is the
template array: use `entries.length` for the template count. `coordinates`
identifies the verified registry snapshot; it does not describe a workspace
that has already been created.

Use the extension's complete installed unit name when invoking it:

```ts
import { extensions } from "@workspace/runtime";

return await extensions.invoke("@workspace-extensions/templates", "catalog", []);
```

Call `inspect` with an already reviewed exact `{ pin }`, a direct
`{ url, credential? }`, or a catalog-bound
`{ catalogId, registryCommit, registrySnapshot }`. The result contains the
exact immutable `pin`, self-asserted presentation, and validated repository and
file inventory. To open an application, pass that exact pin to the ordinary
workspace creation flow as `rootTemplate`, creating a new standalone
workspace. Standalone template sources follow the same inspect-exact-pin-then-
create flow. Never merge it into the current workspace as an installed
template.

To incorporate selected source into an existing workspace, use ordinary VCS
compare and merge operations and record their normal source baseline. Template
metadata does not choose merge precedence or apply provider, trust, credential,
or authority settings.

## Copy selected source between workspaces

Native System clients use `prepareSelectedTransfer` from
`@workspace/workspace-transfer`. It is a shared client implementation over the
existing authenticated `vcs` and `blobstore` services, not an application RPC
bridge. Application RPC uses an explicit workspace destination, deliberately
exposed receiver methods, and both workspaces' boundary policies in addition
to ordinary operation authority; see [RPC](../workspace-dev/RPC.md). Source
transfer does not create an RPC permission or share runtime state.

Read `vcs.mainState()` to capture protected main directly without creating an
observation context. Capture the source workspace, exact VCS state and explicitly selected
repository/file paths. Capture the destination workspace, repository path,
review context ID and expected working head. Supply source/destination labels
and the audience from the current hub/account selection. Pass a client factory
bound to that authenticated hub/account. Its VCS client needs `listFiles`,
`status`, `importSnapshot`, `registerExternalDelta`, `compare` and `merge`; its
blobstore client needs `getBase64` and `putBase64`.

`prepareSelectedTransfer(input, getWorkspaceClient)` returns an immutable
`preview` and an `execute()` method. The preview shows exact source/destination
filenames, digest, mode, byte count and audience. Preparation sends nothing to
the destination. Review the preview and recheck destination membership before
calling `execute()`. Native UI confirms the workspace audience: only the owner
for private workspaces, or all current and future authorized members for ordinary
workspaces. Reconfirm if that audience policy changed, or if a review explicitly
promised an exact roster and that roster changed.
Selection is bounded to 200 regular/executable files and 4 MiB of content;
oversized files are rejected from metadata before their bytes are fetched.

For a fresh review branch, reserve an ID locally and call
`runtime.createContext({ contextId })` only after Copy is confirmed. Capture the
destination main event as `expectedWorkingHead`: execution checks the new
context's actual head before disclosing source content. If main advanced, it
requires a fresh review. Execution also revalidates source and destination
access and verifies every copied content digest. It transfers selected bytes
and a fresh import boundary, never source history, runtime data, membership,
credentials or grants.

With no destination `repositoryId`, execution imports the complete selected
manifest as a new repository in that review context. With an existing
`repositoryId`, it registers an external delta covering only the selected
destination paths, then returns ordinary compare/merge results. Unselected
destination files remain unchanged. The baseline is the selected destination
content: this operation is an explicit copy, not an ancestry-preserving source
merge. A true authored-baseline merge requires an available, authorized baseline
and the existing external-delta workflow.

An existing-repository result may contain conflicts or unfinished merge pages.
Continue with ordinary VCS review and explicit conflict resolution, then commit
and finalize the delta. New-repository import is committed locally by the normal
import operation. Neither path pushes to main; publication remains the ordinary
separate review and approval flow. Keep the operation ID for canonical command
reconciliation if a connection fails during execution.

## Author and publish

Use `authoringParts`, then `inspectAuthoring` with `{ name, description,
parts }`. Review `requiredParts`: workspace package dependencies and runtime
companions are included so the published snapshot is self-contained.

Publish the unchanged receipt through `publishAuthoring` with its fingerprint,
version, explicit destination, and fresh command ID. The resulting URL, ref,
commit, and snapshot are the exact release coordinates. Registry recommendation
is a separate `suggestRegistryEntry` contribution.

Logical credential names may be recorded. Concrete credential IDs are used only
for the explicit publication call and never written into the snapshot.
