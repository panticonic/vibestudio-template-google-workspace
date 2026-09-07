# Authoring an Extension

## Workspace layout

```
workspace/extensions/
└── hello/
    ├── package.json                   # manifest with vibestudio.extension
    └── index.ts                       # entry — exports activate(ctx)
```

The directory layout matches `workspace/panels/` and `workspace/workers/`. Each extension is a workspace unit; the build graph discovers it via the `vibestudio.extension` block in `package.json`.

External extensions clone into the same tree at install time. There is no per-user installed/ directory.

## Manifest

```json
{
  "name": "@workspace-extensions/hello",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "vibestudio": {
    "displayName": "Hello",
    "icon": "👋",
    "entry": "index.ts",
    "sourcemap": true,
    "extension": {
      "activationEvents": ["*"],
      "dependencyMode": "auto"
    },
    "dependencyResolution": {
      "overrides": {
        "problem-dependency": "1.2.3"
      }
    }
  },
  "dependencies": {
    "@workspace/runtime": "workspace:*"
  }
}
```

### Required fields

| Field                                   | Notes                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                                  | Convention: `@workspace-extensions/<short-name>` for workspace-internal extensions. Used as the install key and the argument to `extensions.use(...)`. |
| `type`                                  | Must be `"module"`. Extensions are loaded as ESM.                                                                                                      |
| `private`                               | Must be `true`. Workspace-internal packages are not publishable.                                                                                       |
| `vibestudio.entry`                      | Source entry, default `index.ts`. The TypeScript source is what ships — the build produces the bundle.                                                 |
| `vibestudio.sourcemap`                  | Must be `true` in v1 (inline maps; the build refuses to disable them).                                                                                 |
| `vibestudio.extension`                  | Block presence marks the unit as an extension. Must be the only kind-block (no `vibestudio.worker` or `vibestudio.panel` alongside it).                |
| `vibestudio.extension.activationEvents` | Exactly `["*"]` (start with the workspace) or `["onInvoke"]` (build after approval, start on first use).                                               |

### External dependencies

Declare external packages and all Build V2-owned override or patch policy as
described in [workspace dependency resolution](../workspace-dev/DEPENDENCIES.md).
Do not use package-manager resolution fields. Extension patches affect the
build dependency environment and, when a declared root remains external, the
derived runtime install. Dependency policy is part of both cache identities, so
changing an override or patch creates a fresh environment.

### Optional fields

| Field                                 | Default      | Notes                                                                                                                                  |
| ------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `vibestudio.displayName`              | package name | Human-readable name shown in the units panel.                                                                                          |
| `vibestudio.icon`                     | kind icon    | Identity chosen with the shared [icon guide](../workspace-dev/references/icons.md): curated Lucide concept, truthful brand mark, emoji, or repo-local image (maximum 1 MiB). |
| `vibestudio.extension.dependencyMode` | `"auto"`     | `"auto"` bundles plain JS deps, externalizes native/WASM ones. `"bundle"` forces bundling. `"external"` forces runtime install + load. |

Use `activationEvents: ["onInvoke"]` for extensions whose API is only needed on
demand, especially extensions that start native child processes or consume
substantial memory. Invocation waits for that extension's own activation or
crash recovery. It does not start unrelated extensions and it does not replay a
failed method call, which preserves non-idempotent API semantics. Use `["*"]`
only when the extension must continuously provide background behavior before
any caller invokes it.

### Validation

The manifest is validated at three points (`@vibestudio/shared/unitManifest`):

1. **Build** — refuse to produce a bundle if the manifest is malformed.
2. **Install** — refuse to record a registry entry before asking the user to approve.
3. **Boot** — refuse to activate a previously-installed extension whose on-disk manifest has drifted.

Validation failures throw `UnitManifestError` with a machine-readable `code` (e.g. `MANIFEST_KIND`, `MANIFEST_ACTIVATION`). The error is recorded in `RegistryEntry.lastError` and the extension stays in `error` until the manifest is fixed.

## `activate(ctx)`

```ts
import type { ExtensionContext, Disposable } from "@vibestudio/extension";

export interface HelloApi {
  greet(name: string): Promise<string>;
}

export async function activate(ctx: ExtensionContext): Promise<HelloApi> {
  ctx.log.info("hello activating", { version: ctx.version });

  // Per-extension scratch — confined to {userData}/extensions/storage/<workspaceId>/<name>/
  await ctx.storage.mkdir("cache");

  // Subscriptions accumulated here are disposed in LIFO order on deactivate.
  ctx.subscriptions.push({
    dispose() {
      /* cleanup */
    },
  });

  return {
    async greet(name) {
      return `hello, ${name}`;
    },
  };
}

// Optional. Called on shutdown / reload. Subscriptions are auto-disposed; use
// this for explicit teardown (closing sockets, flushing buffers, etc).
export async function deactivate(): Promise<void> {}
```

### The API contract

`activate` returns a plain object. The host serves RPC calls by resolving methods at invocation time, not by registering them at activation time:

- A method is callable iff `Object.hasOwn(api, method) && typeof api[method] === "function"`.
- Inherited prototype methods, `then`, `constructor`, `toJSON`, `inspect`, and non-function properties are all skipped.
- Calls to unknown methods return `ENOMETHOD`.
- Method args/return are JSON-serializable. Binary payloads ride a base64 envelope automatically; streams need explicit handling (see the canaries for examples).

Returning `void` is valid — the extension is then fire-and-forget (only useful for side effects, e.g. registering event handlers).

### `ctx.*` surface

Today's surface (mirrors what panels and workers see; will narrow as capabilities migrate):

| Client                     | Use                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `ctx.name`, `ctx.version`  | Extension identity                                                                                |
| `ctx.storage`              | Per-extension scratch directory (path-scoped to the storage root)                                 |
| `ctx.fs`                   | **Unrestricted** filesystem RPC — for auditable writes                                            |
| `ctx.git`                  | Canonical typed external Git client (`gitInterop.*`)                                              |
| `ctx.workspace`            | Workspace info (`getInfo`, etc.)                                                                  |
| `ctx.rpc`                  | `call(targetId, method, ...args)` for unified RPC targets                                         |
| `ctx.workers`              | Workspace service/DO discovery (`listServices`, `resolveService`, `resolveDurableObject`)         |
| `ctx.credentials`          | Stored credentials (OAuth tokens, secrets)                                                        |
| `ctx.webhooks`             | Webhook ingress (`webhookIngress` service)                                                        |
| `ctx.notifications`        | `show`/`dismiss` notifications in the shell                                                       |
| `ctx.extensions`           | Call other extensions (`use`, `on`, `list`, management methods)                                   |
| `ctx.invocation.current()` | The current `ExtensionInvocation` envelope, including the verified caller and chained `contextId` |
| `ctx.subscriptions`        | Push `Disposable`s; auto-disposed LIFO on deactivate                                              |
| `ctx.log`                  | Structured logger (`debug`/`info`/`warn`/`error`)                                                 |
| `ctx.health`               | Self-report operational health (`healthy`/`degraded`/`unhealthy`)                                 |
| `ctx.emit(event, payload)` | Fan-out to `extensions.on(name, event, cb)` subscribers                                           |

### What's _not_ on `ctx.*`

- `ctx.panel` — the host panel orchestration service is shell-only; extensions cannot create or close panels in v1.
- `ctx.db` — no general-purpose DB service exists. Prefer a manifest-declared service and `ctx.workers.resolveService(...)` plus `ctx.rpc.call(targetId, ...)` for shared DO-backed storage, or `ctx.storage` for scratch. Raw `resolveDurableObject(...)` accepts workspace worker classes; host-internal DOs are not workspace targets and cannot be reached by guessing a class or object key.

If you find yourself wanting either, the right move is usually a new extension behind `ctx.extensions.use(...)`.

### Raw Node

```ts
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";

export async function activate() {
  // Raw Node writes follow the workspace's native resource admission.
  // They do not create per-call capability prompts or semantic VCS edits.
  await fs.writeFile("/tmp/extension-cache", "...");
  return {
    /* api */
  };
}
```

Raw Node effects follow the existing native execution contract: Unix MXC exposes
the workspace's selected filesystem resources with ordinary networking; Windows
runs with the application's OS-user permissions. Source admission is not a
per-invocation resource sandbox, and contexts do not isolate native commands from
other exposed resources in the same workspace. Use `ctx.fs` for managed semantic
source operations and their normal caller attribution and authority checks.

### Exact context folders — provision before reading raw disk

A caller's context working folder (`.context-projections/v6/{contextId}/`) is one
complete, authority-published projection of an exact semantic working head. It is
never a sparse checkout assembled repo by repo. A repository is absent only when
that exact state does not contain it; lifecycle ensure/fork and every semantic
mutation publish the complete repository set before returning.

This matters when your extension reads the context folder **outside `ctx.fs`** — a
ripgrep/find subprocess, `fs.createReadStream`, a recursive `fs.readdir`, etc.
Before that raw read, declare the **narrowest read intent** you need. The first
call provisions the complete exact context projection; the scope remains useful
for capability checks and audit semantics, not as a second partial projection path:

```ts
// Express what the extension intends to read; provisioning remains context-wide.
await ctx.fs.ensureMaterialized("panels/chat"); // one repo
await ctx.fs.ensureMaterialized("panels"); // a section (its repos)
await ctx.fs.ensureMaterialized(["packages/a", "packages/b"]); // a specific set
await ctx.fs.ensureMaterialized("all"); // ONLY for a true workspace-wide pass
// …then spawn rg / read the path on disk.
```

You do **not** need this for `ctx.fs.*` reads (`readFile`/`readdir`/`grep`/`glob`/…):
those ensure the exact context projection automatically. The explicit call is only
for code that touches the on-disk tree directly. Prefer the narrowest truthful
scope for authority and audit clarity; use `"all"` only for a genuine
workspace-wide read.

## Health

```ts
ctx.health.healthy();
ctx.health.degraded({ summary: "FCM credentials expired", retryAt: Date.now() + 60_000 });
ctx.health.unhealthy({ summary: "native libvips missing", reasons: ["dlopen failed: ..."] });
```

State is **operational** (is the extension doing its job), separate from
**lifecycle** status (is it running). A `running` extension can be `degraded`.
Select the extension's exact identity with
`runtime.supervision.list({ kind: "extension" })`; `describe(identity)` reports
lifecycle/artifact state and `health(identity)` reports operational state.

`detail` is required for `degraded` and `unhealthy`. `retryAt` (epoch ms), when set, lets the UI render a countdown.

The default state right after `activate()` resolves is `healthy` — you don't need to call `healthy()` explicitly unless you previously downgraded.

## Logs

```ts
ctx.log.info("processed", { count: 12, source: "github" });
ctx.log.warn("retrying", { attempt: 2 });
ctx.log.error("upstream failed", { code: "ETIMEDOUT" });
```

Records flow into the workspace-wide unit-log stream:

```ts
const [extension] = await runtime.supervision.list({ kind: "extension" });
const logs = await runtime.supervision.logs(extension.identity, {
  since: Date.now() - 60_000,
  level: "warn",
});
```

`console.*` is captured too (via stdout/stderr) and lands in the same stream with `source: "stdout"` / `"stderr"`. Prefer `ctx.log` for production records — the structured fields are searchable.

## Crash behavior

Each extension runs in its own forked Node process. Crashes are contained to that process. The manager respawns with exponential backoff: `1s, 2s, 4s, 8s, 16s`. After five attempts in a 60-second window, the extension is marked `error` and won't restart until `extensions.reload(name)` is called explicitly.

If `activate(ctx)` throws, the extension is marked `error` immediately — no
respawn. A bad manifest, missing dependency, or assertion in your activation
path will land you here. Inspect the exact extension with
`runtime.supervision.describe(identity)` for `lastError`, then push a fix.

## Templates

Four working scaffolds live at `docs/extensions/templates/`. Copy whichever matches your dependency shape and adjust:

| Template        | Use when                                                                |
| --------------- | ----------------------------------------------------------------------- |
| `minimal/`      | No external dependencies                                                |
| `plain-js-dep/` | Pure-JS npm dependency, safe to bundle                                  |
| `native-wasm/`  | Native or WASM dependency — let `dependencyMode: "auto"` externalize it |
| `external-cjs/` | CommonJS dependency that must load from `node_modules` at runtime       |
