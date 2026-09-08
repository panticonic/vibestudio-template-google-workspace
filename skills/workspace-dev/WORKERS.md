# Worker Runtime API

Every worker manifest declares one semantic icon in `vibestudio.icon`. Follow
[the shared icon guide](references/icons.md): prefer a curated Lucide object or
truthful brand mark, then a meaningful emoji or original unit-relative artwork.
Image icons such as `"./assets/icon.svg"` are copied into the immutable build
and may be SVG, PNG, JPEG, WebP, AVIF, GIF, or ICO (up to 1 MiB). It is the
worker's recognizable identity in install and capability approval prompts, so
choose an icon for what the worker does rather than its implementation
technology. Do not add a second icon under `vibestudio.agent`.

Credentials are URL-bound and may only be used through host-mediated egress.

The portable `@workspace/runtime` surface is shared by panels, workers, Durable
Objects, and eval. In particular, `services` is the same dynamic service
namespace everywhere, `hosts` is the same owner-scoped attached-host client,
and `runtime` is the same typed lifecycle/supervision client—not an eval-only
compatibility surface.

Filesystem calls have no implicit RPC deadline. They run until they settle or
the owning execution aborts them through an `AbortSignal`; any settled-operation
telemetry is observational and never aborts a call.

## Worker Runtime Surface

<!-- BEGIN GENERATED: worker-runtime-surface -->
Generated from `runtimeSurface.worker.ts`. Use `await help()` at runtime for the live surface.

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
| `workspaces` | namespace | `create`, `receipt` | Create workspaces from exact inspected template pins and reconcile durable receipts. Available to panels, workers, eval and connected websites under ordinary caller authorization. Creation returns no routing credentials or authority over the new workspace. |
| `credentials` | namespace | `store`, `connect`, `configureClient`, `requestCredentialInput`, `getClientConfigStatus`, `deleteClientConfig`, `listStoredCredentials`, `summarizeStoredCredentials`, `inspectStoredCredentials`, `revokeCredential`, `resolveCredential`, `fetch`, `hookForUrl`, `gitHttp`, `forAudience` | Typed credential lifecycle and credentialed network access. Use store(input) to persist a URL-bound credential, fetch(url, init?, { credentialId? }?) for credentialed HTTP and a standard Response, hookForUrl(url, { credentialId? }?) for a bound fetch function, gitHttp({ credentialId?, gitIntent? }) for smart-HTTP, and forAudience(descriptor) for a credential-bound handle. The underlying RPC transport is internal. |
| `browserData` | namespace | `getBrowserEnvironment`, `listImportHosts`, `listImportAcquisitionOptions`, `beginImportAcquisition`, `releaseImportSource`, `listImportSources`, `previewImport`, `previewSensitiveImport`, `startImport`, `startSensitiveImport`, `observeSensitiveImport`, `cancelSensitiveImport`, `openBrowserPrivacyManager`, `cancelImport`, `getImportJob`, `listImportJobs`, `listOpenTabs`, `openTabsAsPanels`, `getSitePreferences`, `setSiteZoom`, `getBookmarks`, `addBookmark`, `updateBookmark`, `deleteBookmark`, `moveBookmark`, `searchBookmarks`, `getHistory`, `deleteHistoryEntry`, `deleteHistoryRange`, `clearAllHistory`, `searchHistory`, `searchHistoryForAutocomplete`, `recordHistoryVisit`, `updateHistoryTitle`, `getSearchEngines`, `setDefaultEngine`, `listDownloads`, `listDownloadRecords`, `upsertDownloadRecord`, `pauseDownload`, `resumeDownload`, `cancelDownload`, `openDownload`, `revealDownload`, `putPageFavicon`, `getPageFavicon`, `exportBookmarks` | Typed access to the manifest-declared browser-data provider: detection, import, secret-free summaries, approved sensitive reads, mutation, and export. |
| `git` | namespace | `setSharedRemote`, `removeSharedRemote`, `setUpstream`, `removeUpstream`, `detachUpstream`, `setAutoPush`, `upstreamStatus`, `pushUpstream`, `pullUpstream`, `publishRepo`, `commitMapping`, `importProject` | Typed external Git operations routed through the workspace's configured gitInterop provider. Import and pull create unpublished semantic candidates; only ordinary VCS integration and explicit publication advance protected main. Declarations carry logical credential names resolved by the host, while credential-free remotes are anonymous-first. Pull dry-runs use isolated temporary state and do not mutate managed Git, semantic state, or the remote. |
| `vcs` | namespace | `edit`, `move`, `copy`, `merge`, `revert`, `commit`, `discard`, `importSnapshot`, `registerExternalDelta`, `supersedeExternalDelta`, `finalizeExternalDelta`, `push`, `mainState`, `status`, `compare`, `inspect`, `neighbors`, `history`, `walk`, `query`, `search`, `blame`, `readMemory`, `resolveRepository`, `readFile`, `listDirectory`, `listFiles` | Simple semantic version control: exact event/application state, expressive edit/move/copy records, incremental local integration, whole-chain commit/discard, directly walkable provenance, and atomic external-snapshot acknowledgements containing the committed event/application/work-unit/repository/snapshot tuple. |
| `gad` | namespace | `status`, `ensureBlob`, `listUserNotificationsForMe`, `acknowledgeUserNotification`, `putUserNotification`, `deleteUserNotification`, `getTrajectoryBranchHead`, `listTrajectoryBranches`, `listTrajectoryInvocations`, `listTrajectoryApprovals`, `listChannelEnvelopes`, `listTrajectoryEvents`, `appendChannelEnvelope`, `listMessageTypes`, `getMessageType`, `getChannelEnvelope`, `getTrajectoryForEnvelope`, `resolveTrajectoryForkPoint`, `listPublishedEnvelopesForTrajectory`, `getEnvelopesForTrajectory`, `getPublishedArtifactsForTurn`, `getPrivateLineageForPublishedEnvelope`, `getDownstreamConsumers`, `readChannelEnvelopes`, `inspectChannelEnvelopes`, `listStoredValueRefs`, `inspectStorageDiagnostics`, `inspectPublicationIntegrity`, `inspectTurnState`, `inspectInvocationState`, `diagnoseInvocation`, `inspectChannelRoster`, `inspectAgentHealth`, `listAgentDirectory`, `searchAgentDirectory`, `describeChannels`, `validateGadHashes`, `clearDirtyAfterValidation`, `checkGadIntegrity`, `rebuildTrajectoryProjections` | Typed access to the workspace's canonical Graph and Data store: parameterized SQL, trajectory/channel lineage, integrity diagnostics, provenance, and bounded channel-envelope paging. |
| `images` | namespace | `generate`, `getJob`, `cancel`, `retry`, `forgetJob`, `deleteArtDirection`, `getAsset`, `readAsset`, `importAsset`, `retain`, `release`, `putArtDirection`, `getArtDirection`, `getBytes`, `wait` | Workspace image assets and durable generation jobs. generate({requestId,prompt,references?,artDirection?}) returns a job; wait(job.id) observes completion. Store the resulting immutable asset reference in application state. GeneratedImage from @workspace/react displays assets in running panels without rebuilding. getBytes performs authenticated reads for custom renderers. retain/release manage application ownership; art direction versions provide reusable style briefs and reference assets. |
| `blobstore` | namespace | `has`, `stat`, `putText`, `getText`, `getRange`, `getRangeBytes`, `grep`, `putBase64`, `putRetained`, `retain`, `releaseRetention`, `getBase64`, `putTree`, `getTree`, `listTree`, `readFileAtTree`, `diffTrees`, `materializeTree`, `delete`, `list`, `putBytes`, `getBytes`, `readText` | Per-workspace content-addressable blob store: putText/putBase64 store, getText/readText/getRange/getRangeBytes/getBase64 fetch, grep searches; returns a sha256 digest. readText is a portable alias of getText and both return string \| null. Runtime-only putBytes(Uint8Array \| ArrayBuffer) and getBytes(digest) losslessly bridge the wire's base64 representation; MIME metadata is not stored. Persist large artifacts/screenshots and return the digest. Immutable file trees: putTree/getTree store and read tree objects, listTree/readFileAtTree walk a tree hash, diffTrees compares two trees. |
| `webhooks` | namespace | `createSubscription`, `listSubscriptions`, `revokeSubscription`, `rotateSecret` | Ergonomic owner-scoped webhook lifecycle, identical in panels, workers, DOs, and agent eval: createSubscription(request), listSubscriptions(), rotateSecret(subscriptionId, secret?), and revokeSubscription(subscriptionId). Each subscription has an explicit maxBodyBytes budget: relay defaults to its 1,500,000-byte transport ceiling, while direct defaults to the operator-configured host ceiling (16 MiB by default). Delivery events currently include rawBodyBase64, so the host ceiling also bounds that in-memory expansion. Agent eval delegates ownership and target-source checks to its host-verified owning runtime. Secrets are redacted from listings. |
| `extensions` | namespace | `use`, `invoke`, `invokeProvider`, `on` |  |
| `templates` | namespace | `inspect`, `inspectAuthoring`, `authoringParts`, `publishAuthoring` | Exact source inspection and publication through the admitted template receiver. |
| `notifications` | namespace | `show`, `dismiss` |  |
| `services` | value |  | Portable dynamic service namespace. Rich runtime clients are available by name; other services dispatch through the caller-scoped main service boundary. The same client is available in panels, workers, Durable Objects, and eval. |
| `hosts` | value |  | Portable owner-scoped attached-host access for development sessions. |
| `runtime` | value |  | Portable typed runtime lifecycle and supervision client for the current workspace context. |
| `workspace` | namespace | `getInfo`, `getActive`, `getConfig`, `validateConfig`, `setInitPanels`, `setConfigField`, `applyPreparedConfig`, `getAgentsMd`, `listSkills`, `readSkill`, `sourceTree`, `ensureContextFolder`, `findUnitForPath`, `projects` | Workspace catalog, source tree, and unit helpers. Does not include panelTree; use runtime.panelTree for panel-tree handles. |
| `createPanelSlot` | value |  | Commit a panel and promptly return its durable handle without focusing or waiting for activation, build, or boot. Server reconciliation owns activation after commit and recovers it across transient failure or restart. Pass operationId for retry-stable identity; use handle.observe() when current lifecycle state matters. |
| `openPanel` | value |  | Create a panel and return its handle after the exact attempt is application boot-ready, with no fixed readiness deadline. Pass options.signal for caller-owned cancellation and operationId for retry-stable identity. It defaults under the caller and focused; use parentId:null for a root or focus:false to suppress presentation. options.placement accepts "side" (default), "side-if-room", "replace", or "split-below". The returned PanelHandle is the complete lifecycle and inspection API. Use `const session = await handle.cdp.session(); const page = session.page` for multi-step automation. The session records the immutable panel generation; after rebuild/navigation call `await session.refresh()` and use the returned session instead of replaying an uncertain action. For a one-off read, `await handle.cdp.page()` remains available and returns a Promise, not a page proxy. For a one-call host image use `await handle.cdp.screenshot({ format: "png" })`. For host-captured logs since panel creation use `await handle.cdp.consoleHistory()` (live page console events are separate). |
| `getPanelHandle` | value |  | Alias for runtime.panelTree.get(id, kind?). |
| `panelTree` | namespace | `self`, `get`, `rootOwners`, `roots`, `rootsForOwner`, `children`, `page`, `path`, `search`, `parent`, `navigate`, `navigateHistory` | Runtime property, not workspace.panelTree. self/get are synchronous handle factories. Use roots(input?) for the current human subject, rootOwners() then rootsForOwner(ownerUserId) for cross-owner inspection, or children(parentSlotId); each returns a bounded page with entries. page(...) is the advanced discriminated-group primitive. search(...) returns hits containing entry.node and entry.handle. Handle navigate/navigateHistory/focus/reload/rebuild return a boot-ready PanelObservation; observe is the sole live status read. |
| `handleRpcPost` | value |  |  |
| `destroy` | value |  |  |
<!-- END GENERATED: worker-runtime-surface -->

Readiness-bearing panel operations are also materialization requests. The
portable runtime reuses the idempotent host-lease transition after eviction;
`observe()` remains read-only. Programmatic workers prefer a headless CDP host,
while a native desktop focus bridge keeps UI presentation on the desktop.
Reconnect grace does not preserve readiness, and mobile-held or failed host
states reject immediately with structured host failures.

Existing panel handles are non-owned; do not call `handle.navigate`,
`handle.reload`, or `handle.archive` unless requested. Use
`handle.navigate(source, opts)` or `panelTree.navigate(id, source, opts)` only
when replacing that specific slot is the requested behavior. Clean up temporary
panels opened by the worker.

For panel navigation options, `contextId` changes the target panel's
filesystem/storage context and `ref` selects the code build. Never rely on
`contextId` to imply `ctx:<contextId>`; pass `ref` explicitly when replacing a
panel with context-branch code.

A context is the complete workspace branch across every repository. Repository
or vault selection is ordinary state inside that branch. Panels, their channels,
and agents launched from them share the panel's host-bound context; never put a
second authoritative context in `stateArgs`. New branches come only from the
explicit fork/clone/subagent lifecycle APIs. A panel may move to an existing
branch only through `panel.switchContext(contextId, opts?)` or an explicit
panel-tree navigation carrying `contextId`.

For workers and Durable Objects, the owning `contextId` also selects the
default semantic working state. Omit `ref` to follow that context; use `ref: "main"` only
to pin protected main, or another explicit immutable selector deliberately.

## Worker Lifecycle and Environment Bindings

### Startup and dependency budgets

Worker and Durable Object builds preserve ESM dynamic imports as modules in the
sealed workerd module map. Use that boundary deliberately:

- Keep the entry module, exported DO classes, constructors, migrations, and
  subscription/bootstrap path limited to code required for every activation.
- Dynamically import feature payloads at their semantic operation: model
  provider adapters at model selection/call, HTML/PDF extraction at fetch,
  syntax parsers at code evaluation, exporters at telemetry export, and
  administrative/debugging code at inspection.
- Prefer narrow package subpath exports over a broad barrel. A barrel that
  imports tools or providers for re-export can pull their complete static
  closure into every worker even when only one type or helper is needed. Use
  `import type` for type-only relationships.
- Do not make a second reduced implementation. Split the canonical package
  into a side-effect-free kernel and feature modules. Every feature must retain
  its normal validation, authority, error handling, and tests when loaded.
- Verify architecture at both ends: assert that the heavy marker is absent from
  `bundle.js` and present in a chunk, then execute the dynamic import in a real
  workerd test. A chunk emitted by esbuild but omitted by the immutable artifact
  store or loader is a runtime defect.

Build reports and source maps answer different questions. Entry/static-closure
bytes approximate cold parse/evaluation pressure; lazy bytes show deferred
feature cost; total sealed bytes show storage and module-map transport cost.
Never claim that code splitting reduced all three. Pair those measurements with
one cold and one verified-cache activation trace as described by the
[performance skill](../performance/SKILL.md).

Discover launchable sources with `await workers.listSources()`. The result
includes every regular and Durable Object worker, its workspace `source`, the
manifest's actual `entry`, and `classes` (empty for a regular worker). Use the
returned `entry` or read `<source>/package.json`; do not assume `index.ts`.

Launch and retire a regular worker through the portable typed client (which
delegates to the canonical runtime entity service):

```ts
const handle = await workers.create("workers/my-worker", {
  key: `probe-${crypto.randomUUID()}`,
  contextId: ctx.contextId,
  env: { NON_SECRET_PROBE: "configured" },
});

try {
  // Exercise the worker here.
} finally {
  await workers.destroy(handle);
}
```

`key` is a durable, immutable instance identity—not a mutable deployment slot.
The same key can idempotently address the same build, but it never silently
switches to code produced by a later edit. For disposable edit-and-run work,
generate a fresh key after every code change. If an application deliberately
owns a stable key, retire the old handle before creating the replacement. In
both cases, keep the handle in scope and await `workers.destroy(handle)` from
`finally`; an identity-collision error is evidence that an older instance still
owns that key, not a signal to bypass runtime identity checks.

Extra `env` values are string bindings delivered through the second argument of
the worker's `fetch(request, env, ctx)` handler. Read them from `env` (typed as
`WorkerEnv`), not from Node's `process.env`.

A resolved `runtime.createEntity` call proves that the host accepted the env
configuration and started the worker. It does not prove that the running worker
observed a value. For an end-to-end check, expose one intentionally non-secret
probe from the worker under test and call it through the returned `targetId`:

```ts
import {
  createWorkerRuntime,
  handleWorkerRpc,
  type ExecutionContext,
  type WorkerEnv,
} from "@workspace/runtime/worker";

let exposedForWorker: string | null = null;

export default {
  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext) {
    const runtime = createWorkerRuntime(env);
    if (exposedForWorker !== env.WORKER_ID) {
      runtime.rpc.expose("observeConfiguredValue", () => ({
        value:
          typeof env["NON_SECRET_PROBE"] === "string"
            ? env["NON_SECRET_PROBE"]
            : null,
      }));
      exposedForWorker = env.WORKER_ID;
    }
    const rpcResponse = handleWorkerRpc(runtime, request);
    if (rpcResponse) return rpcResponse;
    return new Response("ready");
  },
};
```

```ts
const observed = await rpc.call<{ value: string | null }>(
  handle.targetId,
  "observeConfiguredValue",
  [],
);
if (observed.value !== "configured") throw new Error("Worker env mismatch");
```

Keep a probe narrow and remove it from production code. Never expose the full
`env` object or accept an arbitrary key: env may contain bearer tokens and other
secrets. Do not add env fields to `runtime.listEntities` or entity handles.

## Userland Services

Read [`skills/capabilities/SKILL.md`](../capabilities/SKILL.md) before exposing or
consuming a service. Workspace service declarations are resolved from the exact
caller's live semantic `meta/vibestudio.yml`; the same declaration set feeds live
service/API docs. They are deliberately not compiled into a static product census.

Worker package.json only carries `vibestudio.durable.classes` (workerd binding).
Workspace-level singletons, services, and HTTP routes live in
`meta/vibestudio.yml`. Resolve services by name/protocol through
`workers.resolveService(...)`; do not hardcode `workers/foo`, DO class names,
or `/_r/w/...` paths in callers. Before starting an eval, use the agent tools
`docs_search`/`docs_open` when the live contract is not already known. They are not
exports from `@workspace/runtime`; inside eval, use the documented `workers.*` and
`rpc.*` runtime APIs. `workers.listServices()` rows for workspace-owned services
include a `docsId` for that same live catalog; pass that id to the agent's
`docs_open` tool instead of scanning the provider source for methods. A declaration
in another context is neither visible nor callable here.

The receiver method and target route are separate authority layers:

- An unprotected receiver method declares `effect: { kind: "open" }`.
- A provider-owned protected method declares a literal
  `effect: { kind: "userland-capability", ... }` matching its package's
  `authority.provides`.
- Resolving a `meta/vibestudio.yml` service independently contributes the exact
  `workspace-service:<name>` target requirement from that live declaration.
- A lifecycle-owned, context-local DO addressed through
  `workers.resolveDurableObject(source, className, objectKey)` has no service
  target requirement; its method effect and lifecycle/context ownership still
  apply.

Prefer the declared-service route for application APIs. Use direct resolution
only for objects whose lifecycle the caller explicitly owns, such as a
disposable development probe, and retire/clear them when finished.

If installed code consumes the service, declare an exact
`workspace-service:<name>` request in its authority manifest. The request may precede
the provider's presence in this checkout; build-time service enumeration is not the
authority boundary. Runtime resolution still requires a matching live declaration,
exact provider EV, caller-context visibility, and grant. Never use
`workspace-service:*` in an installed-unit request or add the service to a generated
host authority catalog.

Declare worker registry dependencies and Build V2-owned override or patch
policy according to [external dependency resolution](DEPENDENCIES.md). Never
use top-level package-manager resolution fields in a worker package.

**Singleton Durable Object-backed service** — when callers should resolve one
fixed default object, add both declarations to `workspace/meta/vibestudio.yml`:

```yaml
singletonObjects:
  - source: workers/my-store
    className: MyStore
    key: main

services:
  - source: workers/my-store
    name: my-store
    title: My store
    action: read or update stored items
    description: Keep shared application data in this workspace.
    notability: everyday
    presentation: { domain: automation, verb: manage }
    protocols: [example.my-store.v1]
    authority:
      principals: [user, code]
    durableObject: { className: MyStore } # key joined from singletonObjects
```

Resolve and call it:

```ts
const svc = await workers.resolveService("example.my-store.v1");
if (svc.kind !== "durable-object") throw new Error("Expected DO service");
await rpc.call(svc.targetId, "methodName", [arg]);
```

The executable consumer must declare the service route in its own
`package.json`; create this together with the call rather than waiting for the
first build to discover it:

```json
{
  "vibestudio": {
    "authority": {
      "requests": [
        {
          "capability": "workspace-service:my-store",
          "resource": { "kind": "prefix", "prefix": "" },
          "tier": "gated",
          "evidence": "intentional-broad"
        }
      ],
      "serviceRequests": [
        { "protocol": "example.my-store.v1", "availability": "required" }
      ],
      "provides": []
    }
  }
}
```

If a provider method also declares a protected provider-owned capability, add
that separately using the exact capability reported by live docs. Do not add a
fake dependency package or wildcard to silence the verifier.

**Stateless worker service** — add to `meta/vibestudio.yml`:

```yaml
routes:
  - source: workers/my-api
    path: /api
    worker: true

services:
  - source: workers/my-api
    name: my-api
    title: My API
    action: use the workspace API
    description: Run workspace-local API operations.
    notability: everyday
    presentation: { domain: automation, verb: act }
    protocols: [example.my-api.v1]
    authority:
      principals: [user, code]
    worker: { routePath: /api }
```

Resolve and fetch it:

```ts
const svc = await workers.resolveService("example.my-api.v1");
if (svc.kind !== "worker") throw new Error("Expected worker service");
await gatewayFetch(`${svc.routeBasePath}/jobs`, {
  method: "POST",
  body: JSON.stringify(payload),
});
```

A `routes[].durableObject` declaration requires a matching `singletonObjects`
row because an HTTP route has no object-key input. A
`services[].durableObject` declaration without a matching row is a factory;
callers must pass an explicit `objectKey` to `workers.resolveService`.
Stateless service routes are live only while the canonical worker instance is
running.

## Durable Object-backed App Databases

Use a Durable Object as the default database for user-facing workspace apps,
panels, and long-lived agent workflows when data must be shared outside one
agent eval. The eval `db` is private to that agent's EvalDO; it is good for
scratch analysis and resumable diagnostics, but it is not an application
database for panels, apps, workers, or other agents.

When building a panel with a DO store, create both together with
`createProjects` so the user sees one approval prompt:

```ts
eval({
  code: `
  import { createProjects } from "@workspace-skills/workspace-dev";
  scope.created = await createProjects([
    { projectType: "worker", name: "todo-store", title: "Todo Store", template: "durable-service" },
    { projectType: "panel", name: "todo-app", title: "Todo App" },
  ]);
  return scope.created;
`,
});
```

Canonical shape:

1. Create `workers/<store>` with a `DurableObjectBase` subclass (or create it
   together with its panel via `createProjects`).
2. Store durable rows in the DO's SQLite database through `this.sql`.
3. Expose narrow app methods with explicit
   `@rpc({ website, principals, effect: { kind: "open" }, tier, sensitivity })`
   contracts; the effect must be a literal object so the exact build can document it
   without executing provider code. Do not expose a
   raw SQL console to normal UI callers.
4. Declare a `services:` entry in `meta/vibestudio.yml` with the principal
   families that may resolve the service.
5. Call it from eval, panels, inline UI, apps, workers, or other DOs with
   `workers.resolveService(protocol, objectKey?)` and `rpc.call(...)`.

Minimal store:

```ts
import { DurableObjectBase, rpc } from "@workspace/runtime/worker/kernel";

type TodoRow = {
  id: string;
  title: string;
  done: number;
  updated_at: string;
};

export class TodoStore extends DurableObjectBase {
  static override schemaVersion = 1;

  protected override schemaProductionBaseline() {
    return { version: 1, name: "todo-store-v1" } as const;
  }

  protected override createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `);
  }

  protected override requiredTables(): readonly string[] {
    return ["todos"];
  }

  @rpc({
    website: { kind: "closed", reason: "Todo data is private to the installed app." },
    principals: ["user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  upsertTodo(input: { id?: string; title: string; done?: boolean }): {
    id: string;
  } {
    this.ensureReady();
    const id = input.id ?? crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO todos (id, title, done, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         done = excluded.done,
         updated_at = excluded.updated_at`,
      id,
      input.title,
      input.done ? 1 : 0,
      new Date().toISOString(),
    );
    return { id };
  }

  @rpc({
    website: { kind: "closed", reason: "Todo data is private to the installed app." },
    principals: ["user", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  listTodos(): Array<{
    id: string;
    title: string;
    done: boolean;
    updatedAt: string;
  }> {
    this.ensureReady();
    return this.sql
      .exec<TodoRow>(`SELECT * FROM todos ORDER BY updated_at DESC`)
      .toArray()
      .map((row) => ({
        id: row.id,
        title: row.title,
        done: row.done === 1,
        updatedAt: row.updated_at,
      }));
  }
}
```

Application-defined protocols are declared in `meta/vibestudio.yml`; do not
add `vibestudio.durable.classes[].rpcSchema` for them. `rpcSchema` selects one
of the small host-owned, reviewed schemas built into the host and an arbitrary
application protocol name will fail the build as unknown. The `durable-service`
scaffold deliberately declares only `{ className }`.

### Keep the activation kernel small

`DurableObjectBase` is the storage, RPC, and lifecycle kernel. Import it from
`@workspace/runtime/worker/kernel` for ordinary services. Import narrow worker
entry points when another shared package offers them; a package barrel can
retain every exported feature in the eager worker graph even when source code
only names one export.

Use `PanelDurableObjectBase` from
`@workspace/runtime/worker/panel-durable-base` only when the DO itself calls
the protected panel-tree helpers (`createPanelSlot`, `openPanel`,
`getPanelHandle`, or `panelTree`). Those facilities intentionally live outside
the base kernel so non-panel workers do not parse and initialize panel-runtime
code during activation.

Keep expensive capability families behind literal dynamic imports. A worker
may expose packages to eval while keeping them out of its activation bundle:
the generated runtime preloads the exact required feature chunk before running
otherwise-synchronous eval code. Do not recreate a synchronous registry or a
root-barrel import to make lazy code convenient; that silently folds parsers,
schema libraries, and runtime catalogs back into every activation.

Choose the service's object identity deliberately. A `singletonObjects` row
gives it one fixed default object key (`main` below). Use that for one
workspace-wide coordination atom. Omit the row for a factory service and have
every caller pass the appropriate per-project, per-account, or per-document
`objectKey`.

```yaml
singletonObjects:
  - source: workers/todo-store
    className: TodoStore
    key: main

services:
  - source: workers/todo-store
    name: todo-store
    title: Todo Store
    protocols: [example.todos.v1]
    authority:
      principals: [user, code]
    durableObject:
      className: TodoStore
```

Call it from eval, a panel, an inline UI component, an app, a worker, or
another DO:

```ts
import { rpc, workers } from "@workspace/runtime";

const svc = await workers.resolveService("example.todos.v1");
if (svc.kind !== "durable-object") throw new Error("Expected DO service");

await rpc.call(svc.targetId, "upsertTodo", [{ title: "Write storage docs" }]);
const todos = await rpc.call(svc.targetId, "listTodos", []);
```

For a partitioned store, use the optional second argument:

```ts
const projectStore = await workers.resolveService(
  "example.todos.v1",
  projectId,
);
```

That resolves `do:<source>:<className>:<projectId>` and creates or activates a
separate SQLite database for that object key. Use stable, user-meaningful keys
such as workspace id, project id, document id, or account id. Do not use a
random key unless the app really wants a new isolated database.

The declaration and receiver must both admit the caller:

- `services[].authority` controls which authenticated principal families may
  resolve the service in this exact context.
- Each method's `@rpc` contract independently enforces principals, tier,
  receiver relationships, and the concrete resource. A provider-owned protected
  method binds a `userland-capability` effect to a definition in the provider
  package's `authority.provides`; the host acquires authority before entering
  provider code.

For a running Vibestudio system—including agent eval—exercise the real object
through `workers.resolveService(...)` / `workers.resolveDurableObject(...)` and
separate `rpc.call(...)` calls as shown above. This is the integration path: it
uses workerd, the live declaration, the method's `@rpc` authority contract,
and the object's persistent SQLite database.

RPC exposure belongs to the exact active provider build, not merely to the
source currently visible in the workspace. After adding or changing an exposed
method on an existing declared service, first verify the context candidate, then
commit the provider edits and publish that repository. Wait for publication to
finish, resolve the service again, and only then call the changed method. A green
`verify` result does not update protected main or the live service. A
`WORKSPACE_RPC_METHOD_UNDECLARED` failure reports both active and recently
verified candidate provenance when available, plus the exact publication
recovery; do not bypass it with raw addressing.

Prefer `resolveService(...)` whenever a service exists. Raw
`resolveDurableObject(...)` may address workspace worker DO classes, but
host-internal DOs are not workspace targets and remain inaccessible.
Workspace-built DOs are admitted dynamically from the caller's live semantic
declarations and still require exact source/class/object-key receiver authority.
An exported class is not a class-wide grant, and another key is another resource.

For fast Vitest-only unit coverage, keep storage logic in methods like the above
and use `createTestDO(...)` in a co-located worker test. That helper is
intentionally test-only: it creates an in-memory sql.js-backed object in the
test process and does not exercise service resolution, workerd persistence, or
the RPC/policy boundary. Do not import `createTestDO` from agent eval or
production panel/worker/DO code.

## Durable Object current schema

`DurableObjectBase` owns a deliberately current-only SQLite lifecycle.
`createTables()` declares the complete fresh shape and `schemaVersion` names
that one shape. A truly empty store is initialized atomically. Every later open
must match the exact version and required table shape; any older, newer,
unversioned, or drifted store is rejected unchanged with
`DO_SCHEMA_INCOMPATIBLE`.

This pre-release contract has no schema migration callbacks, baselines,
ledgers, or predecessor fixtures. When a shape changes, bump `schemaVersion`
and the coordinated `systemEpoch`, publish a fresh Base/template generation,
and recreate disposable internal state. Export valuable user-level facts
through the product's ordinary current interface before the cut. Never encode
schema compatibility in application rows or add an old-format reader.

`workers.resetStorage(target, intent)` remains an explicit destructive tool for
one disposable userland object. It is not an upgrade path. The operation fences
the exact object, verifies a backup, and returns its operation id; backup list
and restore operate only on that same current target.

## Durable Object RPC Exposure & Authorization

DO methods are reachable over RPC only when explicitly opted in, and the
workspace realm enforces a per-method caller policy (default-deny). Two layers,
kept separate — both required. Full design: [`docs/capability-approval-design.md`](../../../docs/capability-approval-design.md).

### Layer 1 — `@rpc` exposure (which methods are callable)

A method with no `@rpc` is private to the DO and cannot be invoked over the
relay; forgetting `@rpc` fails loud ("not exposed"). Mark every method a caller
should reach.

### Layer 2 — `@rpc({ website, principals, effect, tier, sensitivity })` receiver policy

The RPC relay is open between authenticated participants, so the recipient must
gate. Every relay-reachable workspace method declares the authenticated principal
families it accepts (`"host" | "user" | "code"`), its effect, reviewed tier, and
sensitivity. Each receiver also makes the mandatory independent website choice:
`eligible` with a rationale or `closed` with a concrete reason. Eligibility
does not grant authority; connected websites must still satisfy the actual
resource and disclosure contract. See [website authority](../capabilities/references/website-authority.md).
Missing policy is default-deny. An unprotected workspace service
method uses literal `effect: { kind: "open" }`; the live service declaration
adds its independent target requirement. A provider-owned protected method uses
a literal `userland-capability` effect matching `authority.provides`. Keep the
effect literal because live docs are extracted from the exact source build
without executing that source.

```ts
import { DurableObjectBase, rpc } from "@workspace/runtime/worker/kernel";

export class MyStoreDO extends DurableObjectBase {
  protected override schemaProductionBaseline() {
    return { version: 1, name: "my-store-v1" } as const;
  }

  @rpc({ website: { kind: "closed", reason: "Workspace data is not exposed to websites." }, principals: ["user", "code"], effect: { kind: "open" }, tier: "open", sensitivity: "write" })
  async addItem(label: string): Promise<{ id: string }> { ... }

  @rpc({ website: { kind: "closed", reason: "Host lifecycle traffic is not exposed to websites." }, principals: ["host"], effect: { kind: "open" }, tier: "open", sensitivity: "write" })
  async onWebhookDelivery(event: WebhookEvent): Promise<void> { ... }

  private bumpCounter(): void { ... }       // no @rpc — unreachable over RPC
}
```

Use `user` for direct user/session actions, `code` for installed workspace code and
agents, and `host` only for trusted host lifecycle traffic. Listing a principal is
only the receiver floor: the caller's sealed manifest, live grant, mission/context
constraints, and service admission still have to agree.

Methods are local to their workspace unless the exact declaration also sets
`crossWorkspace: true`. A foreign caller selects the destination on the ordinary
RPC call:

```ts
@rpc({
  website: { kind: "closed", reason: "This integration is restricted to explicitly authorized workspace callers." },
  principals: ["code"],
  effect: { kind: "open" },
  tier: "open",
  sensitivity: "read",
  crossWorkspace: true,
})
async listAvailableSlots(): Promise<string[]> { ... }

const slots = await rpc.call(storeTargetId, "listAvailableSlots", [], {
  destination: { kind: "workspace", workspaceId: personalWorkspaceId },
});
```

This declaration only exposes the receiver. The user's governing outgoing and
incoming workspace policies must both admit the exact destination, target and
method before any ordinary service or capability approval is considered. System
does not accept cross-workspace application ingress. Do not add a second export
manifest, copy a remote handle into the local workspace, or use a context ID as
a workspace selector.

### Identity-level tightening (inline)

The kind floor is coarse — _any_ DO is `"do"`. When a method must accept only ONE
specific caller (this agent's own EvalDO, the agent's own PubSubChannel, a known
class), add an inline check ON TOP of the floor using the server-authenticated
caller, which cannot be forged:

```ts
@rpc({ website: { kind: "closed", reason: "Internal agent callbacks are not exposed to websites." }, principals: ["code"], effect: { kind: "open" }, tier: "open", sensitivity: "write" })
async onChannelOp(channelId: string): Promise<void> {
  await this.assertOwnEvalCaller(channelId); // only THIS agent's own EvalDO
  ...
}
// this.rpcCallerId / this.rpcCallerKind / this.caller are server-set from the
// validated token. Every DO, including server-realm DOs, uses @rpc authority.
```

### When to declare a userland capability

Reachability answers whether the caller may enter the method. For a
userland-owned sensitive resource, declare its authority at that receiver:

- **Built-in host actions** (credentials, external opens, git writes, project
  imports, webhooks, publishing main, spawning workers): call the existing
  runtime API and let its receiver acquire the host capability.
- **Custom shared resources** exposed to other userland callers: declare a
  capability in `vibestudio.authority.provides` and bind the method to its
  unit-local name with a `userland-capability` effect.

Never prompt inside provider code or invent a second grant store. The host owns
acquisition, persistence, scope, and revocation.

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
initial use grant. For provider secrets/config, use
`credentials.configureClient()` and pass `clientConfigId`.

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

Use `type: "oauth2-device-code"` when redirect-based flows can't reach the
server — providers that won't accept a Tailscale `*.ts.net` redirect URI,
headless installs, or when the user wants to authorize on a different device.
The server displays the `user_code` on the trusted approval bar while it
polls the token endpoint. See [api-integrations
SKILL.md](../api-integrations/SKILL.md#device-code-flow) for the full
provider compatibility matrix.

## Use

```ts
await credentials.fetch("https://api.example.com/v1/items", undefined, {
  credentialId: stored.id,
});
```

## Userland capability definitions

Every executable package authority manifest contains both `requests` and
`provides`. `requests` is the maximum host or workspace-service authority that
the unit may exercise; `provides` names protected resources owned by the unit.
Each provided definition supplies the user-facing title/action, tier,
sensitivity, resource type, reviewed `presentation.domain` /
`presentation.verb`, `notability`, and allowed grant scopes. The domain and verb
come from the shared authority vocabulary; userland providers cannot declare the
Safety controls domain.

`notability` is required and answers one question: would a reasonable
non-technical person, told a part can do this, want to know before adding it?
Answer `"headline"` if so, `"everyday"` if this is ordinary machinery of being a
part here. It decides what a user reads first on every install and creation
review, so the honest answer is the useful one — marking everything headline
makes every part read like a threat, and the platform will promote a `critical`
or `destructive` definition to headline regardless of what you write.

Your declaration is a ceiling and a vocabulary, never a licence. The platform may
make a request more contextual than you asked for — `admin` and `destructive`
capabilities always ask at concrete use — and never less.

Bind a Durable Object receiver to a provided unit-local name:

```ts
@rpc({
  website: { kind: "closed", reason: "This integration is restricted to explicitly authorized workspace callers." },
  principals: ["code"],
  effect: {
    kind: "userland-capability",
    capability: "calendar.write",
    resource: { kind: "receiver-object" },
  },
  tier: "gated",
  sensitivity: "write",
})
async createCalendarEvent(input: CalendarEventInput): Promise<void> {
  // Authority has already been acquired for this exact provider/object.
}
```

The host validates the literal effect against the exact provider manifest and
effective version before dispatch. For prepared private state, use the
opaque-handle pattern documented in
[`skills/capabilities/SKILL.md`](../capabilities/SKILL.md); never pass a private
selector to a caller or treat a handle as permission.

## Agent Debug Port

Use GAD first for durable trajectory state, then the agent's activation-local
debug snapshot when a channel appears stuck:

```ts
const health = await gad.inspectAgentHealth({ channelId: chat.channelId });
const debug = await chat.callMethod(agentParticipantId, "getDebugState", {});
console.log(JSON.stringify(debug, null, 2).slice(0, 4000));
```

`getDebugState` contains only already-loaded loop state plus local SQLite
outboxes. A loop with `loaded: false` is not hydrated through GAD; use `health`
for the durable answer. See `../../../docs/agent-debug-port.md` for the exact
contract.

`chat.callMethod` is scoped to the current channel. To inspect a standard agent
debug method for another channel, resolve that channel's DO and use its
read-only inspection path:

```ts
const channel = await workers.resolveService(
  "vibestudio.channel.v1",
  targetChannelId,
);
const debug = await rpc.call(channel.targetId, "inspectAgent", [
  agentParticipantId,
  "getDebugState",
]);
```

The channel DO only exposes `getDebugState`, `getAgentSettings`, and
`inspectMethodSuspensions` through this route. It resolves the exact entity,
uses a dedicated read-only agent RPC rather than `onMethodCall`, and bounds the
probe to five seconds. A retired agent fails before inspection dispatch.

## Host Server Logs

Use the exact identity returned by `runtime.supervision.list()` with
`runtime.supervision.logs(identity)` or `health(identity)` for the panel,
worker, DO, extension, or app execution itself. Use `serverLog` when the
failure may be in the workspace server around that unit: build/reconcile,
workerd supervision, routing, RPC dispatch, gateway reconnects, idle exit, or
startup/shutdown.

```ts
const recent = await rpc.call("main", "serverLog.query", [
  { level: "warn", limit: 100 },
]);
const build = await rpc.call("main", "serverLog.query", [
  { tag: "BuildV2", limit: 100 },
]);
```

For live following, open `about/server-logs` or subscribe to
`server-log:append` as documented in `../server-logs/SKILL.md`.

## Blobstore (content-addressable bytes)

The per-workspace blobstore stores arbitrary content keyed by sha256 digest.
Use it for anything large or binary — model outputs, fetched documents,
generated artifacts, the object layer for a custom git-like format.

**Metadata via RPC** (uses the worker's existing `RPC_AUTH_TOKEN` automatically):

```ts
const exists = await callMain("blobstore.has", digest);
const meta = await callMain("blobstore.stat", digest); // { size, mtime } | null
```

**Streaming binary I/O via the gateway**:

```ts
// Writes are streaming — pass any Readable / ReadableStream as the body.
const put = await runtime.gatewayFetch("/_r/s/blobstore/blob", {
  method: "PUT",
  body,
});
const { digest, size } = await put.json();

const get = await runtime.gatewayFetch(`/_r/s/blobstore/blob/${digest}`);
// `get.body` is a ReadableStream of the original bytes.
```

`gatewayFetch` resolves a relative path against `GATEWAY_URL` and authenticates
that gateway request with the worker's bearer. An absolute URL is also accepted
when it has that exact gateway origin; a cross-origin URL is rejected before
the bearer can be sent. For external HTTP, use `credentials.fetch` rather than
`gatewayFetch`. Worker tokens are minted from the central `TokenManager`, so
the route's `caller-token` auth admits them.

`blobstore.delete` and `blobstore.list` are restricted to shell/server callers
and cannot be invoked from a worker — design the upper layer (e.g. a server
service) to own GC.

See [`docs/architecture/storage.md`](../../../docs/architecture/storage.md#blobstore-content-addressable-objects)
for the full design.
