# Migrating an in-host service to an extension

Vibestudio's host-substrate services (`src/server/services/*`) are the natural pool of migration candidates. The plan in `EXTENSIONS.md` (§ Migration candidates) lists them. The three landed canaries — `imageService`, `typecheckService`, `browserDataService` — define the pattern.

## Decision: should this service migrate?

A service is a good extension candidate when:

- It's a discrete capability (not core substrate like the dispatcher or approvals).
- Its callers reach it via `ctx.<name>` or via a worker/panel client — i.e. the call sites are already userland.
- It owns a non-trivial dependency (native addon, large in-memory state, optional network capability).
- Failure of the service should not bring the server down.

Stays in-host:

- Dispatcher, token manager, approval queue — these are the substrate extensions depend on.
- `auditService` — its value depends on being non-optional.
- Build pipeline — it's what builds extensions.
- Panel/worker lifecycle services — they manage other unit kinds.
- Credential storage core (`credentialService`) — host-rooted trust.

When in doubt, check `EXTENSIONS.md` § "Must stay in-host" — that list is canonical.

## Pattern

The canary migrations all follow the same shape:

1. **Create the extension** at `workspace/extensions/<service-name>/`.
   - Copy the existing service handler code into `activate(ctx)` and return the public methods.
   - Replace `ctx: ServiceContext` references with `ctx: ExtensionContext` and access to `ctx.invocation.current()` for caller info.
   - Move dependency wiring from the server bootstrap into top-level imports.

2. **Delete the in-host service**:
   - Remove `src/server/services/<service>.ts` and its test file.
   - Remove the registration in `src/server/index.ts` (or `panelRuntimeRegistration.ts`).
   - Remove any `ctx.<name>` exposure from `workspace/packages/runtime/`.

3. **Codemod the consumers** — every `ctx.<name>.<method>(...)` (or `import { <name> } from "@workspace/runtime"`) becomes:

   ```ts
   import { extensions } from "@workspace/runtime";
   const svc = extensions.use<ApiType>("@workspace-extensions/<service>");
   await svc.<method>(...);
   ```

4. **Declare the extension** in the owning workspace's `meta/vibestudio.yml`
   under `extensions:`. Include it explicitly when publishing a workspace
   snapshot; selected source copying does not install configuration or grants.
   The runtime's ordinary unit review must approve it before execution.

5. **Add an integration test** at `tests/extension-<name>.integration.test.ts` that boots a real server, approves the joint unit approval, calls a representative method, and asserts the response matches the old service's contract.

## What changes for callers

- **API shape** stays the same. The codemod is a search-and-replace of the import + first call segment.
- **Authorization** moves from `policy.allowed` to manifest-declared
  `authority.provides` and per-method `extension.methodAuthority`. The
  dispatcher enforces the declaration before extension code runs. Host effects
  still cross their ordinary protected receivers.
- **First-call latency** picks up the install/approval round trip. After approval the extension stays running; subsequent calls are RPC-fast.
- **Failure isolation** improves: if the extension crashes, the host respawns it (1/2/4/8/16s backoff). The old in-host service would have brought down the server.

## What changes for the extension author

- **Dependencies** ship inside the extension repo. The host no longer brings them. This is usually a win (independent upgrade cadence) but means the host's `node_modules` shrinks.
- **State** lives in `ctx.storage` (per-extension scratch) instead of arbitrary
  host `{userData}` paths. `ctx.fs` exposes the admitted workspace filesystem,
  not a general host migration interface. Moving old host-owned data requires
  an explicit bounded host migration or user-selected import; do not widen the
  native resource admission to recover an old path.
- **Logs and health** are now structured: `ctx.log.info(..., { fields })` rather than `console.log`, `ctx.health.report(...)` for operational state.

## Concrete examples

### `imageService` → `@workspace-extensions/image-service`

- Wraps `photon-node` for image dimensions / format detection. Pure compute, no statefulness.
- Migration was mechanical: the in-host service was a thin RPC wrapper around `photon`. The extension does the same.
- Caller codemod: every `ctx.image.dimensions(bytes)` became `extensions.use<ImageApi>("@workspace-extensions/image-service").dimensions(bytes)`.
- Dependency mode: `auto` (photon is WASM-backed; `auto` externalizes it).

### `typecheckService` → `@workspace-extensions/typecheck-service`

- Long-running TypeScript language service per panel. Holds substantial in-memory state across many calls.
- Migration tested that an extension can be a long-running stateful service, not just stateless compute.
- The extension owns the TypeScript service helpers directly; only the neutral npm-install helper remains shared.
- Path validation moved into the extension — the old service-level `policy.allowed` is replaced by per-method input validation.

### `browserDataService` → `@workspace-extensions/browser-data`

- Wraps a `BrowserDataDO` (a workerd Durable Object) for bookmarks/history/cookies.
- The extension owns the public API and any shell-only enforcement; the DO still stores the data.
- Pattern for "extension wraps a DO": declare a workspace service and use
  `ctx.workers.resolveService(protocol, key)`, then
  `ctx.rpc.call(targetId, method, ...args)` through unified RPC. Do not route
  through any internal target catalog: the manifest-declared service and its
  exact singleton/provider effective version are the authority and identity
  boundary. Host-internal DOs are not workspace targets, and exporting a
  workspace DO class alone does not expose arbitrary instances.

## Migration checklist

- [ ] Confirm the service is on the migration list (or you've justified adding it).
- [ ] Create `workspace/extensions/<name>/` with manifest + `index.ts`.
- [ ] Copy handler logic, adjust `ctx` references.
- [ ] Delete the in-host service and its registration.
- [ ] Update every consumer (`ctx.<name>` → `extensions.use<ApiType>(name)`).
- [ ] Add an integration test that boots a real server.
- [ ] Declare the extension in the template repository's `meta/vibestudio.yml` (`extensions:`).
- [ ] Confirm `build.listUnits()` reports the declared extension as available,
      then select its exact live identity from
      `runtime.supervision.list({ kind: "extension" })` and verify
      `describe(identity).lastError` is `null`.
- [ ] Document the public API type (`export interface <Name>Api`) so consumers can `extensions.use<NameApi>(...)`.
