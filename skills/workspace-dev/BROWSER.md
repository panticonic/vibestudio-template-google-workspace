# CDP Panel Automation

CDP automation is available on any panel-tree target through `PanelHandle`.
Use top-level `panelTree` for existing panels; `workspace.panelTree` is not part
of the runtime surface. For web browsing or website automation, open or reuse a
dedicated browser panel. Existing workspace panels, especially chat panels, are
application surfaces: inspect them when that app is the target, but do not use
them as disposable web pages.

```ts
import { openPanel, openExternal } from "@workspace/runtime";

const handle = await openPanel("https://example.com", { focus: true });
let session = await handle.cdp.session();
let page = session.page;

await page.goto("https://example.com");
await page.getByRole("button", { name: "Sign in" }).click();
await page.locator("input[name=query]").fill("Vibestudio");
await page.locator(".search-button").click();
await handle.click(".search-button"); // same target, convenience wrapper

// Prefer the top-level handle lifecycle methods for workspace panels because
// they return the resulting PanelObservation.
await handle.cdp.navigate("https://other.com");
await handle.cdp.goBack();
await handle.cdp.reload();

await openExternal("https://docs.example.com");
await session.close();
```

For ordinary eval calls, omit `authority.requests` and let the run adapt to the
authority already admitted for the agent. If the workflow deliberately uses an
exhaustive per-run allowlist, `handle.cdp.page()` requires `panel.inspect` for
the panel selected by the handle (the capability is `panel.inspect`, not
`cdp.page`):

```ts
eval({
  code: `const page = await scope.panel.cdp.page(); return await page.title();`,
  authority: {
    effects: "read-write",
    requests: [
      {
        capability: "panel.inspect",
        resource: { kind: "prefix", prefix: "" },
      },
    ],
  },
});
```

`timeoutMs` is a top-level eval option alongside `authority`; it is never a
field inside the authority object. Eval has no default wall-clock deadline; do
not add one to ordinary panel creation, readiness, or CDP work. Use it only when
the task itself has a real deadline or is deliberately probing potentially
non-settling behavior. A supplied `requests` array is exhaustive, so do not
guess capability names. Omit it unless intentional attenuation is part of the
task.

`handle.cdp.session()` returns a generation-fenced lease around the canonical
Playwright-style page driven by our workerd-native CDP client
(`@workspace/cdp-client`). The session records the immutable `attemptId`,
`runtimeEntityId`, and `buildKey` that own the page. Use it for multi-step
automation or any workflow that may rebuild or navigate the panel.

`handle.cdp.page()` returns the same canonical Playwright-style page without a
generation lease. It is appropriate for a one-off read or action when no panel
lifecycle operation can race the call. These are two ownership levels over one
browser-automation surface, not separate clients or compatibility tiers. Do
not import or install any `playwright*` package, and do not import
`@workspace/cdp-client` directly for ordinary page work.

`handle.cdp` does not proxy page methods. In particular,
`handle.cdp.evaluate()` does not exist: acquire a session and call
`session.page.evaluate(...)`. Page evaluation returns the decoded callback
value directly, so do not append `.result?.value` as if using raw CDP.

Navigation belongs to browser panels. On a workspace app panel, `page.goto()`,
`page.reload()`, `page.goBack()`, and `page.goForward()` reject instead of
bypassing the panel lifecycle. Use
`await handle.reload()` for the current workspace build or
`await handle.rebuild()` after source changes; both return a
`PanelObservation`, while the original `handle` remains the handle.

For bulk navigation or imported browser tabs that should remain unloaded until
the user visits them, use `createPanelSlot(url)` instead. It commits the durable
browser slot and returns without focusing or waiting for the document. Such a
slot observes as `pending` and has no CDP generation. When materialization is
needed for automation, acquire `await handle.cdp.session()`. Session acquisition
expresses active inspection demand, materializes without changing desktop focus,
waits for application readiness, and then fences the connection to that exact
generation. Raw CDP can mutate the page, so session acquisition belongs in a
read-write eval. A read-only eval can use bounded read helpers such as
`handle.cdp.screenshot()` and `handle.cdp.consoleHistory()` instead.

## Ownership and lifetime contract

`PanelHandle` owns the target; `CdpPage` owns one automation connection to that
target. The boundary is exact:

- `await handle.cdp.session()` creates one authenticated CDP connection fenced
  to the handle's current immutable panel generation. `session.page` owns the
  automation connection and `session.generation` records its provenance.
  Concurrent or repeated calls on the same handle reuse that active session
  until it is closed or the generation changes.
- `await handle.cdp.page()` creates the same connection without a generation
  lease for one-off work.
- `await page.close()` disconnects only that automation client. It does not
  close, unload, navigate, or otherwise mutate the panel.
- Eval is a notebook kernel, not an invocation sandbox. A page stored in
  `scope` remains the same live object across cells while the kernel activation
  remains resident; no idle request pins that activation. Call `page.close()`
  explicitly when finished.
- Durable scope persistence is a recovery snapshot, not the live heap. A page
  or other class instance cannot be reconstructed after kernel restart; retain
  stable identity alongside it and reacquire only after `[kernel] Restarted`
  reports that exact live value as lost.
- `await handle.archive()` removes an owned panel subtree and therefore invalidates page
  clients connected to that target.
- A handle obtained from `panelTree` is non-owned unless the current workflow
  created it. Disconnecting your `page` is safe; closing the handle is not.
- Browser `page.goto()` navigation keeps the same CDP target and page
  connection. Workspace-panel `handle.navigate()` and `handle.rebuild()`
  replace the runtime incarnation. After either operation, call
  `const refreshed = await session.refresh()` and continue with
  `session = refreshed.session; page = session.page`. A `replaced` result
  includes the prior generation; `reconnected` means the connection died while
  the generation remained current. Refresh never replays the interrupted
  browser action.

```ts
const session = await handle.cdp.session();
try {
  const page = session.page;
  await page.getByRole("button", { name: "Add list" }).click();
  await page.getByPlaceholder("List name").waitFor({ state: "visible" });
} finally {
  await session.close();
}
```

Use bounded `panelTree.roots`/`panelTree.children`/`panelTree.search` or
addressed `panelTree.get` for existing panels. Use `rootOwners()` and
`rootsForOwner(ownerUserId)` when explicitly inspecting another ownership
band. Existing handles
are non-owned: do not call `handle.navigate`, `handle.reload`, or
`handle.archive` on them unless requested. Do not call `handle.cdp.navigate(url)`
or `page.goto(url)` on the current chat panel, a parent chat panel, or another
workspace panel unless the requested task is to replace that exact panel. Open a
browser panel for arbitrary URLs, login flows, scraping, and browser navigation.

```ts
// Later, when an owned temporary panel is no longer needed:
await scope.page?.close();
await scope.browser?.archive();
delete scope.browser;
delete scope.page;
```

Reuse one handle and one generation-fenced session per multi-step workflow.
Repeated `openPanel()` calls without the same `operationId` create distinct panels, and repeated
`handle.cdp.page()` calls create duplicate one-off CDP connections. Repeated
`handle.cdp.session()` calls on the same handle reuse its active session. After
a possible replacement, refresh the existing session and use the returned
session.

## Where it runs

The CDP client is workerd-native: it works in panels **and** in
worker/DO/server-side-eval contexts. It runs over a WebSocket to the panel's CDP
endpoint, so any context that holds a panel handle can drive the page —
including server-side `eval`. `openPanel`/`panelTree`/`getPanelHandle` are part
of the portable runtime surface from `@workspace/runtime`, so server-side eval
can create or acquire a panel handle directly before driving CDP automation.

## Page surface

`session.page` (or a one-off `handle.cdp.page()`) is the canonical
Playwright-style page. Actions
auto-wait for the element to be visible/stable/enabled before acting and
return a `cdp-interaction-outcome.v1` receipt after the browser event is
delivered. Delivery is not proof that application state changed. Pass a
locator postcondition when the effect matters; the receipt then reports the
observed semantic condition. Do not add sleeps between `fill()`, `press()`,
`click()`, or other sequential actions.

```ts
const session = await handle.cdp.session();
const page = session.page;

// Discover the live accessibility contract before choosing named locators.
const buttons = await page.getByRole("button").all();
const buttonSemantics = await Promise.all(buttons.map((button) => button.inspect()));
// Records include role, accessibleName, text, attributes, visibility, box,
// and nearest rendered ancestors (with their roles, names, and text).

// Locators
page.locator("css selector");
page.locator('text="Exact text"'); // compiled to the getByText semantic engine
page.locator("text=substring"); // compiled to non-exact getByText semantics
page.getByRole("button", { name: "Sign in", exact: true });
page.getByText("Welcome");
page.getByLabel("Email");
page.getByPlaceholder("Search");
page.getByTestId("submit");
page.getByAltText("Logo");
page.getByTitle("Close");

// Chaining
page.getByRole("listitem").filter({ hasText: "active" }).nth(2);
page.locator(".row").first();
page.locator(".row").last();
const rows = await page.locator(".row").all();

// Actions (auto-wait)
const saved = await page.getByRole("button", { name: "Save" }).click({
  expect: {
    locator: page.getByText("All changes saved", { exact: true }),
    state: "visible",
  },
});
// saved.effect.status === "observed" and saved.effect.state === "visible"
await page.locator(".item").dblclick();
await page.locator(".item").hover();
await page.getByLabel("Email").fill("user@example.com");
await page.getByLabel("Email").type("user@example.com");
await page.getByLabel("Email").clear();
await page.locator("input").press("Enter");
await page.keyboard.press("Control+A");
await page.keyboard.type("replacement");
await page.keyboard.insertText("inserted in one browser operation");
await page.setViewportSize({ width: 390, height: 844 });
page.viewportSize(); // synchronous current CSS viewport
await page.getByRole("checkbox").check();
await page.getByRole("checkbox").uncheck();
await page.getByRole("checkbox").setChecked(true);
await page.getByLabel("Country").selectOption("US");
await page.getByLabel("Country").selectOption({ label: "United States" });
await page.locator("input").focus();
await page.locator("input").blur();
await page.locator(".far-below").scrollIntoViewIfNeeded();

// Reads / state
await page.locator(".modal").waitFor({ state: "visible" });
await page.locator(".row").count();
await page.locator(".badge").isVisible();
await page.getByRole("checkbox").isChecked();
await page.locator("button").isEnabled();
await page.locator("button").isDisabled();
await page.locator("input").isEditable();
await page.locator("a").getAttribute("href");
await page.locator("input").inputValue();
await page.locator(".title").innerText();
await page.locator(".title").textContent();
await page.locator(".row").allInnerTexts();
await page.locator(".row").allTextContents();
await page
  .locator(".row")
  .first()
  .evaluate((row) => row.textContent?.trim());
await page.locator(".row").evaluateAll((rows) => rows.map((row) => row.textContent?.trim()));
await page.locator(".box").boundingBox();
await page.locator(".box").inspect();
```

String locators use normalized, case-insensitive substring matching by default;
`{ exact: true }` selects a case-sensitive whole-string match. The `isVisible`,
`isChecked`, `isEnabled`, `isDisabled`, and `isEditable` methods are immediate
snapshots and return `false` when there is no current match. Use `waitFor` when
absence should be retried.

Accessible names are computed from the live DOM. Descendant text such as a
numeric badge is part of a button's name, so a visually grouped `Done` + `3`
button may be named `"Done 3"`. Discover the names first, then use the exact
string or a deliberate regular expression such as `/^Done\b/`. When a named
role locator misses, `CdpError` reports the available names for that role.
If the accessible name exists under another role, the error reports those
role/name pairs as well; use the rendered role rather than guessing from text.

Automation failures are structured as `CdpError.errorData` with `code`,
`operation`, `failureKind`, and `recovery`. An exhausted auto-wait is
`cdp_locator_state_mismatch` and includes its locator, requested state, and
timeout. A failed `click({ expect })` is
`cdp_interaction_outcome_not_observed` and includes both the dispatched and
expected locators. A command timeout or closed target directs the caller to
inspect panel diagnostics and acquire a fresh page from the stable panel handle;
the old page connection is no longer reusable.

Controls repeated for collection items must have item-specific accessible
names. Treat repeated `"Mark task as completed"` buttons as an accessibility
defect and repair the app to expose names such as
`"Complete Write release notes"` before testing the interaction. Do not guess
item identity with `.first()`, `.last()`, or `.nth()`. If an external page
cannot be repaired, call `all()` and `inspect()` first; each inspection includes
nearest-ancestor context so an ordinal can be chosen from rendered evidence.

`locator()` accepts CSS plus the standard `text=` selector form. It does not
forward `text=` to `querySelectorAll`: quoted JSON strings mean exact text and
unquoted values mean substring text, both compiled into the same canonical
descriptor used by `getByText`. Prefer the explicit `getBy*` form in authored
code; the selector form is useful when translating an existing Playwright
interaction.

Page-level methods (navigation methods are browser-panel-only):

```ts
await page.goto("https://example.com");
await page.reload();
await page.goBack();
await page.goForward();
await page.title();
page.url(); // string, synchronous like Playwright
await page.content(); // full HTML
// Evaluation is bounded by the page's default timeout unless overridden.
await page.evaluate(() => document.title);
await page.evaluate(() => new Promise(() => {}), undefined, { timeout: 5_000 });
const bytes = await page.screenshot({ fullPage: true });
await page.waitForSelector(".ready");
await page.waitForLoadState("domcontentloaded"); // or "load"
await page.waitForFunction(() => document.readyState === "complete");
const events = page.consoleEvents(); // live console capture after connect
await page.close(); // disconnect automation only; the panel remains open

// CSS locator forms
await page.locator("button.submit").click();
await page.locator('input[name="email"]').fill("user@example.com");
```

`page.screenshot()` returns `Uint8Array` and has no filesystem `path` option.
When a panel handle is available, prefer the one-call host capture and return
its exact result from eval; eval attaches it as native image content and the
operation remains read-only:

```ts
return await handle.cdp.screenshot({ format: "png" });
```

For a standalone CDP page with no panel handle, persist its byte screenshot for
visual inspection with an opaque context-local temp path, then pass the returned
file reference directly to `read`. Creating that temp file is a write, so do not
attenuate the eval cell to `authority.effects: "read-only"`:

```ts
const bytes = await page.screenshot({ fullPage: true });
const path = await fs.mktemp("panel-capture");
await fs.writeFile(path, bytes);
return { screenshot: `file:${path}`, byteLength: bytes.length };
```

`read({ target: screenshot, kind: "file" })` magic-sniffs extensionless runtime
artifacts and returns image content to the model. Do not decode PNG/JPEG bytes
as text or import a package merely to make the image visible. For durable
content-addressed storage rather than immediate visual inspection, use
`blobstore.putBytes(bytes)`. Unsupported screenshot options are rejected rather
than ignored.

Page callbacks are intentionally moved into the browser realm. Functions passed
to `page.evaluate`, `page.waitForFunction`, `locator.evaluate`, and
`locator.evaluateAll` must be self-contained apart from their explicit
argument. Exceptions preserve the
browser's actual exception description and stack; locator failures also include
the Playwright-style locator string. A generic `Uncaught` without the underlying
exception is a platform defect, not a prompt for the agent to guess.

### Not supported

The CDP client deliberately omits a few Playwright features. These
are out of scope: file uploads (`setInputFiles`), multiple pages/popups,
cross-origin frames, and full network request interception (`route`). For
protocol-level needs beyond the page surface, use raw `CdpConnection.send` (see
below).

## Protocol-level work

For raw CDP, open a connection to the panel's CDP endpoint and drive the
protocol directly:

```ts
import { CdpConnection } from "@workspace/cdp-client";

const endpoint = await handle.cdp.getCdpEndpoint(); // { wsEndpoint, token }
const c = await CdpConnection.connect(endpoint.wsEndpoint, endpoint.token);

await c.send("Page.navigate", { url: "https://example.com" });
c.on("Page.loadEventFired", () => console.log("loaded"));
```

Use `c.send(method, params)` to issue CDP commands and `c.on(event, cb)` to
subscribe to CDP events. This is the escape hatch for anything the page surface
does not cover (network interception, file inputs, multi-target work).

## Console diagnostics

Use historical console diagnostics for post-mortem panel debugging. CDP live
console events start only after a CDP client connects; they cannot recover
earlier errors. The host captures panel console messages from `webContents` as
soon as the target is registered:

```ts
const history = await handle.cdp.consoleHistory({ limit: 200, errorLimit: 100 });
console.log(history.errors);
console.log(history.dropped); // overflow is explicit
```

`history.entries` is the recent general log buffer. `history.errors` is a
separate error-only buffer so high-value errors survive noisy normal logging.
Entries include `timestamp`, `level`, `message`, `line`, `sourceId`, and `url`.
For a single panel-debugging call, use `await handle.diagnose()`. The packet
includes the canonical attempt/phase/failure, host-captured console and
lifecycle history, and a provenance-bearing document when ready.

Use the server host log stream for failures outside the renderer, such as panel
broker errors, build/reload scheduling, workerd supervision, reconnects, and
startup/shutdown. Query `services.serverLog.query(...)` from eval or open
`about/server-logs` to follow live; the full contract is in
`../server-logs/SKILL.md`.

Prefer a generation-fenced session for automation:

```ts
const session = await handle.cdp.session();
try {
  const page = session.page;
  console.log(page.url(), await page.title());
  await page.locator("button.submit").click();
  await page.locator(".status").innerText();
  await page.waitForSelector(".ready");
} finally {
  await session.close();
}
```

`page.url()` is a synchronous Playwright-style accessor. Do not `await` it or
attach `.then()` / `.catch()`; use `await page.evaluate(() => location.href)`
only when the URL must be computed inside the page after client-side routing.

`handle.reload()` is panel lifecycle reload for the named workspace panel's
renderer; it does not rebuild code and does not unload the panel's runtime
lease. Raw `page.reload()` is available only for browser panel targets.
`handle.cdp.reload()` delegates to the composed handle runtime, but prefer
`handle.reload()` for workspace panels because it waits for readiness and
returns the resulting observation. Reloading the panel currently executing
eval can cancel that eval after the command is sent; run that reload from a
stable/root context when possible.

Tree relationships do not bypass approval. To drive a parent or sibling, obtain
that target's handle and use the same `handle.cdp` namespace:

```ts
import { panelTree } from "@workspace/runtime";

const parent = panelTree.self().parent();
if (parent) await parent.cdp.page();

const sibling = panelTree.get("sibling-panel-id");
await sibling.cdp.navigate("https://example.com/status");
```

Readiness-bearing operations establish a live, booted target. For a discovered
panel, call `observe()` and require `phase === "ready"` before custom RPC, CDP,
or `_agent` inspection. If it is `pending` and the task authorizes presenting
it, call `focus()` under read-write authority. Use `diagnose()` when it is failed
or stalled.

## Methods

| Method                                             | Description                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| `handle.cdp.session()`                             | Acquire or reuse one generation-fenced CDP session for a multi-step workflow      |
| `handle.cdp.page()`                                | Connect the canonical CDP client and return the Playwright-style page             |
| `handle.cdp.getCdpEndpoint()`                      | Get `{ wsEndpoint, token }` for raw `CdpConnection.connect`                       |
| `handle.cdp.consoleHistory({ limit, errorLimit })` | Read host-captured historical console logs and the separate error buffer          |
| `handle.diagnose()`                                | Read canonical observation, bounded console/lifecycle history, and ready document |
| `handle.click(selector)`                           | Click in the target panel through CDP                                             |
| `handle.cdp.navigate(url)`                         | Low-level handle-runtime navigation alias                                         |
| `handle.cdp.goBack()` / `goForward()`              | Low-level handle-runtime history aliases                                          |
| `handle.cdp.reload()`                              | Low-level reload alias; prefer `handle.reload()` for workspace panels             |
| `handle.cdp.stop()`                                | Stop loading                                                                      |
| `handle.archive()`                                 | Archive the panel and its subtree                                                 |

Opening panels, CDP, and structural operations prompt on first use per requester
entity and target panel/root. Privileged shell/about targets use a severe
danger-tone prompt. The remembered grant does not survive requester navigation.
Panels currently held by mobile/non-CDP hosts reject CDP access instead of being
silently taken over.

Use `openExternal(url)` when the user needs their normal browser profile, password manager, passkeys, or device/browser SSO. `openExternal` is approval-gated.
