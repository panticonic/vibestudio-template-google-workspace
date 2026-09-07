---
name: testkit
description: Write and run deterministic in-system tests with @workspace/testkit, including panel automation, worker and Durable Object orchestration, runtime supervision, and bounded profiling. Use system-testing instead when an LLM must perform or judge the scenario.
---

# Testkit

`@workspace/testkit` is the deterministic layer beneath agentic system tests.
Use it when expected behavior can be asserted directly. Use
[system testing](../../skills/system-testing/SKILL.md) when a model must
interpret instructions or outcomes.

For the complete public API, read `src/index.ts`; for ready-to-run recipes, read
[`references/examples.ts`](references/examples.ts). Use the
[performance skill](../../skills/performance/SKILL.md) for measurement design,
cold/warm semantics, and cleanup rules.

## Eval conventions

- `scope`, `scopes`, and `chat` are ambient eval globals; do not import them.
- Store full results in `scope` and return only `summarize(result)`.
- Runs and profiles are written under `/.testkit/`; do not inline large reports,
  CPU profiles, or heap snapshots.
- `panelTree` is the top-level runtime API. There is no
  `workspace.panelTree` namespace.

## Run deterministic suites

```ts
import { allSuites } from "@workspace/testkit/suites";
import { runSuites, summarize } from "@workspace/testkit";

const result = await runSuites(allSuites());
scope.testkitRun = result;
return summarize(result);
```

The base package contains only base-workspace suites. Feature packages own
their feature-specific suites; import those explicitly.

For a focused case:

```ts
import {
  expect,
  openPanel,
  panelText,
  runSuites,
  suite,
  summarize,
  waitForText,
} from "@workspace/testkit";

const greeting = suite("greeting").test("renders", async (t) => {
  const panel = await openPanel("panels/my-app");
  t.defer(() => panel.archive());
  await waitForText(panel, "Hello");
  expect(await panelText(panel), "panel text").toContain("Hello");
});

const result = await runSuites(greeting);
scope.testkitRun = result;
return summarize(result);
```

Tests supervise panels they open and run deferred cleanup in LIFO order. Opt
out of supervision only when the case intentionally produces the observed
failure. Do not automate the panel hosting the current eval.

## Panels, workers, and supervision

`openPanel` and `withPanel` wait for boot readiness. Shell panel creation only
commits a slot; do not substitute it and add a sleep. Existing panels must be
addressed through bounded `panelTree` reads.

The package also exposes panel text and CDP helpers, worker/DO lifecycle calls,
unit diagnostics, and `supervise(...)`. Discover exact signatures in
`src/index.ts` or live docs rather than copying an API catalog into a skill.
Always select exact live runtime identities for supervision and logs.

## Profiling

Start with the cross-layer helpers exported from `@workspace/testkit`:

- `profileBuild` for first-path and verified-cache build evidence;
- `profileHost` for server, workerd, and event-loop measurements around one
  workload;
- `profilePanelInteraction` or `profilePanelReload` for browser-native page,
  runtime, and network evidence;
- `profileWorkerd` or `profileDO` for bounded V8 CPU profiles;
- `readStartupProfile` for current-boot phases.

These helpers bound their reports and own inspector/page cleanup. Electron
process counters require `client_eval` because they are client-affine. Use raw
CDP or inspector sessions only when the compact helpers cannot answer the
question, and close every acquired session.

## Approval and cleanup

Panel automation, workerd inspection, host logs, and structural panel creation
may require their normal scoped approvals. Let the real operation request them;
do not add a bypass or preflight permission query.

Every test must clean up panels, page clients, workers, temporary data, and
supervisors it owns. Keep state only when the user or harness explicitly asks
for it.

The `about/testbench` UI can run suites and inspect saved runs and profiles.
Use it when a human needs live progress or flamegraph inspection; direct eval
is simpler for automation.
