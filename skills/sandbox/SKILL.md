---
name: sandbox
description: Run server-side eval or build chat-panel interactions with inline UI, action bars, custom messages, feedback, browser automation, and runtime APIs.
---

# Sandbox execution

`eval` runs server-side in the caller's per-agent EvalDO. Inline UI, action
bars, and feedback components render in a connected chat panel.

## Read by task

| Task | Reference |
| --- | --- |
| Eval, imports, timeouts, cancellation, scope, filesystem | [EVAL.md](EVAL.md) |
| Portable runtime clients and services | [RUNTIME_API.md](RUNTIME_API.md) |
| Persistent chat components | [INLINE_UI.md](INLINE_UI.md) |
| Pinned panel controls | [ACTION_BAR.md](ACTION_BAR.md) |
| Typed custom transcript messages | [CUSTOM_MESSAGES.md](CUSTOM_MESSAGES.md) |
| Ordinary rich chat content | [MDX.md](MDX.md) |
| Blocking user feedback | [FEEDBACK.md](FEEDBACK.md) |
| Chat and channel operations | [CHAT_API.md](CHAT_API.md) |
| Panel/browser CDP automation | [BROWSER_AUTOMATION.md](BROWSER_AUTOMATION.md) |
| Common recipes | [PATTERNS.md](PATTERNS.md) |
| Choosing an interaction surface | [INTERACTION_PATTERNS.md](INTERACTION_PATTERNS.md) |

Use `help()` inside eval for the injected/importable runtime surface,
`help("<binding>")` for its methods. Use `docs_search`/`docs_open` as agent
tools for live service schemas — they are not eval functions.

## Execution surfaces

| Surface | Runs in | Use for |
| --- | --- | --- |
| `eval` | server-side EvalDO | imperative code, services, files, persistent agent scope |
| `inline_ui` | chat panel | persistent interactive transcript content |
| `load_action_bar` | chat panel | compact controls pinned above history |
| `feedback_form` / `feedback_custom` | chat panel | responses the agent must await |

Panel-only tools are absent in headless sessions. Return data from eval and use
normal conversation when no renderer is connected.

## Eval essentials

`scope`, `scopes`, `db`, `ctx`, `help`, and — when agent-owned — `chat` and
`agent` are ambient eval bindings. Portable clients (`rpc`, `services`, `fs`,
`workers`, `credentials`, `gad`, `panelTree`) are injected and importable from
`@workspace/runtime`.

Workspace and platform packages resolve on first use. Raw inline code declares
npm packages through the eval `imports` map; file-loaded code infers them from
the nearest `package.json`. Use static relative imports. See [EVAL.md](EVAL.md)
for details.

Eval `db` and `scope` belong to the agent's EvalDO. Scope persists serializable
values across reloads but cannot restore functions or live handles. Put shared
application data behind a manifest-declared Durable Object service with narrow
RPC methods — never treat eval storage as an app database.

`panelTree.self()` identifies the EvalDO runtime, not the visible chat panel.
Resolve visible parents/siblings/children through bounded panel-tree reads, then
read the target panel's state args for its channel identity.

Account, workspace membership, live presence, channel participants, and runtime
identity answer different questions. Use the specific API in
[RUNTIME_API.md](RUNTIME_API.md); never infer a verified user from an agent or
runtime entity.

Every eval call runs in the current workspace and context. Contexts are
workspace-local branches, not a way to load source from another workspace.
Quickfire remains attached to the workspace of its target panel. An ordinary
RPC call may select one exact destination workspace through its call options;
omission always means the current workspace and never searches elsewhere.
Cross-workspace calls require the receiver method's explicit `crossWorkspace`
exposure plus the source's outgoing and destination's incoming governing
policies. Those hard policies are checked before ordinary service/capability
authority and cannot be enabled by mutable workspace code or an approval.

## Component essentials

Inline, action-bar, and feedback source files must default-export a component.
Read the matching reference for injected props and lifecycle. Component scope is
browser-local — not eval scope or shared application state.

Use stable inline IDs when rerendering one workflow. Send user-authored
follow-up prompts with `chat.send(...)`; publish custom visual state only
through typed custom-message APIs. Never construct raw transcript rows.

Use inline UI for side effects with meaningful choices, progress, retry, or
failure state. Keep simple status in ordinary chat; use feedback only when the
agent truly needs the returned decision.

## Paths and source

- Tool `path` arguments are context-relative, no leading slash.
- Workspace source uses root-relative paths: `packages/`, `panels/`, `workers/`,
  `skills/`, `apps/`, `extensions/`, `meta/`. Never use host checkout paths.
- Use `fs.mktemp`/`fs.mkdtemp` for disposable state and clean it up.

Read [Vibestudio VCS](../vibestudio-vcs/SKILL.md) before changing managed
source. Build and test the exact working state, commit the complete local chain,
and publish explicitly.

## Browser and credential safety

Use `handle.cdp.session()` for multi-step browser automation and its
generation-fenced canonical Playwright-style page; reserve `handle.cdp.page()`
for one-off work. Never install a separate Playwright package. Acquire
protocol-level CDP only when needed; close every page/session you own.

For authenticated HTTP, call the host-mediated credential operation directly.
Never expose credential material or invent authority wildcards. See [API
integrations](../api-integrations/SKILL.md) for setup and egress rules.

## Completion rules

- Bound eval results; store large reports or handles in scope or files.
- Archive temporary panels and close temporary CDP clients, workers, and other
  resources in `finally` unless the user asked to keep them.
- Let protected operations use their normal authority flow — never add preflight
  calls, retries, or alternate transports just to avoid approval.
- Treat optional missing packages as separate optional probes; don't let one
  failed import obscure otherwise useful results.
