---
name: git-bridge
description: Import or export managed repositories through external Git remotes, configure upstreams, diagnose synchronization, or develop extensions/git-bridge. Use for git.upstreams, git.remotes, pull, push, repository publication, and deciding between semantic VCS and Git operations.
---

# Git Bridge

Git Bridge is an interchange adapter. Semantic VCS owns managed workspace
state, identity, provenance, integration, commits, and protected `main`. Git
owns external commits, refs, checkouts, and transport. Read
[Vibestudio VCS](../../skills/vibestudio-vcs/SKILL.md) before changing managed
content.

```text
Git HEAD -> immutable snapshot -> unpublished semantic candidate
                                      |
                            compare and merge
                                      v
working applications -> commit -> protected main -> Git export
```

The server checkout under `state/git-checkouts/<repoPath>` is disposable
interchange state. It is never managed source, build input, or semantic
history.

## Discover the public contract

Workspace code uses the typed `git` namespace from `@workspace/runtime`.
Agents should use `docs_search` and `docs_open` for its current schemas.
Command-line workflows use `vibestudio vcs git`; run
`vibestudio vcs git --help` for current commands and flags. Do not call the
extension package directly from userland.

```ts
import { git } from "@workspace/runtime";

await git.setSharedRemote("projects/bgkit", {
  name: "origin",
  url: "https://github.com/acme/bgkit.git",
  branch: "main",
});
await git.setUpstream("projects/bgkit", {
  remote: "origin",
  branch: "main",
  credential: "github-workspace",
  autoPush: false,
});

const status = await git.upstreamStatus(["projects/bgkit"]);
```

An empty repository list asks for every configured upstream. Every status call
observes the remote; when observation fails, do not substitute retained
telemetry for current relationship or commit counts.

## Import and pull

`git.importProject()` configures and clones an absent repository.
`git.pullUpstream()` fetches a configured upstream. Both return an unpublished
semantic candidate; neither advances protected `main`.

1. Preview a pull with `dryRun: true` when the remote may be ahead or diverged.
2. Retain the returned candidate context and event.
3. From the intended working context, compare and merge the candidate through
   semantic VCS.
4. Run focused checks, commit the complete local application chain, and publish
   it explicitly.
5. Re-read upstream status before exporting or pushing.

An import must describe one complete Git HEAD tree. Resolve the remote's
advertised default branch when none is supplied. Reject dirty checkouts,
unsupported entry modes, excluded paths, or snapshots above the semantic
import bound; never truncate or silently omit tracked content. Keep
credentials out of remote URLs and record only a credential-free source URI.
Do not infer semantic moves, copies, or authorship from Git history or
similarity heuristics.

The candidate result includes the context, event, and semantic import evidence.
For consequential verification, inspect those exact roots with `provenance`.
The source URI and revision describe the observed snapshot; they do not assign
per-file authorship.

## Export and push

Export reads one exact protected-main repository state and materializes only
its tracked files, deletions, and executable modes. The exported Git commit
contains semantic repository, state, and event trailers so the bridge can
recognize its own projection without a second identity store.

`git.pushUpstream()` exports and pushes protected `main`.
`git.publishRepo()` creates a provider repository, configures it, exports, and
pushes. Auto-push may export an already-published event, but it must stop while
an import candidate is unresolved. Force-push is an explicit recovery action
that requires overwrite evidence and user approval.

Refuse export or push when status is `integration-required`. Preserve useful
states such as `auth-failed`, missing branch, and `diverged`; do not flatten
them into a generic failure or retry with broader authority.

## Ownership and safety

- The extension owns server-local checkout materialization, Git processes,
  transport, provider dispatch, and per-repository locking.
- Semantic VCS owns managed meaning and publication. The bridge may read exact
  state and import snapshots; it has no semantic publication shortcut.
- The host owns policy, approval, credentials, and workspace configuration.
- Provider packages own provider-specific repository creation and API checks.
- Credentials flow through the host-mediated Git HTTP adapter. Never expose,
  log, return, or splice tokens into URLs.
- Clients use RPC through the connected server. Do not add client-filesystem
  shortcuts for remote sessions.

## Diagnostics and development

Select the extension's exact live identity before reading its health or logs:

```ts
const live = await runtime.supervision.list({ kind: "extension" });
const bridge = live.find((entry) => entry.source === "extensions/git-bridge");
if (!bridge) throw new Error("Git bridge is not live");
return runtime.supervision.health(bridge.identity, { level: "warn" });
```

For API shape, inspect `packages/service-schemas/src/gitInterop.ts` and the live
generated docs. For implementation, start with `index.ts`, `bridge.ts`, and
`upstream.ts` in this extension, then follow direct imports. Run the focused
bridge tests and the affected schema, runtime, CLI, and configuration tests;
use repository-wide doc checks only when a public contract changed.
