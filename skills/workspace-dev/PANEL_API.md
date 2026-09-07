# Panel API

Import panel APIs from `@workspace/runtime`. The same portable surface works in
panels, workers, Durable Objects, and server-side eval.

## The completion contract

Readiness-waiting panel operations have one meaning:

- `await createPanelSlot(...)` commits creation and returns the durable handle
  without requesting a presentation lease or waiting for activation, build, or
  boot. The panel remains unloaded until a consumer explicitly presents or
  inspects it.
  It is the receipt-oriented primitive for
  navigation workflows whose caller may have a shorter lifetime than the
  panel build. Its `CreatePanelSlotOptions` deliberately has no `focus` or
  readiness-affecting option.
- `await openPanel(...)`, `focus()`, `navigate()`, `reload()`, `rebuild()`, and
  `snapshot()`
  return only after the exact selected runtime attempt is application
  **boot-ready**. `focus: false` only suppresses presentation; `openPanel`
  still waits for readiness. The wait has no fixed deadline; `options.signal`
  is the caller-owned cancellation boundary.
- They never treat a lease, a registered WebContents/CDP target, `about:blank`,
  or a successfully generated HTML shell as application success.
- A resolve, build, host, navigation, bundle, or entry failure rejects with
  `PanelOperationError`. Do not infer success from a panel id or an empty
  snapshot.
- `snapshot()` then returns a capture tied to the attempt it read.

Internally, creation has two deliberate boundaries. The durable tree slot is
committed and becomes observable immediately; build preparation, host
assignment, navigation, and application boot then advance that slot through the
canonical phases. This prevents a slow or broken initial panel from blocking
tree discovery, owner seeding, or creation of unrelated panels. The public
`createPanelSlot(...)` exposes the committed boundary; `openPanel(...)`
composes it with the readiness wait and still waits for its own attempt to
reach `ready`. Readiness is observed once and then follows that exact
server-minted attempt through `awaitAttempt`; a ready observation resolves
without another sample, and failed/stopped observations reject immediately.

Execution activation is not presentation. Committing a code-panel slot emits a
level-triggered durable intent; the server execution reconciler owns the
reserved entity's activation, retries transient failures, and recovers
`preparing` reservations after restart. `createPanelSlot(...)` does not await
that work. `openPanel(...)` joins the same idempotent activation and then
materializes and waits for boot, so it reports activation failures while
preserving the already committed slot. Materialization must follow activation:
connection grants require the panel principal registered by that transition.
Activation itself does not allocate a renderer. Presentation
reconciliation advances only a lease that already exists; it never turns an
unloaded slot into a resident one.

Readiness-bearing operations also ensure presentation before they wait. This
uses the idempotent `panelRuntime.ensureSlot` transition for programmatic
runtimes, preferring the headless CDP host and falling back to a CDP-capable
desktop host. A native desktop focus bridge owns its local lease instead, so a
UI focus request does not move the panel to headless merely to satisfy an
observation. `unload()` releases the presentation lease but preserves the
durable slot and runtime entity; the next `focus()`, `openPanel()` wait,
navigation, reload, rebuild, snapshot, or CDP operation can materialize it
again. `observe()` itself is read-only and therefore reports the current
attempt and route without silently reacquiring resources.

The state combinations are intentional: a committed slot may have no lease;
a leased host may have no view while it is materializing; and a reconnecting
lease may be temporarily unreachable while its attempt remains durably ready.
A mobile lease is a valid visible presentation
but cannot satisfy programmatic inspection, so readiness-bearing programmatic
operations fail immediately with `host_unavailable`. Host materialization
failures are reported as terminal host failures, not left as an unbounded
pending wait; a later ensure can retry the failed host incarnation.
Terminal build, host, load, and boot states reject immediately with host
evidence, diagnostic id, and full attempt provenance—never with an apparently
successful blank handle. Preparation has no renderer and is not inferred from
elapsed time; activation is the explicit transition that allows a host to
materialize the real renderer.

This is intentionally stricter than browser “load” state. The generated panel
bootstrap reports `loading → booting → ready` and reports entry errors,
unhandled rejections, missing assets, and incomplete runtime configuration as
failures.

```ts
import { openPanel, PanelOperationError } from "@workspace/runtime";

try {
  const panel = await openPanel("panels/my-app", {
    focus: true,
    contextId: ctx.contextId,
    ref: `ctx:${ctx.contextId}`,
  });
  const observation = await panel.observe();
  const capture = await panel.snapshot();
  console.log(observation.buildKey, capture.document.text);
} catch (error) {
  if (error instanceof PanelOperationError) {
    console.error(error.failure.code, error.failure.stage);
    console.error(error.failure.message, error.failure.provenance);
    console.error(error.errorData.recovery);
  }
  throw error;
}
```

`PanelOperationError.errorData.recovery` is the retry contract. Source- and
build-correctable failures report `repair-and-rebuild`; runtime/host failures
report `observe-and-reacquire`. Do not blindly repeat the same lifecycle call.

## Discovery and creation

```ts
panelTree.self(): PanelHandle
panelTree.get(id): PanelHandle
panelTree.roots(input?): Promise<PanelRuntimeTreePage>
panelTree.rootOwners(input?): Promise<PanelRuntimeTreeRootOwnerPage>
panelTree.rootsForOwner(ownerUserId, input?): Promise<PanelRuntimeTreePage>
panelTree.children(parentSlotId, input?): Promise<PanelRuntimeTreePage>
panelTree.page(input): Promise<PanelRuntimeTreePage>
panelTree.path(id): Promise<PanelRuntimeTreePath | null>
panelTree.search(input): Promise<PanelRuntimeTreeSearchPage>
panelTree.parent(id): PanelHandle | null
panelTree.navigate(id, source, opts?): Promise<PanelObservation>
createPanelSlot(source, opts?): Promise<PanelHandle>
openPanel(source, opts?): Promise<PanelHandle>
```

The bounded discovery methods return page objects, not bare arrays:

```ts
type PanelRuntimeTreeRootOwnerPage = {
  revision: number;
  owners: Array<{ ownerUserId: string | null; rootCount: number }>;
  nextCursor: string | null;
};

type PanelRuntimeTreePage = {
  revision: number;
  group: { kind: "roots"; ownerUserId: string | null } | { kind: "children"; parentSlotId: string };
  entries: Array<{ node: PanelTreeNode; handle: PanelHandle }>;
  nextCursor: string | null;
};

type PanelRuntimeTreeSearchPage = {
  revision: number;
  hits: Array<{
    entry: { node: PanelTreeNode; handle: PanelHandle };
    ancestors: Array<{ node: PanelTreeNode; handle: PanelHandle }>;
    ancestorsTruncated?: boolean;
  }>;
  nextCursor: string | null;
};
```

When creation may be redelivered, pass the same non-empty `operationId` on
every attempt. Its durable identity includes `source`, `contextId`, `parentId`,
and `ref`, so reusing an operation id for a different logical open cannot alias
the original slot. An exact retry resumes the committed slot, including after
an ambiguous transport failure. `slug` and `operationId` are mutually
exclusive because each defines stable slot identity.

`self()` and `get()` are synchronous handle factories; they do no I/O.
Use `roots({ limit })` for the current verified caller's root panels. Ownership
is derived by the host; do not manufacture an `ownerUserId`. Cross-owner
workspace visibility is unchanged: use `rootOwners()` followed by
`rootsForOwner(ownerUserId, input?)` when the task spans another member's or
the ownerless workspace ownership band. Use bounded `children()`, `path()`,
and `search()` reads for addressed
navigation. `page()` remains available when constructing a discriminated
sibling group directly. There are deliberately no whole-tree or whole-sibling
reads. Continue from `nextCursor` only while the page revision is unchanged;
restart the group from its first page after a revision change. The scalar fields
`id`, `title`, `source`, `kind`, and `parentId` are the handle’s last observed
descriptor. `search({ query })` accepts plain text and matches indexed titles,
source paths, manifest descriptions/dependencies, tags, and keywords. Punctuation
separates terms rather than acting as query-language syntax, so a copied title
such as `vibestudio | Trello` is a valid query. Search includes committed slots
even when their runtime is not ready. Use `observe()` whenever correctness
depends on live runtime state.

Root groups are attribution bands, not access-control boundaries. A root whose
`ownerUserId` is the current user appears as **Your panels**; an ownerless root
appears as **Workspace**; other member ids appear under that member. Children
remain attached to their parent regardless of who created them. All groups are
workspace-visible unless an independent authority policy says otherwise.

```ts
let cursor: string | undefined;
do {
  const page = await panelTree.children(parentSlotId, {
    ...(cursor ? { cursor } : {}),
    limit: 100,
  });
  for (const { node, handle } of page.entries) {
    console.log(node.childCount, handle.id, handle.title);
  }
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

`openPanel(source)` uses main/pushed code. To run unpublished context code, pass
both the intended storage context and explicit code ref:

```ts
const panel = await openPanel("panels/my-app", {
  contextId: ctx.contextId,
  ref: `ctx:${ctx.contextId}`,
});
```

`contextId` alone selects storage/filesystem isolation; it never selects code
provenance.

When `contextId` is omitted, panel reservation mints a fresh context and
atomically records it as a lifecycle child of the verified creator's context.
The creator may inspect, automate, rebuild, or archive that panel without a
foreign-context approval, and destroying the creator context recursively
retires the panel context. When an installed extension performs the creation,
the extension remains the lifecycle deputy while the host-verified root
initiator owns the new context and supplies its human attribution. Ownership
never comes from extension input, and there is no caller-supplied owner/parent
field.

Passing an explicit `contextId` deliberately shares that existing semantic
context and does not re-parent it. This is the right form for context-local code
(`ref: "ctx:<id>"`) and for applications that intentionally share storage.
Use omission for an isolated panel world; use an explicit id only when sharing
is part of the design.

When parentage is implicit, the server resolves the caller's runtime lineage to
an open tree slot. Pass `parentId: null` for an owned root or an explicit open
slot id when that is the intended topology.

## Host commands

Use host commands for secondary panel actions that belong in application
chrome. A panel contributes intent once; each application host chooses an
idiomatic presentation. Desktop currently merges commands into its command
palette, while mobile presents them as native panel actions. The panel must not
render a second mobile-only header merely to expose the same actions.

For React panels, prefer the declarative hook from `@workspace/react`:

```tsx
import { useMemo } from "react";
import { useHostCommands } from "@workspace/react";
import type { HostCommand } from "@workspace/runtime";

function TaskPanel({ canRefresh }: { canRefresh: boolean }) {
  const commands = useMemo<HostCommand[]>(
    () => [
      { id: "task-new", label: "New task", group: "Tasks" },
      ...(canRefresh
        ? [
            {
              id: "task-refresh",
              label: "Refresh tasks",
              description: "Reload from the task service",
              group: "Tasks",
            },
          ]
        : []),
    ],
    [canRefresh]
  );

  useHostCommands(commands, (commandId) => {
    if (commandId === "task-new") openNewTaskDialog();
    if (commandId === "task-refresh") void refreshTasks();
  });

  return <TaskList />;
}
```

`HostCommand` has four fields:

| Field         | Contract                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | Required stable machine id, unique within this panel's contributed set. Keep it independent of translated or changing display copy. |
| `label`       | Required concise action label. Describe what selection does, not where a host currently renders it.                                 |
| `description` | Optional supporting copy. A host may shorten or omit it when space is constrained.                                                  |
| `group`       | Optional section label. A host may group, flatten, or omit sections according to its native interaction model.                      |

Registration is a complete replacement, not an append operation. Call
`useHostCommands` exactly once per panel runtime and compose every feature's
commands into that one array. Two hook calls can overwrite one another, and
one hook's cleanup can clear the other hook's contribution. Express disabled
or unavailable actions by omitting them from the current set; the contract has
no parallel enabled-state channel.

The hook re-contributes when command metadata changes, always invokes the
latest handler, unsubscribes from selections on unmount, and clears the panel's
contribution. Memoize state-derived command arrays so the ownership and update
boundary stays obvious. A command-capable host is not guaranteed: headless and
test hosts may present nothing, so essential workflows must remain operable in
panel content or through the panel's programmable API.

Non-React panel code can use the same panel-local contract imperatively:

```ts
import { panel, type HostCommand } from "@workspace/runtime";

const commands: HostCommand[] = [{ id: "task-refresh", label: "Refresh tasks", group: "Tasks" }];
const unsubscribe = panel.onHostCommandRun((commandId) => {
  if (commandId === "task-refresh") void refreshTasks();
});
panel.registerHostCommands(commands);

export function dispose() {
  unsubscribe();
  panel.unregisterHostCommands();
}
```

This is ephemeral host-local UI state. Contributions target the owning shell
and never become a server service, durable state, cross-panel broadcast, or
notification. The panel owns command ids, labels, current availability, and
the action implementation. The host owns keyboard/touch presentation,
placement, accessibility, and routing the selected id back to that same panel.
Do not put chat-, terminal-, or feature-specific branching in generic shell
code. If desktop and mobile need different visual controls for the same action,
share the panel behavior and keep only their renderers host-specific.

In tests, capture the `useHostCommands` arguments, assert the current command
set and stable ids, invoke the captured handler, and verify the panel action.
Shell routing tests belong to the host and should prove that every
`target: "shell"` envelope remains local and cannot fall through to a
server-backed panel session.

### Handing the user to the panel's agent

The inverse of a host command: a panel can open the shell's command overlay
bound to itself, optionally with the compose box pre-filled. Nothing is sent on
the panel's behalf — the user reads the request and presses send.

```ts
import { panel } from "@workspace/runtime";

await panel.openCommandAgent({
  prompt: "Make the due-date column sortable, then rebuild this panel.",
});
```

Under the hood this is the open host method `app.openShellSurface(target)`
(also `panel.openShellSurface(target)`), whose targets are:

| Target | Opens |
| --- | --- |
| `{ kind: "command-agent", panelId?, mode?, prompt? }` | the command overlay about a panel; the shell focuses that panel first so the overlay, the focused panel and the bound conversation agree |
| `{ kind: "about", page }` | an About page by id (`permissions`, `credentials`, `automations`, …) |
| `{ kind: "panel-command", panelId, commandId }` | a host command that panel contributed — routed exactly like a palette selection |
| `{ kind: "settings", section?: "connection" \| "devices" \| "profile" \| "appearance" \| "apps" \| "hosts" \| "templates" }`, `"workspace-chooser"` | management chrome |

`panel.describeShellSurfaces()` lists the kinds this host can open; offer only
those instead of probing. Hosts without shell chrome (headless server, some
clients) reject `openShellSurface` — treat that as an ordinary unavailable
feature, not a failure of the panel.

Every target also has a deep link for the same thing from outside a session —
`createShellSurfaceLink(target)` in `@vibestudio/shared/shellSurface` gives
`vibestudio://ask?…`, `vibestudio://about?…`, `vibestudio://command?…`,
`vibestudio://surface?…` (or the `https://vibestudio.app/…` share carrier).
Panels with state are reached by the sibling `vibestudio://panel?source=…`
link (`@vibestudio/shared/panelLocation`).

## One observation model

`await handle.observe()` is the cheap canonical status read:

```ts
interface PanelObservation {
  panelId: string;
  title: string;
  source: string;
  kind: "workspace" | "browser";
  parentId: string | null;
  contextId: string;
  requestedRef: string;
  runtimeEntityId: string | null;
  attemptId: string; // opaque coordinator-minted identity
  attemptRef: { epoch: string; attemptId: string };
  effectiveVersion: string | null;
  buildKey: string | null;
  phase: "pending" | "loading" | "booting" | "ready" | "failed" | "stopped";
  failure?: PanelRuntimeFailure;
  host?: {
    holderLabel?: string;
    platform?: "desktop" | "headless" | "mobile";
    supportsInspection?: boolean;
    reachable?: boolean;
    view: { exists: boolean; url?: string; loading?: boolean };
    boot:
      | { kind: "unavailable" }
      | {
          kind: "observed";
          observation: {
            phase: "loading" | "booting" | "ready" | "failed";
            runtimeEntityId?: string | null;
            source?: string | null;
            contextId?: string | null;
            effectiveVersion?: string | null;
            buildKey?: string | null;
            message?: string;
            errorName?: string;
            stack?: string;
            failureStage?: "config" | "bundle-load" | "entry";
          };
        };
  };
  updatedAt: number;
}
```

Boot phase belongs to the attempt while `host.reachable` belongs to its current
transport route. A reconnect can therefore flip reachability without erasing
an already-ready attempt or waking exact-attempt waiters. Every new
materialization receives a fresh attempt, even when it presents the same
runtime entity and build key.

Every inspecting renderer host must implement the canonical
`panelObservation` host command. Desktop and headless publish the same canonical
`PanelHostObservation` value (including the nested `view` and `boot` states)
and execute the same bounded page probe for `document.readyState`, the current URL, and
`globalThis.__vibestudioPanelBoot`, then parse the result through the same
shared contract. Target registration, successful navigation, an empty DOM, or
the existence of a browser view is never a readiness substitute. A missing
command or malformed observation is a `host_unavailable` platform failure and
must be repaired in the host; callers must not infer success or fall back to a
different readiness surface.

There are no separate `refresh()`, `getInfo()`, `ensureLoaded()`, or
`isLoaded()` handle concepts. They previously exposed different partial truths
and could report success for a broken panel. Use `observe()`; `phase ===
"ready"` is the sole positive readiness answer.

## Failures

Read `error.failure`, not string fragments:

```ts
interface PanelRuntimeFailure {
  code:
    | "unit_not_found"
    | "ref_not_found"
    | "manifest_invalid"
    | "dependency_resolution_failed"
    | "compile_failed"
    | "build_identity_invalid"
    | "host_unavailable"
    | "lease_conflict"
    | "navigation_failed"
    | "asset_unavailable"
    | "entry_threw"
    | "boot_stalled"
    | "render_crashed"
    | "panel_not_found"
    | "unknown_failure";
  stage: "resolve" | "build" | "host" | "load" | "boot" | "runtime";
  message: string;
  diagnosticId: string;
  occurredAt: number;
  provenance: {
    panelId?: string;
    runtimeEntityId?: string | null;
    attemptId?: string;
    source: string;
    contextId: string;
    requestedRef: string;
    effectiveVersion?: string | null;
    buildKey?: string | null;
  };
  details?: Record<string, unknown>;
}
```

The failure and the shell error display come from the same host/server
observation. If an operation rejects, do not immediately retry or open another
panel. Inspect its failure first; retries cannot fix a missing unit, wrong ref,
compile error, or throwing entry module.

## Handle operations

| Member                                          | Contract                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `observe()`                                     | Current exact attempt, phase, host state, provenance, and structured failure                                                   |
| `diagnose()`                                    | One bounded packet containing `observation`, historical console/lifecycle records, and a document when ready                   |
| `snapshot(opts?)`                               | Boot-ready document capture with `panelId`, `attemptId`, `runtimeEntityId`, `buildKey`, and `capturedAt`                       |
| `navigate(source, opts?)`                       | Transactionally prepare a new source/ref/context attempt, activate it, and wait for ready                                      |
| `rebuild(opts?)`                                | Transactionally prepare a new immutable attempt for the current source/ref without adding a history entry, then wait for ready |
| `reload(opts?)`                                 | Reload the current view and wait for its boot handshake                                                                        |
| `focus(opts?)`                                  | Assign/present the panel and wait for ready                                                                                    |
| `children()` / `parent()`                       | Tree relationships                                                                                                             |
| `stateArgs.get()` / `stateArgs.set()`           | Validated host-owned application state args                                                                                    |
| `archive()` / `unload()`                        | Durable subtree removal or live-runtime release                                                                                 |
| `tree()` / `state()` / `routes()` / `setMode()` | Optional workspace `_agent` application inspection                                                                             |
| `cdp.session()` / `cdp.page()`                  | Generation-fenced multi-step automation or a one-off canonical CDP page                                                        |
| `click(selector)`                               | Approval-gated one-off CDP convenience                                                                                          |

`navigate()`, `reload()`, `rebuild()`, and `focus()` return
`Promise<PanelObservation>`, not another `PanelHandle`. Keep using the original
handle for `observe()`, `snapshot()`, and later lifecycle operations:

```ts
const observation = await handle.rebuild();
const capture = await handle.snapshot();
```

All readiness-bearing methods accept `{ signal?: AbortSignal }`; `navigate()`
and `focus()` include it in their existing options object. Cancellation stops
the caller's wait. It does not roll back a durable creation or destroy a panel
whose commit may already have succeeded.

`navigate()` and `rebuild()` are atomic replacements: the new runtime and build
are prepared before the current history entry is replaced. A preparation
failure does not pretend that the old attempt was replaced. The panel-tree id
and handle remain stable, while runtime entity, build key, and CDP endpoint are
incarnation-scoped. For multi-step automation, keep one `cdp.session()` and call
`session.refresh()` after either operation. Continue only with the returned
session and page; its `current`, `reconnected`, or `replaced` status explains
whether the immutable generation changed, and it never replays an action.

## Snapshot provenance

```ts
const capture = await panel.snapshot();
// {
//   panelId,
//   attemptId,
//   runtimeEntityId,
//   buildKey,
//   capturedAt,
//   document: { kind: "synth", text, structure }
// }
```

Always inspect `capture.document`, not the top level. The identities prevent a
capture from being mistaken for a later rebuild or navigation.

## Diagnostics

Use one diagnostic call when something is wrong:

```ts
const packet = await panel.diagnose();
console.log(packet.observation);
if (packet.consoleHistory.available) console.log(packet.consoleHistory.errors);
else console.log(packet.consoleHistory.error);
console.log(packet.document?.document.text);
```

`consoleHistory` has `entries`, `errors`, `dropped`, and `capacity`; it has no
separate `warnings` array. Filter warnings with
`entries.filter((entry) => entry.level === "warning")`.

`diagnose()` is safe for a failed attempt: it returns the canonical failure and
whatever bounded host evidence exists instead of requiring a successful
snapshot first. For a live runtime entity, use its exact
`{ kind, entityId }` identity with `runtime.supervision.health(identity)` or
`runtime.supervision.logs(identity)`; these reads do **not** request a new build
and must not be used as proof that the current working source compiles. Use
`services.build.getBuildReport(source, \`ctx:${ctx.contextId}\`)` for that
structured compile/build check. Read server logs only when the panel packet
shows the failure is below the lifecycle boundary.

## State and agent inspection

Inside a panel:

```ts
import { panel } from "@workspace/runtime";

const initial = panel.stateArgs.get();
await panel.stateArgs.set({ theme: "dark" });
```

From a handle:

```ts
await handle.stateArgs.set({ theme: "dark" });
const next = await handle.stateArgs.get();
```

`handle.state()` is empty unless the application registers state providers via
`useAgentState` or `agentApi.registerStateProvider`.

## CDP

`handle.cdp.session().page` is the preferred generation-fenced Playwright-style
automation surface; `handle.cdp.page()` is the one-off connection form. Both are
the same client, and their caller must close the session/page it owns. Do not
install Playwright. For historical diagnostics use `diagnose()`; use
`handle.cdp.consoleHistory()` only when you specifically need a filtered console
read. CDP access is served by the active desktop/headless host and rejects when
a non-CDP mobile host owns the target.

In server-side eval, use this handle API directly. The CDP client selects the
runtime's supported WebSocket transport; do not open the panel's private HTTP
URL, construct a raw WebSocket, or install a second browser library as fallback.

The page surface includes `page.keyboard.press/type/insertText`,
`page.setViewportSize/viewportSize`, `locator.evaluate/evaluateAll`, regex
text/name locators, and React-compatible form updates. Browser callbacks are
serialized into the page realm, so pass external data as the explicit callback
argument. Browser evaluation errors preserve the real exception description
and stack; locator failures add the exact rendered locator. See
[BROWSER.md](BROWSER.md) for the complete supported surface.

## Ownership

Archive temporary panels in `finally`. Reuse an existing handle rather than
opening duplicates. Leave a panel open only when the user asked to keep it or it
is the primary deliverable being inspected.
