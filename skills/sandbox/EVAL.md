# Eval Tool

Run TypeScript/JavaScript code **server-side** in your own per-agent sandbox.
`eval` is a LOCAL agent tool: the agent loop dispatches it in-process and it
executes the code in your channel's `EvalDO` (a server-side Durable Object), not
in the chat/editor panel. Console output is captured and the return value is
sent back.

**Eval does not need a connected panel.** It keeps working even if the
chat/editor panel — or the user — disconnects. It is a notebook kernel: the
same live heap remains resident for 30 minutes after the latest cell, and every
cell renews that idle lease. The in-DO SQLite `db` and exact serializable scope
snapshot survive unavoidable kernel restarts.

## Eval Perspective

Eval runs in a server-side EvalDO, not in the visible chat/editor panel. That
means its runtime perspective is slightly different from the user's panel
perspective:

- `chat.channelId` is the channel where this agent is currently responding.
  It is not automatically the channel for a parent panel, sibling panel, or
  any other chat panel in the tree.
- `panelTree.self()` in eval is the EvalDO runtime handle. Use top-level
  `parent`/`getParent()` for the owner agent's nearest visible panel ancestor.
- `openPanel()` from eval defaults new panels under that owner panel ancestor
  when one exists.
- A genuinely headless session has no initial panel ancestor. The panel tree is
  still fully available, but a child needs a real panel node to parent it. Use
  `getParent()` to test for an owner (`parent` is a compatibility no-panel
  handle when none exists). If it returns null, create an owned root explicitly
  and pass that handle's id as `parentId` when opening the child:

  ```ts
  import { openPanel } from "@workspace/runtime";

  const inherited = await getParent();
  const root = inherited ?? (await openPanel("about/new", { parentId: null }));
  const child = await openPanel("panels/spectrolite", {
    parentId: root.id,
    focus: true,
  });
  const observed = await child.observe();
  if (observed.phase !== "ready")
    throw new Error(`Unexpected phase: ${observed.phase}`);
  if (child.parentId !== root.id)
    throw new Error("Panel was not created as a child");

  // Archive the temporary root when the whole headless workflow is done; it
  // owns/cleans its descendants. Do not archive an inherited user panel.
  if (!inherited) await root.archive();
  ```

- When the user points at "this panel", "the parent panel", or another visible
  panel, inspect the visible tree with bounded `panelTree.roots()`,
  `panelTree.children()`, or `panelTree.search()` reads,
  choose the target panel, and read `await target.stateArgs.get()` to find its
  `channelName`/`channelId` before running channel diagnostics.

  Start root discovery with `await panelTree.roots({ limit: 100 })`; the host
  derives the current verified owner. Do not call the advanced
  `panelTree.page({ group: { kind: "roots" } })` form: an explicit root group
  requires an `ownerUserId`. Cross-owner access remains available through
  `rootOwners()` plus `rootsForOwner(ownerUserId, ...)`.

For perspective-heavy investigations, use `inline_ui` to render a small panel
tree or channel-health dashboard so the user can see and choose the same target
you are inspecting.

## Basic Usage

```
eval({ code: `console.log("hello")` })
```

Workspace packages are build-resolved automatically. To exercise or inspect a
built package, use a normal static import and return only the small export
summary you need—the first import builds on demand and later imports are cached:

```ts
import * as pkg from "@workspace-skills/workspace-dev";
return { exports: Object.keys(pkg).sort() };
```

Do not search generated build directories or call a separate “import build”
service. For npm packages, declare the npm mapping in the eval tool's `imports`
argument; workspace package specifiers need no mapping. See
[workspace and npm import rules](#imports) for
ref-pinned imports and the full rules.

Console capture belongs to eval itself; no panel, CDP session, or testkit helper
is needed. A single successful eval may emit several lines and return a compact
summary:

```ts
console.log("line 1");
console.log("line 2");
console.log("line 3");
return { lines: 3 };
```

The tool result contains the captured console text plus the return value. Use
panel `cdp.consoleHistory()` only when the task specifically asks for console
messages produced inside a rendered panel.

For multi-file code, put the entry point in a context-relative file and use `path`:

```
eval({ path: ".vibestudio/eval/check-project.ts" })
```

File-loaded eval reads the entry file from the current context, supports static
relative imports from that file, and resolves bare imports from the nearest
`package.json` when it can find one. Ordinary `.ts` and `.js` entry files are
executable, as are `.tsx`, `.jsx`, `.mts`, `.cts`, `.mjs`, and `.cjs`.

When `path` names a non-executable document/data file (for example `.md`,
`.json`, `.yaml`, or `.txt`), eval returns its UTF-8 contents instead of trying
to parse it as TypeScript. Executable `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`,
`.mts`, `.cts`, and `.tsx` paths retain normal file-execution behavior.

Inline `code` eval normally has no source file. To resolve relative imports,
pass `sourcePath` as a context-relative virtual filename, or pass `path` with
inline code as a directory/file hint. The hint establishes the inline module's
location; it does not import or execute that file. When inline code imports
`./index.ts`, use the containing directory or a distinct virtual filename such
as `src/eval-check.ts`—using `src/index.ts` would make `./index.ts` a self-import.
The tool rejects such unavailable/self imports with the typed, no-effect
`module_not_available` code so an agent can correct the importer path without
misclassifying it as runtime infrastructure failure.
With no inline code, `path` retains its file-loaded meaning. For substantial
multi-file work, prefer a real entry file.

## Parameters

| Param        | Type                                             | Default                 | Description                                                                                                                                |
| ------------ | ------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `code`       | string                                           | —                       | TypeScript/JavaScript code to execute                                                                                                      |
| `path`       | string                                           | —                       | Code file to execute, text/data file to load, or a source-base hint when `code` is also present                                            |
| `sourcePath` | string                                           | —                       | Virtual context-relative filename for inline code and relative imports                                                                     |
| `syntax`     | `"javascript" \| "typescript" \| "jsx" \| "tsx"` | `"tsx"`                 | Source syntax                                                                                                                              |
| `imports`    | `Record<string, string>`                         | —                       | Packages to build on-demand (workspace or npm)                                                                                             |
| `timeoutMs`  | positive integer                                 | —                       | Optional wall-clock deadline in milliseconds; omitted means no deadline                                                                    |
| `authority`  | per-run authority intent                         | adaptive mutable prompt | Attenuate this run with an exact `requests` allowlist, read-only effects, pregranted-only execution, or exact prospective preauthorization |

The table above is the ergonomic agent tool. Code that calls the server service
directly uses the single typed lifecycle shape:

```ts
await rpc.call("main", "eval.start", [
  {
    runId,
    source: {
      kind: "inline",
      code,
      pathHint: "src/probe.ts",
      syntax: "typescript",
    },
    scope: { key: channelId, lifecycle: "persistent" },
    resultReceiver: { kind: "caller" }, // optional terminal push to the authenticated caller
    authority,
  },
]);
```

For a file entry use `source: {kind:"context-file", path, syntax?}`. Recovery
and control calls use `scopeKey`, for example
`eval.get({runId, scopeKey})`. No eval argument may name an owner, channel,
context, agent, or arbitrary receiver runtime; those relationship facts are
derived from the authenticated caller and its verified binding.

### Per-run authority

Authority intent only narrows the authority already admitted by the receiver,
the installed harness, the verified session, live grants, relationships,
denials, and locks:

```ts
eval({
  code: `return await fs.readFile("README.md", "utf8")`,
  timeoutMs: 30_000, // top-level sibling of authority, never nested inside it
  authority: {
    effects: "read-only",
    approvals: "pregranted-only",
    requests: [
      {
        capability: "fs.read",
        resource: { kind: "exact", key: "README.md" },
      },
    ],
  },
});
```

Omit `requests` to adapt to the authority already admitted for the caller.
Supply `requests` to make it the exact per-run allowlist; `requests: []`
therefore denies every protected operation. An uncovered
capability/resource returns a structured `run-manifest-denied` failure even
when a broader user grant exists.
Never invent a wildcard request such as `workspace:*`. If you do not know an
exact capability/resource pair and do not specifically need attenuation, omit
`requests`; use `help()` or the capabilities skill before constructing an exact
allowlist.
`pregranted-only` never opens an approval card. `read-only` is enforced at the
same dispatcher used by every host call; it is not a separate eval method
allowlist. `preauthorize` accepts exact `{service, method, args}` operations and
uses the canonical host preflight/acquisition path, so approval binds the final
prepared invocation rather than a capability string.

The service also retains bounded durable lifecycle events. Interactive panels
subscribe to `eval:run-event` through `events.watch` for live state, console,
progress, authority, cleanup, kernel, and diagnostic records, then use
`eval.events({runId, after, limit})` only to catch up after reconnect. Agent
tool completion remains the terminal push path; agents do not poll event pages.
Workspace import bundles carry their immutable execution identity into the
EvalDO's durable run/module provenance and remain execution-GC roots until the
finite kernel is disposed. External npm bundles are explicitly outside the
workspace BuildStore root set.

## Injected Variables

These are available in eval code. `scope`, `scopes`, `db`, `ctx`, `help`, `chat`,
and `agent` are eval-context ambient variables. `rpc`, `fs`, `services`, and
`hosts` are the same portable bindings used by panels/workers; use them
ambiently or import them from `@workspace/runtime`.

| Variable                           | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rpc.call(targetId, method, args)` | Portable RPC client, same shape as panels/workers. Raw server services target `"main"`: `await rpc.call("main", "vcs.status", [{ contextId: ctx.contextId }])`                                                                                                                                                                                                                                                                                                                                                                                               |
| `services`                         | Convenience namespace for server services. If the service name is also a rich runtime binding (`workers`, `vcs`, `fs`, `credentials`, `blobstore`, …), `services.<name>` is that ergonomic runtime client, not the raw service catalog. Raw catalog methods are always reachable with `rpc.call("main", "<svc>.<method>", [...])`; non-colliding services are also reachable as `services.<svc>.<method>(...)`. Access is still gated server-side by each method's policy. Use `help()` to list services and `help("workers")` to inspect a runtime binding. |
| `hosts`                            | Owner-scoped attached-host clients. `const child = await hosts.attach(attachedHostSessionId)` returns `child.services`; call ordinary child methods such as `child.services.eval.start(...)` and `child.services.eval.get(...)`. The child validates its normal schema and authority policy; there is no development-specific eval bridge.                                                                                                                                                                                                                   |
| `fs`                               | Context-scoped filesystem — the EvalDO resolves your context, so you do NOT pass a contextId: `await fs.readdir("/")`, `await fs.readFile("src/index.ts", "utf-8")`                                                                                                                                                                                                                                                                                                                                                                                          |
| `ctx`                              | `{ contextId, objectKey }` for the current eval session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `scope`                            | Live notebook scope (see below); `scope.x = …` retains object identity across cells while the current kernel activation remains resident                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `scopes`                           | Management API for the serialized scope layer (see below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `db`                               | Synchronous in-DO SQLite (see below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `chat`                             | The full chat API for the current channel — `publish`/`send`, custom-message cards, `registerMessageType`, `callMethod`, etc. (agent eval only; see below)                                                                                                                                                                                                                                                                                                                                                                                                   |
| `agent`                            | Inspect/configure THIS agent's own state — `await agent.describe()`, `await agent.setModel("provider:model")`, etc. (agent eval only; see below)                                                                                                                                                                                                                                                                                                                                                                                                             |
| `help()`                           | `await help()` lists services + import guidance; `await help("vcs")` returns a compact live method index; `await help("vcs.edit")` returns that method's exact schema and typed errors                                                                                                                                                                                                                                                                                                                                                                       |

```
eval({ code: `
  const files = await fs.readdir("/");
  scope.fileCount = files.length;
  return files.slice(0, 10);
` })
```

### chat (agent eval)

When eval runs **as an agent** (the agent's own server-side EvalDO), a `chat`
binding for the agent's current channel is injected — the same surface as
[CHAT_API.md](CHAT_API.md): `chat.send`, `chat.publish`,
`chat.publishCustomMessage`/`chat.updateCustomMessage`,
`chat.registerMessageType`/`chat.clearMessageType`, `chat.callMethod`,
`chat.callMethodByHandle`, `chat.participantByHandle`, `chat.contextId`,
`chat.channelId`, etc. Everything publishes **as the agent** (correct `@agent`
attribution).

```
eval({ code: `
  await chat.registerMessageType({
    typeId: "status",
    displayMode: "row",
    source: { type: "file", path: "renderers/status.tsx" },
    stateSchema: { type: "object", properties: { phase: { type: "string" } } },
  });
  const { messageId } = await chat.publishCustomMessage({ typeId: "status", initialState: { phase: "starting" } });
  await chat.updateCustomMessage(messageId, { phase: "done" });
` })
```

Under the hood `chat` is a thin proxy: the EvalDO forwards each call to the
owning agent DO, which performs it with its channel machinery and relays the
result. `chat.callMethod` resolves to the **delivered** participant result, and
`chat.participantByHandle` is async (the roster is fetched over RPC).
`chat.focusMessage` is panel-only and resolves `false` server-side.

`chat.callMethod` and `chat.callMethodByHandle` are channel-scoped. They only
route to participants in `chat.channelId`. To inspect an agent or channel from
another panel, first identify that panel's channel id from its state args, then
use GAD inspectors or the channel DO's read-only `inspectAgent` method.

> Note: `chat` is only present for **agent** eval. CLI/panel eval (no channel)
> gets no `chat` — interact with the channel through `rpc`/`services` instead.
> The `chat` handle is also available to panel-rendered components
> (`inline_ui`, `feedback_custom`, action bars) — see [CHAT_API.md](CHAT_API.md).

### agent (agent eval)

When eval runs **as an agent**, an `agent` binding lets the agent introspect and
reconfigure **itself**. Config is **per-agent** (one model, thinking level,
approval posture, respond policy, … shared across every channel the agent is in)
— it is NOT per-channel. Writes apply to all the agent's channels and take effect
on the next turn.

```
// Read your own state (identity, resolved config, channels, tools, turn, effects):
const me = await agent.describe();
me.config.model;        // the model you are running
me.channels;            // every channel you're a member of
me.turn.status;         // this channel's turn status

// Reconfigure yourself (each returns the updated config):
await agent.setModel("openai:gpt-5.3");
await agent.setThinkingLevel("high");
await agent.setApprovalLevel(2);          // UX convenience; sensitive ops are gated by app approvals
await agent.setRespondPolicy("mentioned-or-followup");
await agent.setRespondFrom(["@alice"]);   // handles resolve per-channel
await agent.configure({ model: "…", thinkingLevel: "medium" });  // batch
```

The executing agent's own advertised participant methods are deliberately not
model tools: synchronously calling the active turn back through its channel
would wait on itself. Use `agent.describe()` for self-inspection. Use
`chat.callMethod(...)` only for a different participant.

A `spawn_subagent` Pi child inherits the parent's effective model and other
runtime settings automatically. Omit its `config` for ordinary delegation; do
not read and restate the model ref. Set `config.model` only for an intentional
cross-model child, using an exact ref obtained from the current catalog.

Direct creation of an independent headless agent is different: its model rides
the entity's creation config (`stateArgs.agentConfig.model`), not a later
subscription.

> Note: `agent` is only present for **agent** eval (same gate as `chat`); the
> EvalDO forwards each call to your own vessel, which only accepts your own eval.

## Top-level Await

Fully supported. Async operations are automatically tracked and awaited:

```
eval({ code: `
  const response = await credentials.fetch("https://api.example.com/data");
  const data = await response.json();
  console.log(data);
  return data;
`
})
```

Confined eval intentionally has no ambient raw `fetch`. Use
`credentials.fetch` for external HTTP so the request keeps its verified eval
session, passes through the egress proxy, and can pause for exact-origin
authority. It also works without a stored credential for public endpoints.

A trailing async IIFE is also treated as the eval result and awaited:

```ts
(async () => {
  const status = await services.vcs.status({ contextId: ctx.contextId });
  const files = await services.vcs.listFiles({
    state: status.workingHead,
    repositoryId: "repository:example",
    limit: 50,
  });
  return files.files;
})();
```

Do not use `void (async () => { /* ... */ })()` to create background work.
Detaching a promise neither journals it nor preserves the eval's execution
authority. Work intended to outlive the eval must be persisted by an owning
queue/workflow and resumed under a later admitted execution; otherwise await it
so its result or failure belongs to this run.

## Console Output

`console.log/warn/error/info/debug` output is captured during the run and
returned to the agent in the result's `console` field.

This is only the eval run's own console output. To debug the workspace server
host process itself, query `services.serverLog.tail/query/stats` from eval, or
open the `about/server-logs` viewer for a live follow. See
`../server-logs/SKILL.md`.

## Result Shape

The one-call `eval` tool returns
`{ success, console, returnValue?, error?, scopeKeys?, kernel? }`:

- `success` — whether the run completed without throwing.
- `console` — captured console output. Oversized output is windowed in the
  terminal result; a bounded saved copy is available as
  `scope.$lastLargeConsole`.
- `returnValue` — the `return` value (or last expression), safe-serialized.
  Oversized values may be replaced with a structured truncation summary pointing
  at `scope.$lastLargeReturn`.
- `error` — present on failure.
- `scopeKeys` — the keys currently held in the live notebook `scope`.
- `kernel` — structured notebook-incarnation metadata: the incarnation ID,
  start time, current idle-lease deadline, and (on the first result of an
  incarnation) a `started` or `restarted` event with exact restored/lost keys.

After an unavoidable restart, the formatted tool result begins with
`[kernel] Restarted`. Treat that line as a state transition, not a warning to
ignore: module singletons and all live-only objects are gone. The same line
names every durably restored scope key and every lost live-only key. Reacquire
lost handles from their stable IDs before continuing.

Non-serializable values (functions, symbols, circular refs) are safely converted
to string representations in `returnValue`.

The most recent defined return is also retained as `scope.$lastReturn` for a
follow-up eval. Small returns keep their structured shape; oversized returns are
stored as a bounded JSON/text string. A large return is additionally retained at
`scope.$lastLargeReturn`; unlike `$lastReturn`, that recovery slot is not
overwritten by the small summaries returned from follow-up inspectors. Large
console and error text use the corresponding stable `$lastLargeConsole` and
`$lastLargeError` slots. Each slot holds at most the latest bounded large value
of its kind, so recovery remains pageable without accumulating output.
`$lastLargeReturn` is JSON/text, not the original object. Slice or search the
text directly, or use `JSON.parse(scope.$lastLargeReturn)` before accessing
properties when the original return was JSON-serializable.

Terminal eval results are always bounded so a huge return cannot strand the
turn in `eval:pending`. For large data, return a compact summary and keep the
full value in `scope`, `db`, or `blobstore` for follow-up paging/grep.

## Imports

Workspace and npm packages are loaded via the `imports` parameter (npm) or
auto-resolution (workspace), then brought in with a normal `import`. Both static
`import` and dynamic `await import(...)` work — they compile to the EvalDO's
per-object require, which is isolated per owner (your loaded modules never leak
to another agent's EvalDO sharing the same isolate).

Do NOT import the **ambient-only** globals (`scope`, `scopes`, `db`, `ctx`, `help`,
`chat`, `agent`, `automations`) — they are injected free variables, not module exports,
and the eval engine rejects importing them.

`rpc` and `fs` are the exception: they are injected ambiently (the table above)
**and** re-exported by `@workspace/runtime`, so importing them is allowed and
gives the full portable client. `import { rpc } from "@workspace/runtime"` is the
3-arg `rpc.call(targetId, method, args)` client (the ambient `rpc` is 2-arg sugar
over the server); `import { fs } from "@workspace/runtime"` is the same
context-scoped fs.

### Importing the runtime surface

`@workspace/runtime` is importable in eval and exposes the **same portable
surface** as panels and workers — so the same code runs on any target:

```
eval({ code: `
  import { vcs, workspace, gad, credentials, openPanel, panelTree } from "@workspace/runtime";
  const status = await vcs.status({ contextId: ctx.contextId });
  console.log("Exact working state:", status.workingHead);
` })
```

Importable members: `id`, `contextId`, `rpc`, `fs`, `gad`, `blobstore`,
`workspace`, `credentials`, `git`, `vcs`, `webhooks`, `extensions`, `approvals`,
`notifications`, `workers`, `doTargetId`, `createDurableObjectServiceClient`,
`gatewayConfig`, `gatewayFetch`, `openExternal`, `openPanel`,
`getPanelHandle`, `panelTree`. (`gatewayFetch` in eval is **gateway-relative
only** — use `credentials.fetch` for external requests.)

#### CDP (Chrome DevTools Protocol) from eval

Drive a live panel's browser target over CDP — full commands **and** events —
from eval. Get an endpoint from a panel handle, then connect with
`CdpConnection` from `@workspace/cdp-client`:

```
eval({ code: `
  import { CdpConnection } from "@workspace/cdp-client";
  const handle = getPanelHandle("<panelSlotId>");
  const { wsEndpoint, token } = await handle.cdp.getCdpEndpoint();
  const cdp = await CdpConnection.connect(wsEndpoint, token);
  cdp.on("Runtime.consoleAPICalled", (e) => console.log("panel console:", e.args));
  await cdp.send("Runtime.enable", {});
  const r = await cdp.send("Runtime.evaluate", { expression: "1 + 1", returnByValue: true });
  return r.result.value;
` })
```

### Workspace packages — auto-resolved

Workspace packages (`@workspace/*`, `@workspace-skills/*`) and platform SDK
packages (`@vibestudio/*`) are **automatically built and loaded** when you
import them. Just write the import — no `imports` parameter needed:

```
eval({ code: `
  import { createProjects } from "@workspace-skills/workspace-dev";
  return await createProjects([{ projectType: "panel", name: "my-app", title: "My App" }]);
`
})
```

Guest/service exceptions with structured `errorData` retain that data in the
eval result details and display a bounded failure-data preview. For
`scaffold_publication_failed`, do not rerun creation. Branch on the structured
`retry.commandIdPolicy`: use `recoverProjectPublication` from
`@workspace-skills/workspace-dev` for receipt/main-state recovery, repair and
recommit the cited source for `repair-source-and-recommit`, and stop on
`stop-integrity-investigation`. Do not infer recovery from the error string.
Failed tool invocations also
persist one `agent-tool-failure.v1` object in the terminal trajectory event.
Branch on its code, kind, stage, retry policy, and ordered causes rather than
the rendered eval text.

The first import triggers an on-demand build from the eval caller's current
context working state (a few seconds). Subsequent imports of that state use the
cached build.

To build a workspace import from a non-default revision, use an explicit build
selector accepted by the live resolver:

```
eval({ code: `...`, imports: { "@workspace-skills/workspace-dev": "ctx:<contextId>" } })
```

The map value is a build selector, not a package name. Omit workspace packages
for the caller's current working revision. `main` and `ctx:<contextId>` are
moving build selectors; an exact content selector is rendering/build authority
only and is not a semantic ancestry or integration basis. Git branches, tags,
and raw SHAs are not workspace build selectors.

Workspace runtime units build from one exact working state. Managed edits
under `apps/`, `extensions/`, `packages/`, `panels/`, `workers/`, and `skills/`
author semantic work and materialize the resulting state to disk. Contexts have
one committed event and a nullable local application head, not per-repository heads.
Read [vibestudio-vcs](../vibestudio-vcs/SKILL.md) before source mutation,
comparison, commit, or publication.

### npm packages

Use the `imports` parameter with `"npm:<version>"`, then `import` the package:

```
eval({
  code: `
    import _ from "lodash";
    console.log(_.chunk([1, 2, 3, 4, 5, 6], 2));
  `,
  imports: { "lodash": "npm:^4.17.21" }
})
```

```
eval({
  code: `
    import * as d3 from "d3-array";
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    console.log("mean:", d3.mean(data));
    console.log("deviation:", d3.deviation(data));
  `,
  imports: { "d3-array": "npm:^3.0.0" }
})
```

Version values follow registry semver/range conventions accepted by the build
service: `"npm:1"`, `"npm:1.3.0"`, `"npm:^1.0.0"`, `"npm:~2.3.0"`,
`"npm:latest"`, or `"npm:*"`.
The import-map key is the package name; prefer version-only values such as
`imports: { "left-pad": "npm:1.3.0" }`. Package-qualified values like
`"npm:left-pad@1.3.0"` are accepted only when the package name matches the key.

Packages are installed with `--ignore-scripts` for security (no postinstall hooks). Specifiers are validated against npm naming rules — only standard package names are accepted (no URLs, file paths, or git refs). Native addon packages (those requiring `.node` binary files) are not supported.

Invalid package names, invalid versions, unsupported toolchain packages, missing
packages, and missing package versions are caller-correctable eval failures with
stable structured codes. They do not terminate the agent turn; correct the
`imports` map or continue with other sandbox work. Network, cache, package
acquisition, and linker failures remain infrastructure failures.

Installed packages and their bundles are both cached, so subsequent imports of the same package/version are fast. The first install of a new package may take 10-30 seconds (npm download + esbuild bundle); eval waits for that work to complete.

For file-loaded code, npm package versions are inferred from the nearest
`package.json` dependency fields when possible. The lookup checks
`dependencies`, `peerDependencies`, `optionalDependencies`, and
`devDependencies`, in that order. Use `imports` to override or provide versions
not declared there.

File-loaded code also supports package-local aliases declared through
`package.json` `imports` (for `#alias` style imports) and simple
`tsconfig.json` `compilerOptions.paths` mappings.

### Mixing workspace and npm imports

```
eval({
  code: `
    import { createProjects } from "@workspace-skills/workspace-dev";
    import Ajv from "ajv";
    const ajv = new Ajv();
    console.log("Ajv loaded:", typeof ajv.compile);
  `,
  imports: {
    "@workspace-skills/workspace-dev": "latest",
    "ajv": "npm:^8.12.0"
  }
})
```

### Limitations

- `package.json` `exports`, lockfile-exact versions, and full Node
  `node_modules` resolution are not implemented.
- Only packages with standard npm names are accepted (e.g. `lodash`, `@scope/pkg`). URLs, file paths, and git specifiers are rejected.
- Packages requiring native addons (`.node` binaries) won't work — esbuild cannot bundle them.

## Path Conventions

The `path` parameter for file-loaded eval is always context-relative, for
example `.vibestudio/eval/check-project.ts`.

Runtime `fs.*` calls are also scoped to the current context folder. In `fs`
calls, both `src/index.ts` and `/src/index.ts` refer to files under the context
root; the leading slash means context-root absolute, not a host filesystem path.
Prefer paths without a leading slash in examples that touch workspace source,
and never pass host absolute paths such as `/home/user/.../workspace/...`.

## REPL Scope

`scope` is the live notebook heap shared across eval cells in the same channel.
The EvalDO's in-memory backing map remains authoritative while that kernel is
warm: objects are not serialized and reconstructed between ordinary calls.
Functions, class instances, handles, and open connections therefore retain
identity and behavior across cells. Before each cell, the host renews one held
kernel request; it expires 30 minutes after the latest cell. There is no
heartbeat, polling loop, or cell-end disconnect.

After each cell, EvalDO also writes an exact recovery snapshot to its
SQLite `repl_scopes` table. That snapshot is not the active heap and does not
replace live values. It is read only when a new ScopeManager is created after a
cold start, reset, eviction, or reconstruction.

### scope vs scopes

- **`scope`** — the warm notebook object. Read/write `scope.x` during normal
  operation; live identity remains stable across cells while the kernel is warm,
  and serializable state is snapshotted after each cell.
- **`scopes`** — management API for the serialized (DB) layer:
  - `scopes.currentId` — current scope's durable UUID
  - `scopes.push()` — serialize + archive current scope, start a fresh one (only serializable values carry over)
  - `scopes.get(id)` — retrieve an archived scope by its durable ID (deserialized snapshot — data only, no functions)
  - `scopes.list()` — list all scopes for this channel with durable keys and
    volatile (live-only) keys
  - `scopes.save()` — force-serialize scope to DB now

### Serialization

The recovery snapshot is exact per top-level property:

- **Kept:** primitives, plain objects, arrays, Date, Map, Set, RegExp
- **Volatile:** functions, symbols, class instances, WeakRef/WeakMap/WeakSet,
  circular/shared object references, accessors or custom property descriptors,
  sparse/custom arrays, depth > 100

If any nested leaf is volatile, the complete top-level value is excluded from
cold recovery. Eval never returns a smaller, methodless imitation under the
original key.

This produces an intentional two-layer contract:

- **Warm kernel:** every value remains live, including functions, class
  instances, `PanelHandle`, and `CdpPage`.
- **Cold recovery:** serializable data is restored; non-serializable top-level
  keys are reported as lost and must be reacquired from retained identity or
  provenance.

Do not reduce every notebook workflow to IDs merely because cold recovery
exists. Keep useful live objects in `scope`, and keep the smallest stable
descriptor beside them when reacquisition matters:

```ts
scope.panel = await openPanel("panels/my-app");
scope.panelId = scope.panel.id;
scope.page = await scope.panel.cdp.page();

// A later warm cell uses the same objects:
return await scope.page.getByRole("heading").innerText();

// After cold recovery, reacquire without creating a duplicate:
scope.panel ??= getPanelHandle(scope.panelId);
scope.page ??= await scope.panel.cdp.page();
```

There is no cell-end collection step or promised idle window. Code needing
recovery must retain stable data rather than depending on activation residency.

### Resetting scope

To start with an empty scope and empty `db`, reset the eval context. The agent
`eval` tool accepts `reset: true`; reset and the following execution are atomic
and idempotent on that tool invocation. It drops your user `db` tables and the
persistent scope before running the supplied code, preserving only reserved/base
tables. Verify reset effects in that call or a later call.

Do not call `eval.reset` through `rpc` from inside eval code. Nested RPC is
authenticated as the EvalDO, not as the agent that invoked the tool, so it
cannot address the executing agent/channel sandbox. The agent-facing reset
surface is `eval({ reset: true, ... })`.

### Deep Mutations

Deep mutations (`scope.data.push(x)`, `scope.config.key = val`) are captured by
the post-eval auto-save. No need for extra `scopes.save()` calls within eval.

## Database Access

`db` is a **synchronous** in-DO SQLite database, persisted in the EvalDO across
calls (so it survives across turns and panel disconnects). It is the persistent
storage companion to `scope`.

```
eval({ code: `
  db.run("CREATE TABLE IF NOT EXISTS findings (id INTEGER PRIMARY KEY, note TEXT)");
  db.run("INSERT INTO findings (note) VALUES (?)", "first finding");
  const rows = db.exec("SELECT * FROM findings");
  console.log(rows);
  return rows;
` })
```

- `db.exec(query, ...params)` runs a statement and returns the rows as an array.
- `db.run(query, ...params)` runs a statement for its side effect (no result).
- Reserved tables `state`, `repl_scopes`, and `sqlite_*` are off-limits to
  destructive statements (DROP/DELETE/ALTER/UPDATE/INSERT/REPLACE/TRUNCATE/CREATE)
  — use your own table names. Create and write your own tables freely.

For storage that other panels, apps, workers, or agents need to read, define a
worker Durable Object and use its `this.sql`, then declare it as a userland
service and call it over RPC:

```ts
import { rpc, workers } from "@workspace/runtime";

const store = await workers.resolveService("example.todos.v1", "project-123");
if (store.kind !== "durable-object") throw new Error("Expected DO service");
const todos = await rpc.call(store.targetId, "listTodos", []);
```

See [workspace-dev/WORKERS.md](../workspace-dev/WORKERS.md#durable-object-backed-app-databases)
for the full app database pattern. The eval `db` is private to your EvalDO.

## Filesystem Access

`fs` is injected and scoped to your current context — no contextId argument.
Relative paths and leading-slash paths are both context-root-relative: `"note.txt"`
and `"/note.txt"` stay inside the context; the leading slash never names a host
filesystem path.

```
eval({ code: `
  const content = await fs.readFile("src/index.ts", "utf-8");
  console.log(content);
` })
```

Pass an encoding such as `"utf-8"` when reading text. Without an encoding,
`fs.readFile` returns bytes, so string methods like `.replace()` will fail.

Use `await help("fs")` for the live surface. Common methods include `readFile`,
`writeFile`, `appendFile`, `readdir`, `stat`, `mkdir`, `rm`, `exists`,
`copyFile`, `rename`, `open`, `grep`, `glob`, `mktemp`, and `mkdtemp`.

`mktemp(prefix?)` returns an uncreated unique file path. `mkdtemp(prefix?)`
creates and returns a unique directory. Use the form matching what you intend
to create instead of treating a file path as an existing parent directory.

`fs.open(path, flags?, mode?)` returns the portable low-level file-handle
contract `{ fd, read, write, stat, close }` in eval, panels, workers, and
Durable Objects. `read(buffer, offset, length, position)` resolves to
`{ bytesRead, buffer }`; `write(data, offset?, length?, position?)` resolves to
`{ bytesWritten, buffer }`. Always close in `finally`:

```ts
const path = await fs.mktemp("handle");
await fs.writeFile(path, "hello");
const handle = await fs.open(path, "r+");
try {
  const buffer = new Uint8Array(5);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  await handle.write(new TextEncoder().encode("H"), 0, 1, 0);
  console.log({ bytesRead, text: new TextDecoder().decode(buffer) });
} finally {
  await handle.close();
  await fs.rm(path, { force: true });
}
```

`fs.stat()` and `fs.lstat()` return Node-shaped metadata: `mtime` and `ctime`
are `Date` instances (with `mtimeMs`/`ctimeMs` numeric companions), alongside
`size`, `mode`, and the `isFile()`/`isDirectory()`/`isSymbolicLink()` methods.

Portable `node:fs`/`node:fs/promises` imports and the equivalent bare Node
aliases `fs`/`fs/promises` are backed by this same context-scoped filesystem,
never the host filesystem. The other safe compatibility modules accept both
spellings too (`node:path`/`path`, `node:os`/`os`, `node:util`/`util`, and
`node:crypto`/`crypto`). Eval is asynchronous, so
prefer promises. For direct default or namespace `node:fs` imports, familiar
top-level supported calls such as `readFileSync()`, `writeFileSync()`, and
`unlinkSync()` are automatically lifted to their awaited portable equivalents;
code inside a nested synchronous callback should use the async methods
explicitly.

`node:path` is available for path manipulation. A tenant-neutral `node:os`
facade is also available for portable recipes: notably, `tmpdir()` returns the
context-local `/.tmp` directory rather than a host path. Machine identity,
network, CPU, and memory methods return stable non-host values.
Pure `node:util` helpers are available too, including `TextEncoder`,
`TextDecoder`, `inspect`, and `promisify`.
Pure `node:crypto` hashing, randomness, and Web Crypto compatibility are
available as well.

For disposable files, let `mktemp` choose an untracked path. This is the
canonical write → rename → content-match flow:

```ts
const source = await fs.mktemp("copy-rename");
const renamed = `${source}.renamed`;
const expected = "sandbox rename check\n";

try {
  await fs.writeFile(source, expected);
  await fs.rename(source, renamed);
  const actual = await fs.readFile(renamed, "utf-8");
  if (actual !== expected) throw new Error("content mismatch after rename");
} finally {
  await fs.rm(source, { force: true });
  await fs.rm(renamed, { force: true });
}
```

Use `fs.copyFile(source, destination)` instead when both files should remain.
Paths inside a managed workspace repository (`packages/<name>/…`,
`panels/<name>/…`, etc.) route through the semantic filesystem adapter. Its
move/copy operations preserve file identity and explicit copy ancestry.
Platform-ignored paths and paths outside workspace source remain direct,
context-local scratch files. Prefer `mktemp` for scratch.

## Calling Services

Use `rpc.call("main", "<svc>.<method>", [...])` to reach raw server/main service
catalog methods from eval. `services.<svc>.<method>(...)` is available for
service names that do not collide with runtime bindings, but rich runtime
bindings win on collision: `services.workers` is the ergonomic `workers` client,
which includes worker `create`/`list`/`destroy` plus `listSources()`. The equivalent raw catalog call is
`rpc.call("main", "workers.listSources", [])`.

```
eval({ code: `
  const tree = await rpc.call("main", "workspace.sourceTree", []);
  console.log("Workspace tree:", tree);
  // Use the ergonomic runtime binding when available:
  const tree2 = await workspace.sourceTree();
` })
```

Use `await help()` for live discovery and `await help("vcs")` or
`await help("workers")` for one runtime binding's compact live method index.
Then request only the method you need, such as `await help("vcs.edit")`, for
its exact arguments, return schema, and typed errors. Pass the
name as a string; do not call `help(workers)`.

## Worker Management

Durable Object schema failures are platform compatibility refusals, not guest
JavaScript failures. Eval preserves their stable code and structured data:

- `DO_SCHEMA_INCOMPATIBLE`: read `errorData.reason`, `persistedVersion`,
  `targetVersion`, `source`, `className`, `objectKey`, and `safeActions`. This
  pre-release system admits only the exact current shape; do not add a migration
  callback, compatibility reader, or hidden version field. Recreate disposable
  state, or explicitly export/import valuable product data through its current
  interface as part of the coordinated epoch cut.
- `DO_MAINTENANCE_IN_PROGRESS`: reset, restore, or snapshot currently fences
  the exact object. Wait for that operation to finish; do not resolve another
  handle to route around the fence.

For explicitly disposable state only, resolve the exact target, then use
`workers.resetStorage(target, intent)`. The returned operation id names the
automatic verified backup. Recovery uses `workers.listStorageBackups(target)`
and `workers.restoreStorageBackup(target, operationId, intent)`.

Launch, list, and retire regular workers with the typed `workers.create`,
`workers.list`, and `workers.destroy` methods. They delegate to the canonical
runtime entity lifecycle, whose raw methods remain available for advanced and
non-worker entities. List launchable sources with `workers.listSources()`. Each
row includes `source`, the manifest's real `entry` (do not guess `index.ts`), and
`classes` (empty for regular workers).

```
eval({ code: `
  // Launchable worker sources (the workers/* repos that can be started)
  const sources = await workers.listSources();
  console.log("Available worker sources:", sources);

  // Currently-running worker instances
  const instances = await workers.list();
  console.log("Running instances:", instances.map((w) => w.id));
` })
```

```
eval({ code: `
  const key = \`worker-probe-${crypto.randomUUID()}\`;
  let handle;
  try {
    // \`key\` names the instance; pass \`ref\` for code at the context's
    // working selector, or omit it for the main build.
    handle = await workers.create("workers/my-worker", {
      key,
      contextId: ctx.contextId,
      ref: \`ctx:${ctx.contextId}\`,
      env: { NON_SECRET_PROBE: "configured" },
    });
    const during = await workers.list();
    if (!during.some((entity) => entity.id === handle.id)) throw new Error("Worker was not listed");
  } finally {
    if (handle) await workers.destroy(handle);
  }
  const after = await workers.list();
  if (handle && after.some((entity) => entity.id === handle.id)) {
    throw new Error("Worker remained active after retireEntity");
  }
` })
```

`env` accepts extra string bindings and delivers them to the worker's `env`
parameter (`WorkerEnv`), not Node's `process.env`. A successful
`runtime.createEntity` proves that the host accepted the configuration and
started the worker; it does **not** prove that worker code read a particular
value. To claim runtime observation, call a worker HTTP endpoint or exposed RPC
method designed to return one named, non-secret probe value. Never add generic
entity introspection that returns the full env object or arbitrary secret keys.
See [workspace-dev/WORKERS.md](../workspace-dev/WORKERS.md#worker-lifecycle-and-environment-bindings)
for the worker-side probe pattern.

The probe belongs in the worker being tested; a successful check must call that
worker through the returned `targetId`. See
[workspace-dev/WORKERS.md](../workspace-dev/WORKERS.md#worker-lifecycle-and-environment-bindings)
for the narrow fixed-method pattern. Do not use a permanently shipped sample as
a substitute for testing the actual worker.

## Workspace VCS

The runtime `vcs` namespace and the server `vcs.*` service share one generated
semantic method registry. Use `await help("vcs")` for the method index and
`await help("vcs.edit")` for an exact transport schema
and read [vibestudio-vcs](../vibestudio-vcs/SKILL.md) for the protocol.

From eval, keep these boundaries explicit:

- obtain the current authority from ambient `ctx.contextId` or imported
  `contextId`; never invent a default context or repository path;
- call `vcs.status({ contextId })` and keep `status.workingHead` as the exact
  basis for reads and mutations;
- discover managed identities with `vcs.listFiles`, then read by stable file ID
  with `vcs.readFile`;
- author `vcs.edit` requests with `expectedWorkingHead` and a stable
  `commandId`;
- use `vcs.move` and `vcs.copy` for managed identity changes;
- compare an exact target state with one source event, then merge bounded
  stable-coordinate pages and review the intent/composed projections;
- commit or discard the complete local application chain;
- run ordinary typecheck, test, and build services explicitly for advisory
  confidence before protected publication; do not infer that `vcs.push` runs
  or certifies them;
- use `vcs.importSnapshot` for a trusted exact external tree instead of
  disguising it as local edits, and retain its atomic event/application/work
  unit/repository/snapshot acknowledgement.

Every mutation branches on typed result/error discriminants. An uncertain retry
reuses the same command ID and identical payload; any changed request after a
freshness failure gets a new command ID. Content-only build selectors are not
semantic ancestry, decision, or integration authority.

The generated
[VCS authoring examples](../vibestudio-vcs/references/authoring-basics.md)
provide the release-validated `status` → repository discovery → `readFile`
→ `readFile` → `edit` sequence and the complete `RevisionChanged` recovery
rule.

## Large Results And Diagnostics

Do not return broad hydrated channel histories, full `scope` dumps, large DOM
dumps, or full GAD payloads from `eval`. Large values are intentionally stored as
blob refs in trajectory/channel storage; broad hydrated reads can pull them back
into the transcript and hide the useful part of the report.

Eval has a safety net for accidental large output: terminal
console/error/return data is windowed before it is persisted or delivered. The
tool result will point to `scope.$lastLargeConsole`, `scope.$lastLargeError`, or
`scope.$lastLargeReturn` when a bounded saved copy exists. These stable recovery
slots survive small follow-up eval results, so they can be read in multiple
pages. Keep a returned page compact because it still travels through the same
bounded eval result:

```ts
return {
  length: scope.$lastLargeReturn.length,
  sample: scope.$lastLargeReturn.slice(0, 1_500),
};
// For a JSON-serializable original value:
const recovered = JSON.parse(scope.$lastLargeReturn);
return { keys: Object.keys(recovered), firstEntry: recovered.entries?.[0] };
// or
return /needle/.test(scope.$lastLargeConsole);
```

That fallback is for recovery, not a reporting pattern. Prefer compact
summaries first.

Prefer compact inspectors first:

```ts
return await rpc.call("main", "gad.inspectChannelEnvelopes", [
  { channelId, limit: 50 },
]);
return await rpc.call("main", "gad.inspectTurnState", [{ branchId }]);
return await rpc.call("main", "gad.inspectInvocationState", [
  { transportCallId },
]);
return await rpc.call("main", "gad.inspectPublicationIntegrity", [
  { channelId },
]);
return await services.serverLog.query({
  level: "warn",
  contains: "BuildV2",
  limit: 100,
});
```

If you need a large artifact, store the full bytes/text in the **blobstore** and
return its digest, byte count, and a small head sample. Keep full objects in
`scope` only for short-lived interactive follow-up.

The blobstore is a curated runtime binding — reach it as `services.blobstore`
(equivalently `import { blobstore } from "@workspace/runtime"`, or a raw
`rpc.call("main", "blobstore.<method>", [...])`). Read/write methods
(`putText`/`putBase64`/`getText`/`readText`/`getRange`/`grep`/…) work from agent eval; the
admin methods (`delete`/`list`) are server-only. Raw calls
use `rpc.call("main", "blobstore.<method>", [...])`. A binary
artifact such as a `Uint8Array` screenshot can be stored directly:

```ts
const png = await page.screenshot();
const { digest, size } = await services.blobstore.putBytes(png);
return { digest, size, mimeType: "image/png" };
```

At the raw service boundary, use exactly one base64 string:

```ts
const { digest, size } = await services.blobstore.putBase64(pngBase64);
return { digest, size, mimeType: "image/png" };
```

The content-addressed store records bytes only. Keep MIME type, filename, and
other artifact metadata alongside the returned digest rather than passing them
as extra `putBase64` arguments.

Preferred return shape for large artifacts:

```ts
const text = JSON.stringify(largeValue);
const stored = await services.blobstore.putText(text);
return {
  omitted: true,
  reason: "large diagnostic value stored in blobstore",
  digest: stored.digest,
  bytes: new TextEncoder().encode(text).byteLength,
  type: Array.isArray(largeValue) ? "array" : typeof largeValue,
  keys:
    largeValue && typeof largeValue === "object"
      ? Object.keys(largeValue).slice(0, 20)
      : [],
  preview: text.slice(0, 1000),
};
```

`readText(digest)` is the portable readable alias of `getText(digest)`; both
return `string | null` directly (not an object with a `text` property).

The method transport also caps oversized durable results and records a blob
digest when storage is available. Agents should still return bounded summaries
because compact results are easier to inspect and less likely to hide the
important error message. Read stored text with
`services.blobstore.getRange(digest, offset, length)` or search it server-side
with `services.blobstore.grep(digest, pattern)`.

## Build System

```
eval({ code: `
  // Build a panel at the current head and get its bundle
  const build = await rpc.call("main", "build.getBuild", ["panels/my-app"]);
  console.log("Build artifacts:", Object.keys(build));

  // Build at a specific context branch when you intentionally want to test
  // edits made in that context. `contextId` alone never selects code provenance.
  const branchBuild = await rpc.call("main", "build.getBuild", ["panels/my-app", \`ctx:\${ctx.contextId}\`]);
  console.log("Context branch build:", branchBuild.sourceStateHash);

  // VCS reports the exact semantic state; ordinary build services validate it.
  const status = await services.vcs.status({ contextId: ctx.contextId });
  console.log("Building working state:", status.workingHead);

  // Runtime launches use main code unless `ref` is explicit. This creates a
  // worker that reads/writes ctx-1 but still runs the main build:
  await rpc.call("main", "runtime.createEntity", [{
    kind: "worker",
    source: "workers/agent-worker",
    key: "agent-main-code",
    contextId: "ctx-1"
  }]);

  // Targeted branch launch for testing code edited in ctx-1:
  await rpc.call("main", "runtime.createEntity", [{
    kind: "worker",
    source: "workers/agent-worker",
    key: "agent-ctx-code",
    contextId: "ctx-1",
    ref: "ctx:ctx-1"
  }]);

  // Check effective version
  const ev = await rpc.call("main", "build.getEffectiveVersion", ["panels/my-app"]);
  console.log("Effective version:", ev);
`
})
```

## Return Values

The last expression or `return` value is serialized and sent back to the agent:

```
eval({ code: `
  const files = await fs.readdir("src");
  return files;
` })
// Agent receives a result whose returnValue is ["index.ts", "utils.ts", ...]
```

## Timeouts

Eval runs have no implicit wall-clock deadline. Pass a positive integer
`timeoutMs` when one call must finish within a known bound, especially for a
probe that may stall. At an explicit deadline, async work is cancelled normally;
synchronous authored loops and functions are stopped by cooperative sandbox
checkpoints and reported as a visible eval error rather than hanging the agent
runtime. Split long work into shorter runs when useful and carry state in
`scope` or `db` (both persist in the EvalDO between runs, across turns, and
across panel disconnects).

Match the failure mechanism to the task. For an ordinary error/recovery check,
throw the intended error in one eval and follow it with a successful eval. Use
`timeoutMs` only when the task actually calls for a deadline or potentially
non-settling work; a timeout is not a generic substitute for a thrown error.

For a timeout/recovery check, give non-settling asynchronous work a short
explicit deadline, observe the failed tool result, and then make an ordinary
successful eval call. The follow-up proves the timed-out invocation settled and
the sandbox remains usable:

```ts
eval({
  timeoutMs: 250,
  code: `await new Promise(() => {});`,
});
// Expected tool error: eval timed out after 250ms

eval({ code: `return "recovered";` });
```

Use a pending async operation for this probe, not an infinite synchronous loop:
the async form exercises normal cancellation without deliberately starving the
sandbox process.

With an explicit deadline, eval also adds cooperative checks to loops and
function entries compiled for that call, so ordinary synchronous loops and
recursion settle inside their own sandbox. Function objects retained from an
earlier unbounded eval and non-cooperative native/built-in calls cannot be
retroactively instrumented; the host process watchdog remains the final safety
boundary for those cases.

Host-side code that calls the lower-level `eval.cancel` service must inspect its
`forcedReset` result. `false` means only the requested run was cancelled and the
durable scope/user `db` were preserved. `true` means the run or its registered
cleanup did not settle during the cancellation grace period, so the EvalDO
cancelled every non-terminal run and reset its shared scope/user `db` to recover
without hanging. Do not attempt to read cleanup records from that reset scope;
report the forced recovery and start fresh.

Cancellation has an explicit durable `cancelling` phase. It is non-terminal:
the run and every admitted descendant retain their evaluated-execution
authority while registered cleanup unwinds child work, persists terminal
records, and releases owned resources. Pollers must continue through
`cancelling`; only `cancelled` means teardown has settled. A cleanup failure is
still returned to the cancel caller and recorded visibly, but the run is
terminalized so it cannot leak a permanent admission.
