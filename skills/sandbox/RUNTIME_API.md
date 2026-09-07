# Runtime API

Credentials are URL-bound and may only be used through host-mediated egress.

The portable runtime surface is workspace-local. `contextId` identifies a
context branch within the current workspace; it does not select source from
another workspace. Panels, workers, Durable Objects, and eval resolve their
code and state from the workspace that owns the current runtime. Cross-workspace
application RPC forwarding is intentionally unavailable even though the
transport can carry qualified identities; the receiver trust and invocation
isolation policy is still awaiting a product decision.

`services`, `hosts`, and `runtime` are portable `@workspace/runtime` exports:
they are the same caller-scoped clients in panels, workers, Durable Objects,
and eval—not eval-only ambient helpers. `services` supplies dynamic access to
live service methods, `hosts` supplies owner-scoped attached-host access, and
`runtime` is the typed lifecycle/supervision client.

`gatewayFetch` is deliberately gateway-origin scoped. It accepts a relative
path or an absolute URL on the configured gateway origin and rejects a
cross-origin URL before a gateway credential can be sent. Use
`credentials.fetch` for external HTTP. The shared `fs` API has no implicit
deadline: an operation runs until it settles unless its owner passes an
`AbortSignal`; optional settled-operation telemetry is observational only.

## Panel Runtime Surface

In panel component code, the host-injected `panel` object has two identity
layers: `panel.slotId` is the stable visible panel slot and is the correct
identity for panel-tree operations and PubSub/channel clients;
`panel.entityId`/`rpc.selfId` identify the current live runtime entity and can
change when the panel navigates or reopens. `panel` is not a portable export
from `@workspace/runtime` and must not be imported in server-side eval. Eval,
workers, and Durable Objects operate on visible panels through `getParent()`,
`openPanel()`, `getPanelHandle()`, and the `PanelHandle` values returned by
`panelTree`.

<!-- BEGIN GENERATED: panel-runtime-surface -->
Generated from `runtimeSurface.panel.ts`. Use `await help()` at runtime for the live surface.

| Export | Kind | Members | Description |
|--------|------|---------|-------------|
| `PanelOperationError` | value |  | Structured error class thrown by panel create, navigation, reload, rebuild, and readiness operations. Inspect its failure provenance instead of parsing message text. |
| `id` | value |  |  |
| `contextId` | value |  |  |
| `rpc` | value |  | Portable RPC client (the full createRpcClient). |
| `fs` | value |  | Per-context filesystem sandbox. Paths are context-root-relative. The semantic workspace records managed mutations before projection; moves preserve file identity and copies mint a new identity with exact copy provenance. Tracked-to-scratch renames, managed empty-directory mkdir, and open with write flags are rejected. Scratch mkdir and utimes remain direct filesystem operations. Platform-excluded paths and paths outside reserved workspace source roots are local scratch. |
| `callMain` | value |  | Call a `main` (server) service method: callMain("fs.readFile", path). |
| `parent` | value |  | This runtime's parent panel handle (a no-panel handle when there is none). |
| `getParent` | value |  | Get the parent panel handle, or null when there is no parent. |
| `getParentWithContract` | value |  | Get the parent handle typed by a panel contract, or null. |
| `doTargetId` | value |  | Build a unified RPC target ID for a Durable Object reference. |
| `createDurableObjectServiceClient` | value |  | Resolve a Durable Object-backed service and call it through unified RPC. |
| `gatewayConfig` | value |  | Gateway base URL and bearer token for Vibestudio service routes. |
| `gatewayFetch` | value |  | Gateway-origin fetch helper. It accepts relative paths and absolute URLs on the configured gateway origin, then authenticates that request; cross-origin targets are rejected. Use credentials.fetch for external egress. |
| `openExternal` | callable |  | Call `await openExternal(url, options?)` from `@workspace/runtime` in server-side eval, panel/client eval, worker, or Durable Object code to open the system browser. The call itself owns the approval prompt and resumes after the user decides. |
| `workers` | namespace | `listSources`, `create`, `createDurableObject`, `list`, `destroy`, `resetStorage`, `listStorageBackups`, `restoreStorageBackup`, `listServices`, `resolveService`, `resolveDurableObject`, `durableObjectService` | Worker discovery, lifecycle, and manifest-declared service resolution. Use create/list/destroy for regular worker instances; listSources() returns every launchable source with its real manifest entry point and Durable Object classes. |
| `credentials` | namespace | `store`, `connect`, `configureClient`, `requestCredentialInput`, `getClientConfigStatus`, `deleteClientConfig`, `listStoredCredentials`, `summarizeStoredCredentials`, `inspectStoredCredentials`, `revokeCredential`, `resolveCredential`, `fetch`, `hookForUrl`, `gitHttp`, `forAudience` | Typed credential lifecycle and credentialed network access. Use store(input) to persist a URL-bound credential, fetch(url, init?, { credentialId? }?) for credentialed HTTP and a standard Response, hookForUrl(url, { credentialId? }?) for a bound fetch function, gitHttp({ credentialId?, gitIntent? }) for smart-HTTP, and forAudience(descriptor) for a credential-bound handle. The underlying RPC transport is internal. |
| `browserData` | namespace | `getBrowserEnvironment`, `listImportHosts`, `listImportAcquisitionOptions`, `beginImportAcquisition`, `releaseImportSource`, `listImportSources`, `previewImport`, `previewSensitiveImport`, `startImport`, `startSensitiveImport`, `observeSensitiveImport`, `cancelSensitiveImport`, `openBrowserPrivacyManager`, `cancelImport`, `getImportJob`, `listImportJobs`, `listOpenTabs`, `openTabsAsPanels`, `getSitePreferences`, `setSiteZoom`, `getBookmarks`, `addBookmark`, `updateBookmark`, `deleteBookmark`, `moveBookmark`, `searchBookmarks`, `getHistory`, `deleteHistoryEntry`, `deleteHistoryRange`, `clearAllHistory`, `searchHistory`, `searchHistoryForAutocomplete`, `recordHistoryVisit`, `updateHistoryTitle`, `getSearchEngines`, `setDefaultEngine`, `listDownloads`, `listDownloadRecords`, `upsertDownloadRecord`, `pauseDownload`, `resumeDownload`, `cancelDownload`, `openDownload`, `revealDownload`, `putPageFavicon`, `getPageFavicon`, `exportBookmarks` | Typed access to the manifest-declared browser-data provider: detection, import, secret-free summaries, approved sensitive reads, mutation, and export. |
| `git` | namespace | `setSharedRemote`, `removeSharedRemote`, `setUpstream`, `removeUpstream`, `detachUpstream`, `setAutoPush`, `upstreamStatus`, `pushUpstream`, `pullUpstream`, `publishRepo`, `commitMapping`, `importProject` | Typed external Git operations routed through the workspace's configured gitInterop provider. Import and pull create unpublished semantic candidates; only ordinary VCS integration and explicit publication advance protected main. Declarations carry logical credential names resolved by the host, while credential-free remotes are anonymous-first. Pull dry-runs use isolated temporary state and do not mutate managed Git, semantic state, or the remote. |
| `vcs` | namespace | `edit`, `move`, `copy`, `merge`, `revert`, `commit`, `discard`, `importSnapshot`, `registerExternalDelta`, `supersedeExternalDelta`, `finalizeExternalDelta`, `push`, `mainState`, `status`, `compare`, `inspect`, `neighbors`, `history`, `walk`, `query`, `search`, `blame`, `readMemory`, `resolveRepository`, `readFile`, `listDirectory`, `listFiles` | Simple semantic version control: exact event/application state, expressive edit/move/copy records, incremental local integration, whole-chain commit/discard, directly walkable provenance, and atomic external-snapshot acknowledgements containing the committed event/application/work-unit/repository/snapshot tuple. |
| `gad` | namespace | `status`, `ensureBlob`, `listUserNotificationsForMe`, `acknowledgeUserNotification`, `putUserNotification`, `deleteUserNotification`, `getTrajectoryBranchHead`, `listTrajectoryBranches`, `listTrajectoryInvocations`, `listTrajectoryApprovals`, `listChannelEnvelopes`, `listTrajectoryEvents`, `appendChannelEnvelope`, `listMessageTypes`, `getMessageType`, `getChannelEnvelope`, `getTrajectoryForEnvelope`, `resolveTrajectoryForkPoint`, `listPublishedEnvelopesForTrajectory`, `getEnvelopesForTrajectory`, `getPublishedArtifactsForTurn`, `getPrivateLineageForPublishedEnvelope`, `getDownstreamConsumers`, `readChannelEnvelopes`, `inspectChannelEnvelopes`, `listStoredValueRefs`, `inspectStorageDiagnostics`, `inspectPublicationIntegrity`, `inspectTurnState`, `inspectInvocationState`, `diagnoseInvocation`, `inspectChannelRoster`, `inspectAgentHealth`, `listAgentDirectory`, `searchAgentDirectory`, `describeChannels`, `validateGadHashes`, `clearDirtyAfterValidation`, `checkGadIntegrity`, `rebuildTrajectoryProjections` | Typed access to the workspace's canonical Graph and Data store: parameterized SQL, trajectory/channel lineage, integrity diagnostics, provenance, and bounded channel-envelope paging. |
| `blobstore` | namespace | `has`, `stat`, `putText`, `getText`, `getRange`, `getRangeBytes`, `grep`, `putBase64`, `getBase64`, `putTree`, `getTree`, `listTree`, `readFileAtTree`, `diffTrees`, `materializeTree`, `delete`, `list`, `putBytes`, `getBytes`, `readText` | Per-workspace content-addressable blob store: putText/putBase64 store, getText/readText/getRange/getRangeBytes/getBase64 fetch, grep searches; returns a sha256 digest. readText is a portable alias of getText and both return string \| null. Runtime-only putBytes(Uint8Array \| ArrayBuffer) and getBytes(digest) losslessly bridge the wire's base64 representation; MIME metadata is not stored. Persist large artifacts/screenshots and return the digest. Immutable file trees: putTree/getTree store and read tree objects, listTree/readFileAtTree walk a tree hash, diffTrees compares two trees. |
| `webhooks` | namespace | `createSubscription`, `listSubscriptions`, `revokeSubscription`, `rotateSecret` | Ergonomic owner-scoped webhook lifecycle, identical in panels, workers, DOs, and agent eval: createSubscription(request), listSubscriptions(), rotateSecret(subscriptionId, secret?), and revokeSubscription(subscriptionId). Each subscription has an explicit maxBodyBytes budget: relay defaults to its 1,500,000-byte transport ceiling, while direct defaults to the operator-configured host ceiling (16 MiB by default). Delivery events currently include rawBodyBase64, so the host ceiling also bounds that in-memory expansion. Agent eval delegates ownership and target-source checks to its host-verified owning runtime. Secrets are redacted from listings. |
| `extensions` | namespace | `use`, `invoke`, `invokeProvider`, `on` |  |
| `notifications` | namespace | `show`, `dismiss` |  |
| `services` | value |  | Portable dynamic service namespace. Rich runtime clients are available by name; other services dispatch through the caller-scoped main service boundary. The same client is available in panels, workers, Durable Objects, and eval. |
| `hosts` | value |  | Portable owner-scoped attached-host access for development sessions. |
| `runtime` | value |  | Portable typed runtime lifecycle and supervision client for the current workspace context. |
| `workspace` | namespace | `getInfo`, `getActive`, `getConfig`, `validateConfig`, `setInitPanels`, `setConfigField`, `applyPreparedConfig`, `getAgentsMd`, `listSkills`, `readSkill`, `sourceTree`, `ensureContextFolder`, `findUnitForPath`, `projects` | Workspace catalog, source tree, and unit helpers. Does not include panelTree; import top-level panelTree for panel-tree handles. |
| `createPanelSlot` | value |  | Commit a panel under the caller and promptly return its durable handle without focusing or waiting for activation, build, or boot. Server reconciliation owns activation after commit and recovers it across transient failure or restart. Pass operationId for retry-stable identity across exact redelivery; source, contextId, parentId, and ref are also part of that identity. Do not combine operationId with slug. Use handle.observe() when current lifecycle state matters. |
| `openPanel` | value |  | Create a panel and return its handle after the exact attempt is application boot-ready, with no fixed readiness deadline. Pass options.signal for caller-owned cancellation and operationId for retry-stable exact redelivery; source, contextId, parentId, and ref are also part of that identity. Do not combine operationId with slug. It defaults under the caller and focused; use parentId:null for a root or focus:false to suppress presentation. options.placement accepts "side" (default), "side-if-room", "replace", or "split-below". The returned PanelHandle is the complete lifecycle and inspection API. Use `const session = await handle.cdp.session(); const page = session.page` for multi-step automation. The session records the immutable panel generation; after rebuild/navigation call `await session.refresh()` and use the returned session instead of replaying an uncertain action. For a one-off read, `await handle.cdp.page()` remains available and returns a Promise, not a page proxy. For a one-call host image use `await handle.cdp.screenshot({ format: "png" })`. For host-captured logs since panel creation use `await handle.cdp.consoleHistory()` (live page console events are separate). |
| `getPanelHandle` | value |  |  |
| `panelTree` | namespace | `self`, `get`, `rootOwners`, `roots`, `rootsForOwner`, `children`, `page`, `path`, `search`, `parent`, `navigate`, `navigateHistory` | Top-level export, not workspace.panelTree. self/get are synchronous handle factories. Use roots(input?) for the current human subject, rootOwners() then rootsForOwner(ownerUserId) for cross-owner inspection, or children(parentSlotId); each returns a bounded page with entries. page(...) is the advanced discriminated-group primitive. search(...) returns hits containing entry.node and entry.handle. Handle navigate/navigateHistory/focus/reload/rebuild return a boot-ready PanelObservation; observe is the sole live status read. |
| `Rpc` | value |  | RPC helpers namespace export. |
| `z` | value |  | Zod export. |
| `defineContract` | value |  |  |
| `buildPanelLink` | value |  | Build a managed panel URL; options.disposition controls tree placement and options.placement supplies visual side/side-if-room/replace/split-below hints. |
| `buildPanelDeepLink` | value |  | Build a canonical panel deep link with optional tree disposition and visual placement hints. |
| `buildPanelShareLink` | value |  | Build a canonical panel share link with optional tree disposition and visual placement hints. |
| `parseContextId` | value |  |  |
| `isValidContextId` | value |  |  |
| `getInstanceId` | value |  |  |
| `normalizePath` | value |  |  |
| `getFileName` | value |  |  |
| `resolvePath` | value |  |  |
| `createGatewayFetch` | value |  | Create a gateway-authenticated fetch helper from an explicit config. |
| `FORM_FILL_TYPES` | value |  | Canonical HTML autocomplete field vocabulary recognized by browser form fill. |
| `panel` | namespace | `entityId`, `slotId`, `parentId`, `env`, `setTitle`, `getInfo`, `focusPanel`, `getTheme`, `onThemeChange`, `registerHostCommands`, `unregisterHostCommands`, `onHostCommandRun`, `onFocus`, `onConnectionError`, `onChildCreated`, `reopen`, `stateArgs` | Panel-only affordances: identity (entityId/slotId/parentId/env), semantic display title (setTitle(title, { explicit? })), introspection (getInfo/getTheme/onThemeChange/onFocus/onConnectionError), host-local command contribution (registerHostCommands/unregisterHostCommands/onHostCommandRun), lifecycle (focusPanel/onChildCreated/reopen), and stateArgs (get/set/setForPanel). |
| `journal` | namespace | `Journal`, `with`, `current` | Panel operation journaling: journal.Journal (class), journal.with(journal, fn), journal.current(). |
| `agentApi` | value |  |  |
| `adblock` | namespace | `getStats`, `isActive`, `getStatsForPanel`, `isEnabledForPanel`, `setEnabledForPanel`, `resetStatsForPanel`, `getPanelUrl`, `addToWhitelist`, `removeFromWhitelist` |  |
<!-- END GENERATED: panel-runtime-surface -->

Workspace source is one semantic VCS over exact event/application states. Read
[vibestudio-vcs](../vibestudio-vcs/SKILL.md) before source mutation,
comparison, commit, external import, or publication. Use `git` only for external
remote transport; cross that boundary with one exact `vcs.importSnapshot`
rather than ordinary local edits. The successful import atomically returns its
committed event, application, work unit, admitted repositories, and canonical
snapshot. One coherent non-Git source snapshot may contain several repositories
when partial visibility would be incorrect. A Git import has exactly one
repository and one provenance boundary so unrelated remotes never share a
misleading source coordinate.
For external Git smart HTTP, construct `GitClient` from `@vibestudio/git` with
`credentials.gitHttp()`.
For workspace-managed external repo declarations, startup auto-import, branches,
approvals, and private repo retries, see
`skills/onboarding/EXTERNAL_GIT_PROJECTS.md`.

### Filesystem capability discovery

The context filesystem surface is the same from eval, panels, workers, and
Durable Objects. In eval, `fs` is injected; portable code imports `fs` from
`@workspace/runtime`. Use `await help("fs")` for the authoritative live method
list and `await help("fs.<method>")` for its arguments and examples.

`lstat()`, `readlink()`, and `realpath()` inspect symbolic links.
`symlink(target, path, type?)` creates them in context-local scratch. Both the
link and resolved target are confined to the virtual context root;
absolute-looking targets are interpreted relative to that root and stored as
contained relative targets. Link creation under a GAD workspace repo is
rejected because GAD states do not represent link entries. `chown()` remains
absent; use `copyFile()` when the destination must be tracked workspace source.

## Current Workspace

Use `workspace` for semantic workspace metadata, `build.listUnits()` for
declared source/build readiness, and `runtime.supervision` for exact live
executions:

```ts
import { contextId, rpc, runtime, workspace } from "@workspace/runtime";

const active = await workspace.getActive();
const units = await rpc.call("main", "build.listUnits", []);
const live = await runtime.supervision.list();

console.log({ contextId, active });
console.log({ declared: units.slice(0, 5), live: live.slice(0, 5) });
```

`workspace.getActive()` returns the current workspace id for the current
runtime. Use
`build.listUnits()` for declared units and immutable build status. Live
operations require an exact identity returned by `runtime.supervision.list()`:
use `describe(identity)`, `health(identity)`, `logs(identity)`, or
`restart(identity)`. Release history is separately addressed by
`{ kind, releaseId }` through `versions(release)` and `rollback(release,
options)`. Never substitute a package name or source path for either identity.
Server-wide workspace selection and catalog operations belong to the human
shell or CLI's stable hub session and are intentionally absent from runtime
eval. A System management page may select another workspace as a resource, but
that does not load its source into the current runtime or grant its authority.

Workspace host logs are exposed through the service catalog, not as an
`@workspace/runtime` namespace. Use `services.serverLog.tail/query/stats` in
eval, or raw RPC calls such as
`rpc.call("main", "serverLog.query", [{ level: "warn", limit: 100 }])`.
Live following uses
`rpc.stream("main", "events.watch", [["server-log:append"]], { signal })`,
normally through `EventsClient`; cancelling that response is the only
unsubscribe operation. Humans can open the `about/server-logs` viewer. See
[`server-logs`](../server-logs/SKILL.md) for the full contract and exact cleanup
pattern.

## People, Membership, and Presence

Use the service that matches the scope of the question:

```ts
const profile = await services.account.getProfile();
const members = await services.account.listWorkspaceMembers();
const present = await services.workspacePresence.list();
const channelParticipants = await chat.getParticipants(); // type/name/isPerson/isAgent

return { profile, members, present, channelParticipants };
```

- `account.getProfile()` returns the verified user subject for the current
  authenticated call. It is distinct from the executing agent/runtime identity.
- `account.listWorkspaceMembers()` returns durable workspace membership and
  the ordinary workspace role (`admin` or `member`), whether or not each member
  is online. This workspace role is distinct from the authenticated account's
  `accountRole`; neither Personal nor System privacy is represented by an
  ordinary member role.
- `workspacePresence.list()` returns live human presence across the current
  workspace. An empty list is a valid observation.
- `chat.getParticipants()` returns the current conversation's roster, including
  agents and headless participants. Each row exposes `id`, `ref`, `type`,
  `name`, `isPerson`, `isAgent`, and optional `handle`/`methods` directly.
  `headless` and `panel` rows are client transports, not agents. `chat` exists
  only in channel-bound agent eval.
- `gad.inspectChannelRoster` is the durable diagnostic equivalent for a channel
  roster, not a workspace-presence query.

See [CHAT_API.md](CHAT_API.md) for the channel interface. The workspace runtime
does not expose the shell's stable hub session, so `hubControl` is not a route
for discovering other workspaces from eval.

## Notifications

Use `notifications.show()` for host chrome notifications:

```ts
import { notifications } from "@workspace/runtime";

const id = await notifications.show({
  type: "info",
  title: "Notification test",
  message: "notification-show-marker",
});

// The host issued this opaque id. Retain it only if this runtime may dismiss
// the notification later.
await notifications.dismiss(id);
```

`type` may be `info`, `success`, `warning`, `error`, or `consent`. The runtime
client defaults an omitted `type` to `info`; notification text belongs in
`message`. Notification ids are derived from the verified caller and fresh host
entropy; callers cannot provide, reuse, or impersonate an id. Only the runtime
that created a notification can dismiss it, and only an authenticated shell can
report a user click.

This is a transient shell-chrome surface, delivered only to live sessions for
the caller's verified account. A returned id confirms host acceptance, not that
a person saw the notification. Keep ordinary progress and completion in the
conversation; use a notification only for brief attention that is useful while
the user is connected. Notification callbacks belong to the creating runtime's
live heap and are not a durable workflow or approval mechanism.

## Webhook Subscriptions

The portable `webhooks` namespace is the ergonomic lifecycle API in panel,
worker, DO, and agent eval environments:

```ts
import { webhooks } from "@workspace/runtime";

const self = await agent.describe();
const created = await webhooks.createSubscription({
  label: "temporary lifecycle probe",
  target: {
    source: self.identity.source,
    className: self.identity.className,
    objectKey: self.identity.objectKey,
    method: "getDebugState",
  },
  delivery: { mode: "direct" },
  payload: { type: "json" },
  verifier: {
    type: "bearer",
    headerName: "Authorization",
    token: `probe-${crypto.randomUUID()}`,
    scheme: "Bearer",
  },
  response: {
    successStatus: 202,
    malformedPayload: "reject",
    dispatchError: "retry",
  },
});

try {
  const listed = await webhooks.listSubscriptions();
  const rotated = await webhooks.rotateSecret(created.subscriptionId);
  // Do not print or return rotated.secret. Store it only if the integration needs it.
  return {
    created: listed.some((row) => row.subscriptionId === created.subscriptionId),
  };
} finally {
  await webhooks.revokeSubscription(created.subscriptionId);
}
```

`listSubscriptions()` returns active subscriptions, so a successfully revoked
subscription disappears from the default list. Audit/history code can request
redacted tombstones explicitly with
`listSubscriptions({ includeRevoked: true })`.

Subscriptions are owner-scoped. For worker/DO callers (including agent eval),
`target.source` must be the caller's own source; `agent.describe().identity`
provides the correct source, class, and object key without guessing. A target is
only invoked if a public delivery arrives, so a create/list/rotate/revoke
lifecycle probe is harmless. `direct` requires a co-located public gateway;
`relay` requires the relay URL to be configured. If neither deployment surface
is available, report that concrete availability error rather than inventing a
target or switching to an unrelated service.

### Workspace semantic VCS

The `vcs` namespace is workspace-wide and schema-generated. Use
`await help("vcs")` for the compact live method list, then
`await help("vcs.edit")` (or another exact method) for arguments. Use the
[canonical VCS skill](../vibestudio-vcs/SKILL.md) for semantics instead of
copying a method catalog into this runtime guide.

Important routing rules:

- `status` returns the exact committed event and working event/application node;
- every context mutation carries `expectedWorkingHead` and `commandId`;
- `compare` classifies source changes against one exact target state;
- `merge` appends local stable-coordinate accounting decisions;
- `commit` and `discard` consume the complete local application chain;
- `move` and `copy` preserve explicit identity/content provenance;
- ordinary build and test services validate the current context; VCS does not
  expose a second preview-build path;
- `push` publishes one already-committed exact event after protected checks.

## Store

```ts
const stored = await credentials.store({
  label: "Example API",
  audience: [{ url: "https://api.example.com/", match: "origin" }],
  injection: {
    type: "header",
    name: "authorization",
    valueTemplate: "Bearer {token}",
  },
  material: { type: "bearer-token", token },
});
```

## OAuth Without Returning Tokens

Use `credentials.connect()` for OAuth. The host owns the redirect,
browser handoff, callback validation, token exchange, encrypted storage, and
initial use grant. If the provider has client secrets or other setup material,
collect it with `credentials.configureClient()` and pass `clientConfigId`
to `connect`.

```ts
const stored = await credentials.connect({
  flow: {
    type: "oauth2-auth-code-pkce",
    authorizeUrl: "https://auth.example.com/oauth/authorize",
    tokenUrl: "https://auth.example.com/oauth/token",
    clientId: "public-client-id",
    scopes: ["read"],
  },
  credential: {
    label: "Example API",
    audience: [{ url: "https://api.example.com/", match: "origin" }],
    injection: {
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token}",
    },
  },
  browser: "external", // or "internal" for an app browser panel
});
```

## Use

```ts
await credentials.fetch("https://api.example.com/v1/items", undefined, {
  credentialId: stored.id,
});
```

## Durable Object-backed App Databases

For shared application data, use a worker Durable Object with SQLite
(`this.sql`) and expose narrow RPC methods. Do not use the eval `db` for panel
or app state that another runtime needs to read; eval `db` is private to the
agent's EvalDO.

Resolve the service by protocol or name, optionally pass an object key for a
partitioned database, then call the DO target:

```ts
import { rpc, workers } from "@workspace/runtime";

const store = await workers.resolveService("example.todos.v1", "project-123");
if (store.kind !== "durable-object") throw new Error("Expected DO service");

await rpc.call(store.targetId, "upsertTodo", [{ title: "Ship the app" }]);
const rows = await rpc.call(store.targetId, "listTodos", []);
```

The worker must also admit the caller in two places: the live service
`authority.principals` gate and each exposed DO method's
`@rpc({ principals, effect, tier, sensitivity })` receiver policy.
See [workspace-dev/WORKERS.md](../workspace-dev/WORKERS.md#durable-object-backed-app-databases)
for the schema, declaration, partition-key, and testing recipe.

## Unified Panel Handles

Use `panelTree` and `PanelHandle` from panels, workers, and DOs. In panel
code, `panelTree` is imported directly from `@workspace/runtime`; it is not
`workspace.panelTree`:

> **Headless tree root:** a genuinely headless eval has a tree but no initial
> panel node, so `await getParent()` returns `null`. If the workflow needs a
> child, create an owned root first and parent the target explicitly:
> `const root = await openPanel("about/new", { parentId: null });` then
> `const child = await openPanel(source, { parentId: root.id });`. Archive `root`
> when done to clean the subtree. Do not throw merely because `getParent()` is
> null, and do not use the truthiness of the compatibility `parent` handle.

```ts
import { panelTree, openPanel } from "@workspace/runtime";

const created = await openPanel("https://example.com", { focus: true });
const same = panelTree.get(created.id);
const parent = panelTree.self().parent();
const parentObservation = parent ? await parent.observe() : null;
const roots = await panelTree.roots({ limit: 100 }); // current human subject
console.log(roots.entries.map(({ handle }) => handle.title));
const rootOwnerPage = await panelTree.rootOwners({ limit: 100 });
for (const owner of rootOwnerPage.owners) {
  const ownedRoots = await panelTree.rootsForOwner(owner.ownerUserId, {
    limit: 100,
  });
  console.log(ownedRoots.entries.map(({ handle }) => handle.title));
}
const workspaceRoots = await panelTree.rootsForOwner(null, { limit: 100 });
const children = await panelTree.children(created.id, { limit: 100 });
const existing = (await panelTree.search({ query: "spectrolite", limit: 20 })).hits.find(
  ({ entry }) => entry.handle.source === "panels/spectrolite"
)?.entry.handle;
const byKnownSlot = panelTree.get("panel-slot-id");
const before = await byKnownSlot.observe(); // exact attempt and provenance
await byKnownSlot.setTitle("Semantic panel title", { explicit: true });
await byKnownSlot.navigate("panels/spectrolite", { contextId: "ctx-vault" }); // state/files only; code remains the default/current build
await byKnownSlot.navigate("panels/spectrolite", {
  contextId: "ctx-vault",
  ref: "ctx:ctx-vault",
}); // only when intentionally building code from that context branch
```

Panel state arguments live on the returned handle. They are validated and
persisted by the host, so a change can be checked immediately without reading
an internal workspace service:

```ts
const root = await openPanel("about/new", { parentId: null, focus: false });
try {
  const handle = await openPanel("panels/spectrolite", {
    parentId: root.id,
    stateArgs: { mode: "fixture" },
    focus: false,
  });
  const before = await handle.stateArgs.get();
  const afterSet = await handle.stateArgs.set({ mode: "live" });
  const after = await handle.stateArgs.get();
  await handle.archive();
  console.log({ before, afterSet, after });
} finally {
  await root.archive();
}
```

For recursive collection supervision, semantic grouping, shared orchestration
contexts, notes, and bounded child-panel automation, read the co-located
[collection conductor skill](../../about/collection/SKILL.md).

### Eval And Visible Panel Perspective

In server-side eval, `panelTree.self()` is the EvalDO runtime, not the visible
chat panel. Use `parent`/`getParent()` for the owner agent's nearest visible
panel ancestor, and use bounded `panelTree.roots()`/`panelTree.children()`/
`panelTree.search()` reads to inspect the
visible panel tree the user is talking about. If you need the chat attached to a
parent or sibling panel, read that target panel's state args:

For the complete root/child verification and cleanup pattern, see
`EVAL.md#eval-perspective`.

```ts
import { gad, panelTree, rpc, workers } from "@workspace/runtime";

const target = panelTree.get("panel-slot-id");
const stateArgs = target ? await target.stateArgs.get<Record<string, unknown>>() : {};
const channelId = String(stateArgs.channelName ?? stateArgs.channelId ?? "");

const health = channelId ? await gad.inspectAgentHealth({ channelId }) : null;

// Optional read-only agent debug for a DO-backed agent in that channel.
const channel = channelId ? await workers.resolveService("vibestudio.channel.v1", channelId) : null;
const debug =
  channel?.kind === "durable-object"
    ? await rpc.call(channel.targetId, "inspectAgent", [
        "do:workers/agent-worker:AiChatWorker:agent-key",
        "getDebugState",
      ])
    : null;
```

Do not assume `chat.channelId` names the target panel's channel unless the user
explicitly means the current chat where the agent is responding.

`openPanel()` creates a panel owned by the workflow. Handles
from `list`/`roots`/`children`/`get` are existing panels; do not call
`handle.navigate`, `handle.reload`, or `handle.archive` unless requested. Inside
the current panel, prefer `reopen({ contextId, stateArgs })` for
self-replacement of state/files. `contextId` does not select code provenance;
pass an explicit `ref` on ref-capable navigation APIs when code should come from
a context branch.

For web automation, use an owned browser panel from `openPanel("https://...")`.
Do not use the current chat panel, a parent chat panel, or another workspace
panel as a disposable browser target. `handle.cdp.navigate(url)` and
`page.goto(url)` replace/navigate the panel they target; use them only on the
browser panel you intentionally opened or on a panel the user explicitly asked
you to replace.

`PanelHandle` combines observation, RPC, lifecycle, state, tree, and CDP:

```ts
const current = await same.observe();
await same.focus(); // returns only after application boot-ready
const state = await same.stateArgs.set({ mode: "review" });
// set() merges a patch and returns the full authoritative state.
// Use null to remove a key: await same.stateArgs.set({ mode: null });
await same.call.someExposedMethod();

const session = await same.cdp.session();
const page = session.page;
await page.title();
page.url(); // string, synchronous like Playwright
await same.click("button");
```

`await openPanel(...)` returns only after the selected immutable attempt is
application boot-ready, whether or not the panel is focused. `focus()`,
`navigate()`, `reload()`, and `rebuild()` have the same completion contract.
There is no separate handle lease/load status. `observe().phase === "ready"` is
the sole positive readiness answer. `snapshot()` returns
`{ panelId, attemptId, runtimeEntityId, buildKey, capturedAt, document }`.

`same.cdp.session()` returns a `panel-cdp-session.v1` lease containing the
canonical Playwright-style page and its immutable attempt/runtime/build
generation. Use `session.refresh()` after rebuild or navigation and continue
with the returned session; the status is `current`, `reconnected`, or
`replaced`, and no uncertain action is replayed.

`same.cdp.page()` returns the same canonical Playwright-style page without a
generation lease for one-off work. Both are driven by our workerd-native CDP
client (`@workspace/cdp-client`). This is one browser-automation surface —
there is no separate compatibility tier, and you do not import or install any
`playwright*` package. The page exposes
locators (`page.locator`, `page.getByRole`, `page.getByText`, `page.getByLabel`,
…), auto-waiting actions (`click`, `fill`, `check`, `selectOption`, …), reads
(`innerText`, `count`, `isVisible`, `getAttribute`, …), and page-level methods
(`goto`, `screenshot`, `waitForSelector`, `evaluate`, …). For protocol-level
work, `import { CdpConnection } from "@workspace/cdp-client"` and connect with
`(await same.cdp.getCdpEndpoint())`.

`openPanel`/`panelTree`/`PanelHandle` are part of the portable runtime surface
from `@workspace/runtime`; they work from server-side eval, panels, workers, and
DOs. The `handle.cdp.*` automation is workerd-native and runs over a WebSocket
to the panel's CDP endpoint, so eval can open or discover a panel and drive its
browser target directly.

Readiness-bearing operations use the canonical idempotent host-lease ensure
transition before waiting. Programmatic runtimes prefer the headless CDP host
and can fall back to a CDP-capable desktop host; a native desktop focus bridge
loads on that desktop instead. `unload()` releases only the presentation
resource, so a later focus, navigation, reload, rebuild, snapshot, or CDP
operation can materialize the unchanged panel again. `observe()` remains a
pure read and does not reacquire an evicted host. During reconnect grace a
lease may remain for routing, but its old ready sample is suppressed; a
mobile-held panel and a failed host materialization are reported immediately
as structured host failures rather than waiting for the readiness deadline.

CDP and structural operations are approval-gated on first use per requester
runtime entity and target panel. Privileged shell/about targets use a severe
danger-tone approval. If a target cannot become application-ready, the
readiness-bearing operation throws `PanelOperationError` with structured
stage/code/provenance. Call `handle.diagnose()` for one bounded observation,
console/lifecycle history, and ready document. A target held by a mobile/non-CDP
host rejects CDP access.

## Userland-owned capabilities

There is no portable `approvals` namespace. A workspace provider protects a
custom resource by declaring it in the exact package manifest's
`vibestudio.authority.provides` and binding the receiving `@rpc` method to that
unit-local name with a literal `userland-capability` effect. The host derives
the receiver resource and runs the trusted acquisition flow before provider
code executes.

Use the normal permission inventory when the user asks which grants are active:

```ts
const grants = await rpc.call("main", "permissions.list", []);
```

Use `permissions.listAgentProfiles` for each agent's human-readable standing
authority and locks. Do not add advisory prompts around `openExternal()`,
`credentials.*`, `git.*`, `vcs.*`, panel operations, or other host-mediated
APIs; their receivers already apply the correct scope and audit model. The
[capabilities skill](../capabilities/SKILL.md) documents complete
receiver-object and opaque-handle provider patterns.

## Workspace VCS operations

Read [vibestudio-vcs](../vibestudio-vcs/SKILL.md) and the live `help("vcs")`
schema. That skill is the single maintained workflow source for semantic edits,
comparison/integration, commit/remainder handling, move/copy, external snapshot
import (including coherent non-Git multi-repository bootstrap), counteraction-based
revert, provenance, typed recovery, and protected publication.
