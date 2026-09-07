# Panel Build, Debug, and Polish Loop

Use this bounded recipe for a task that creates or edits a panel, checks a
compiler failure, visually reviews it, exercises the live UI, and publishes it.
It is the shortest complete path; read the larger API references only when a
step returns a typed result you do not understand.

## 1. Create once

Creation is a durable phase. Store its receipt before doing anything else:

```ts
import { createProjects } from "@workspace-skills/workspace-dev";

scope.created = await createProjects([
  {
    projectType: "panel",
    name,
    title,
  },
]);
scope.panelSource = scope.created[0].created; // already `panels/name`
return scope.created;
```

Never call `createProjects` again in this workflow. A later build, open,
screenshot, locator, or publication failure does not roll creation back. If
the creation call itself has an uncertain result, inspect `scope`, `vcs.status`,
and the existing repository before deciding what remains unfinished.

## 2. Author and observe the compiler result

Use `write`/`edit` for source. Build the exact working context, not main:

```ts
const report = await services.build.getBuildReport(scope.panelSource, `ctx:${ctx.contextId}`);
return {
  status: report.status,
  diagnostics: report.diagnostics,
};
```

Repair only the cited compiler diagnostic, then rerun this same report. Do not
mix a separate UX fix into that edit when the task asks for distinct phases.

## 3. Open the unpublished context build once

Before publication, a plain `openPanel(source)` opens protected main. It will
not contain the edits you just made. Always pin the current context and retain
one handle plus its stable id:

```ts
import { openPanel } from "@workspace/runtime";

scope.panel = await openPanel(scope.panelSource, {
  contextId: ctx.contextId,
  ref: `ctx:${ctx.contextId}`,
  focus: true,
});
scope.panelId = scope.panel.id;
const observation = await scope.panel.observe();
if (observation.requestedRef !== `ctx:${ctx.contextId}`) {
  throw new Error(`Wrong panel ref: ${observation.requestedRef}`);
}
return observation;
```

Do not call `openPanel` again to refresh it. Reuse `scope.panel`. After a
reported kernel restart, recover the same panel with
`getPanelHandle(scope.panelId)` rather than opening another slot.

## 4. Capture and visually read the flawed state

Acquire one generation-fenced session for the current runtime incarnation and
return the panel handle's native screenshot result directly. Omit an exact `authority.requests` list for
ordinary eval; if intentionally attenuating, `cdp.page()` requires the exact
`panel.inspect` request documented in `BROWSER.md`.

```ts
scope.panelSession = await scope.panel.cdp.session();
const page = scope.panelSession.page;
const roles = await Promise.all(
  (await page.getByRole("button").all()).map((item) => item.inspect())
);
console.log(roles);
return await scope.panel.cdp.screenshot({ format: "png" });
```

Eval attaches this canonical screenshot result as image content. No temp file,
filesystem write authority, or follow-up `read` call is needed. Do not infer the
visual defect from source/DOM text alone.

## 5. Repair UX, rebuild the same panel, and reacquire the page

Make the separate source edit, rerun the exact-context build report, then:

```ts
const observation = await scope.panel.rebuild();
const refreshed = await scope.panelSession.refresh();
scope.panelSession = refreshed.session;
const page = scope.panelSession.page;
```

`rebuild()` keeps the panel id but replaces its runtime incarnation, so an old
page must not be reused. A generation-fenced session reports `replaced` when
that happens and returns the page for the new immutable attempt; it never
replays an uncertain interaction. Acquire the initial session with
`scope.panelSession = await scope.panel.cdp.session()`. Building, serving,
connecting, and application boot are
distinct stages and cold builds can legitimately take time; do not impose a
generic fixed deadline on `rebuild()` or on the surrounding eval cell. The
runtime has no implicit readiness deadline and reports terminal boot failures
directly. Pass a signal only when the caller owns a real cancellation boundary
(for example, a user cancelled the operation or a larger workflow has an
explicit end-to-end deadline), not as a speculative safety timeout. If such a
caller-owned cancellation fires, call `scope.panel.diagnose()` in the next cell
to retrieve the exact observation, boot failure, console history, and ready
document without rebuilding again. Capture and `read` the second screenshot
exactly as in step 4.

## 6. Exercise the rendered contract

Use the accessible roles/names you just inspected. Do not guess labels from
source and do not use `.first()`, `.last()`, or `.nth()` for repeated item
actions. Repeated controls must have item-specific names such as
`Complete Buy milk` and `Delete Buy milk`; repair the panel if they do not.

Run add, complete, filter, and delete in one bounded cell against the fresh
page. Actions auto-wait, so do not add sleeps. Finish by reading console events,
capturing the final screenshot, closing the page client, and returning compact
evidence.

When the task includes performance, read `skills/performance/SKILL.md` and wrap
the exact interaction plus its real completion condition with `page.profile()`.
Run precise JS coverage separately from the latency measurement because
coverage changes execution cost.

## 7. Commit and publish once

Read `skills/vibestudio-vcs/SKILL.md`, reobserve `vcs.status`, commit the complete
local application chain, and publish that exact committed event. A failed
protected build gate means repair source, rebuild, and commit a new event; it
never means rerun scaffold or blindly push the rejected event.

After publication, `scope.panel.rebuild()` may be used to verify protected main
only after its requested ref has deliberately been changed to main. Report the
two observed defects, both screenshot reads, exact build status, interaction
evidence, console errors, and publication receipt.
