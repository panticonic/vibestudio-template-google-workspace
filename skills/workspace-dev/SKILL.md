---
name: workspace-dev
description: Create, develop, verify, and diagnose workspace panels, workers, Durable Objects, packages, external dependency policy, and repo-local skills.
---

# Workspace development

All panels, workers, agents, and contexts in one workspace use that workspace's
materialized source and state. A context is a branch inside the workspace, not
a cross-workspace source loader. Quickfire stays with the workspace of its
target panel. Personal and System are private per-user workspaces; native
client code comes from the user's System workspace, while `about/new` and
other workspace-local pages load locally. Do not add cross-workspace source
loading or application RPC forwarding. The transport can carry qualified
identities, but forwarding remains closed pending the receiver-trust versus
per-invocation-isolation decision.

Use [app development](../appdev/SKILL.md) for trusted apps and [extension
development](../extensiondev/SKILL.md) for trusted Node services.

## Read by task

| Task                                                           | Reference                                  |
| -------------------------------------------------------------- | ------------------------------------------ |
| Development loop                                               | [WORKFLOW.md](WORKFLOW.md)                 |
| External dependencies, overrides, and patches                  | [DEPENDENCIES.md](DEPENDENCIES.md)         |
| Build, inspect, polish a panel                                 | [PANEL_DEBUG_LOOP.md](PANEL_DEBUG_LOOP.md) |
| Panel lifecycle, observation, failure diagnosis, host commands | [PANEL_API.md](PANEL_API.md)               |
| Workers, DOs, service-backed data, agent workers               | [WORKERS.md](WORKERS.md)                   |
| Typed parent-child contracts                                   | [RPC.md](RPC.md)                           |
| CDP/browser automation                                         | [BROWSER.md](BROWSER.md)                   |
| Agent tool recipes                                             | [TOOLS.md](TOOLS.md)                       |
| Existing unit status, logs, and release history                | [sandbox runtime API](../sandbox/RUNTIME_API.md#current-workspace) |
| Icons and unit identity                                        | [references/icons.md](references/icons.md) |

Also read [capabilities](../capabilities/SKILL.md) before adding authority,
[performance](../performance/SKILL.md) before changing startup cost, and
[Vibestudio VCS](../vibestudio-vcs/SKILL.md) before managed-source operations.

## Diagnose panel loading first

For a preparing, blank, failed, or stuck panel, start at [PANEL_API
diagnostics](PANEL_API.md#diagnostics). Reuse the existing handle, call its
read-only `observe()`, then one bounded `diagnose()` call. That packet owns the
active attempt, phase, failure, host state, console history, and build
provenance.

Escalate only from that evidence: exact-entity supervision, exact source/ref
build report, or server logs when the packet places the failure below the panel
lifecycle. Never rebuild, reload, open a duplicate, enter VCS, or inspect test
sources merely to discover the failing layer. Use performance profiling only
after lifecycle health is established.

## Repo-local skills

Put implementation-specific guidance beside its code as `<repo>/SKILL.md` (e.g.
`packages/foo/SKILL.md`). Use `skills/<name>` only for cross-repository
workflows or reusable skill packages. Keep method rosters, generated schemas,
and volatile constants in live docs or code — a repo-local skill explains
purpose, workflow, ownership, invariants, and diagnostics.

## Core rules

- Build production-ready systems. Workspace units are durable infrastructure,
  not throwaway prototypes: design for real use from the start with proper state
  persistence, exact current schemas, error surfaces, principled authority, and
  tested edge cases. Do not populate applications with hardcoded demo or fake
  data — build real empty states, real data-entry flows, and real persistence.
- Use workspace-root-relative paths. Never put host checkout paths in workspace
  source or tool arguments.
- Treat an ordinary workspace's `admin`/`member` membership role as separate
  from the authenticated account's `accountRole`. Personal and System remain
  private regardless of ordinary workspace membership APIs.
- Declare every package you import, and declare it in the right place: a unit
  loaded on its own (panel, about page, app, worker, extension) owns React and
  its UI kit in `dependencies`; a unit loaded into someone else's realm (skill,
  package) declares them in `peerDependencies` so it uses the realm's live
  instances. Nothing is installed on your behalf. See [external dependency
  resolution](DEPENDENCIES.md#own-it-or-let-the-realm-provide-it).
- Use structured read/edit/write/move/copy and semantic VCS tools for managed
  files. Use eval for runtime operations, not as a file editor or shell.
- Use `verify` for exact-context build checks and focused tests.
- Declare every in-app test suite in `package.json#vibestudio.tests`. Choose the
  production-matched runtime explicitly: `browser` for panels/DOM behavior,
  `workerd` for workers and portable logic, and `native` only for Node,
  Electron, extension, filesystem, socket, or process behavior. Runtime is
  reviewed source and never falls back to native.
- Browser/workerd suite files import test primitives from
  `@workspace/test-runtime`, which must be a declared `workspace:*` production
  dependency. Test artifacts use the semantic executable dependency projection,
  so `devDependencies` are intentionally unavailable in the sandboxed realm.
  Native suites may use Vitest. When a unit has multiple suites, pass `suite`
  to `verify`; `file` is always relative to the unit and must belong to that
  suite.
- Browser verification opens the ordinary visible `about/testbench` panel and
  launches the exact sealed test artifact as a visible child panel. The child
  receives the complete production panel runtime, including the real document,
  RPC, and the normal `fs`/`path` build shims. Workerd suites likewise launch as
  complete disposable worker entities with normal workerd compatibility. An
  interactive client displays the child; the managed headless client is the
  always-available hosting fallback. A hosting failure is infrastructure,
  never permission to reroute code to Node.
- In eval, use ambient `scope`, `scopes`, `db`, `ctx`, `help`, `chat`, and
  `agent` directly. Portable runtime bindings are also importable from
  `@workspace/runtime`; see [sandbox eval](../sandbox/EVAL.md).
- Retain mutating receipts in `scope` before awaiting a later step — eval is not
  transactional.
- Reuse handles, archive temporary panels, and close temporary pages, workers,
  and diagnostics.
  After an eval-kernel restart, reacquire a lost handle from its retained stable
  ID.
- Give every panel and worker a semantic manifest icon from the [shared
  guide](references/icons.md). Use `@workspace/ui/icons` for controls.
- Inspect accessible roles and names before automation — repeated item controls
  need item-specific accessible names, not ordinal guesswork.
- Respect the host theme and narrow mobile viewports.

## Creative imagery and visual assets

Proactively use `imagegen` when original imagery would improve the work's
meaning, character, or usefulness. Consider illustrations for stories and
learning materials, game sprites and scenery, textures, concept art, editorial
images, and visual explanations. This applies to project content as well as
interfaces: a request need not explicitly ask for image generation when a visual
asset clearly serves the user's goal. Give each image a purpose in the finished
work and preserve the user's chosen style and scope.

Describe the subject, composition, visual style, and intended use in `prompt`.
Save reusable assets with `outputPath` inside the existing target repository;
use `.tmp/` for exploratory variants. The tool uses the connected OpenAI Codex
subscription and records managed binary writes through semantic VCS. Its live
schema documents size, quality, background, and output format options.

Inspect the returned image or use `read` before deciding it is ready. To refine
an image, supply its workspace path in `referencePaths` and describe what should
change and what should remain consistent. Prefer a new output path for variants;
intentional replacement uses `createOnly: false` with the normal observed-file
conflict protection. Check the chosen asset in its actual layout or content,
including cropping, scale, and theme where relevant, and share it with
`notify` attachments. Keep exact text, data plots, and structural diagrams in
editable code or vector form when correctness depends on their precise content;
continue using the shared icon system for UI controls and unit identity.

## Persistence and programmable surfaces

Treat an application that creates or changes user data as requiring durable
storage unless the user explicitly describes that data as disposable. Use
Durable Object SQLite for transactional shared application state. Use
version-controlled files under `projects/` for content benefiting from history,
diffing, and collaboration. Panel state args, eval scope, component state, and
process memory are presentation or scratch state, never the sole home of
meaningful application data.

For a panel or app backed by a workspace service, work contract-first before
building the UI:

1. Read [the service-backed data workflow](WORKERS.md#durable-object-backed-app-databases).
2. Define and verify the provider's real `@rpc` methods and its service declaration.
   Never invent a placeholder method name.
3. Add the consumer's `authority.serviceRequests` declaration in the same change.
4. In the consumer, narrow `workers.resolveService(...)` by `kind` before using
   kind-specific fields such as `targetId` or `routeBasePath`.
5. Verify the provider, then a minimal consumer call, before expanding the UI.

For an existing declared service, verification proves only the context candidate.
Before the minimal live call can use a new or changed RPC method, commit the
provider edits and publish its repository. Wait for publication to finish, then
resolve the service again and call the method. A green `verify` result never
updates the active service build.

Expose application operations as narrow, app-shaped RPC methods with explicit
receiver contracts. Use channels and structured events when collaboration is
part of the product. Keep UI projection methods out of the domain API.

## Scaffold projects

Use `createProjects` for one coherent publication of related units:

```ts
import {
  createProjects,
  searchProjectCatalog,
} from "@workspace-skills/workspace-dev";

const [databaseCatalog, panelCatalog] = await Promise.all([
  searchProjectCatalog({ resource: "icon", query: "database", limit: 5 }),
  searchProjectCatalog({
    resource: "icon",
    query: "panels top left",
    limit: 5,
  }),
]);
const databaseIcon = databaseCatalog.entries[0]?.id;
const panelIcon = panelCatalog.entries[0]?.id;
if (!databaseIcon || !panelIcon)
  throw new Error("Required catalog icons are unavailable");

scope.created = await createProjects([
  {
    projectType: "worker",
    name: "task-board-store",
    title: "Task Board Store",
    icon: databaseIcon,
    template: "durable-service",
  },
  {
    projectType: "panel",
    name: "task-board",
    title: "Task Board",
    icon: panelIcon,
  },
]);
return scope.created;
```

Pass a one-element array for a single unit. Each result returns the canonical
repository path, created files, preflight evidence, and publication receipt.

If publication fails after creation, follow the structured retry policy and
recover or repair the already-created repository — never call `createProjects`
again. If a later open or snapshot fails, resume from the stored creation
receipt. An existing destination is not part of the attempt; choose a distinct
name or stop.

Use context-local project files when the user wants private scratch content
rather than a published executable unit. For source adoption, use explicit
copy, compare, and merge operations that preserve provenance; source ancestry
does not grant access or install a live upstream.

## Open and verify panels

`openPanel(source, options)` waits for the selected runtime attempt's boot
handshake. `createPanelSlot` returns only the durable tree placement. Neither a
slot nor boot readiness proves rendered UI correctness.

For unpublished code, pass the exact context and `ctx:<contextId>` ref. After
open or rebuild, return the observation and a structured snapshot from the same
handle. Keep the handle and stable panel ID together in scope.

Use `PANEL_DEBUG_LOOP.md` for authoring and polish. For host chrome actions,
follow [host commands](PANEL_API.md#host-commands): the panel owns command
meaning and execution; desktop and mobile hosts own presentation and routing.

## Development and runtime provenance

Author from the exact working head, run focused checks, commit the complete
local application chain, and publish explicitly. Work that needs a separate
commit boundary belongs in another context.

Workers and DOs normally follow their owning context. Panels need an explicit
context ref when testing unpublished source. If a change appears absent, inspect
the current VCS relation, requested/effective ref, build key, runtime identity,
and rebuild observation before editing again — never infer revision from
filesystem dirtiness or renderer presence.

Panel lifecycle APIs and semantic checks work in headless eval, but visual
presentation and CDP require an available host. Workspace catalog selection and
creation belong to the human shell's hub session, not workspace eval.
