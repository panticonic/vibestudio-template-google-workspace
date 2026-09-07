# @workspace/cdp-client

A **workerd-native** Chrome DevTools Protocol client with a
**Playwright-style `Page`/`Locator` API**, implemented entirely over raw CDP
(`Runtime`/`DOM`/`Input`/`Page` domains) and a single `WebSocket`. No Node
dependencies and no vendored browser bundle, so it runs in panels, workers, and
Durable Objects / server-side `eval` alike.

This is the **single browser-automation surface** in the workspace. There is no
"full Playwright" package — do not install any `playwright*` dependency.

The page API also provides bounded, agent-readable performance profiling. Wrap
one exact interaction or reload with `page.profile(action, options)` to collect
Chromium runtime, page, network, and optional precise JavaScript-coverage
evidence without exporting an unbounded trace. Await the workflow's actual
completion condition inside `action`; coverage and cold-cache modes are opt-in.

## Getting a session

From any panel handle (panels, workers, server-side eval — anywhere you hold a
handle):

```ts
const session = await handle.cdp.session();
try {
  await session.page.getByRole("button", { name: "Sign in" }).click();
} finally {
  await session.close();
}
```

The handle owns the panel target; the session owns one generation-fenced
automation connection to a runtime incarnation. Prefer one session for a related
operation sequence and close it in `finally`. The one-off `handle.cdp.page()` is
available, but its caller owns the returned connection and must call
`page.close()`. Neither close operation archives the panel; `handle.archive()`
archives an owned panel subtree.

Raw `page.goto()`, `page.reload()`, `page.goBack()`, and `page.goForward()` are
browser-panel operations. Workspace pages reject them so navigation cannot
bypass panel readiness and generation tracking. Use `handle.navigate()`,
`handle.reload()`, or `handle.rebuild()`, then call `session.refresh()` (or close
the old session and acquire a new one).

A deferred panel observation has phase `pending` and no CDP generation. Run
`await handle.focus()` to materialize it before acquiring a session. In
server-side eval, that lifecycle call requires `authority.effects:
"read-write"`; it is intentionally rejected in read-only mode.

## Playwright compatibility notes

The page and locator surface intentionally follows Playwright where possible.
That includes synchronous accessors:

```ts
const url = page.url(); // string, not Promise<string>
const events = page.consoleEvents(); // CdpConsoleEvent[], not a Promise
page.clearConsoleEvents(); // void
```

Do not `await page.url()` or attach `.then()` / `.catch()` to it. Use
`await page.evaluate(() => location.href)` only when you need the page itself to
compute the current URL after client-side routing.

For protocol-level work (any CDP domain, raw commands + events):

```ts
import { CdpConnection } from "@workspace/cdp-client";

const { wsEndpoint, token } = await handle.cdp.getCdpEndpoint();
const cdp = await CdpConnection.connect(wsEndpoint, token);
await cdp.send("Network.enable");
const off = cdp.on("Network.responseReceived", (p) => console.log(p));
// ... later: off(); cdp.close();
```

## Locators

Resilient, Playwright-style locators (resolved fresh on every use):

```ts
page.getByRole("button", { name: "Save", exact: true });
page.getByRole("button", { name: /delete .* item/i });
page.getByText("Welcome");
page.getByLabel("Email");
page.getByPlaceholder("Search…");
page.getByTestId("submit");
page.getByAltText("Logo");
page.getByTitle("Close");
page.locator("css .selector"); // CSS escape hatch
```

Chain and narrow:

```ts
page
  .getByRole("listitem")
  .filter({ hasText: /active/i })
  .first();
page.locator("table").getByRole("row").nth(2).getByRole("cell").last();
const rows = await page.getByRole("row").all(); // Locator[]
```

## Actions (auto-waiting)

Every action **auto-waits** for the element to be present, visible, stable, and
enabled before acting — no manual `waitForSelector` before a click:

```ts
await loc.click(); // also: dblclick, hover
await loc.fill("text"); // also: type, clear, press("Enter")
await loc.check(); // also: uncheck, setChecked(true)
await loc.selectOption("value");
await loc.selectOption({ label: "Visible label" });
await loc.selectOption({ index: 1 });
await loc.focus(); // also: blur, scrollIntoViewIfNeeded

await page.keyboard.press("Control+A"); // Ctrl/Cmd aliases are accepted
await page.keyboard.type("replacement");
await page.keyboard.insertText("pasted as one input operation");
await page.setViewportSize({ width: 390, height: 844 });
page.viewportSize(); // synchronous current CSS viewport
```

Text matchers accept strings or `RegExp`. Strings use normalized,
case-insensitive substring matching by default; `{ exact: true }` selects a
case-sensitive whole-string match. Matcher source/flags are serialized explicitly
instead of degrading to `{}` at the CDP boundary. Form actions use native DOM
property setters plus input/change events, including for controlled React inputs.

## Reads & state

```ts
await loc.textContent(); // innerText, inputValue, getAttribute("href")
await loc.count(); // allTextContents, allInnerTexts
await loc.evaluate((element) => element.innerHTML);
await loc.evaluateAll((elements) => elements.map((element) => element.textContent));
await loc.isVisible(); // isChecked, isEnabled, isDisabled, isEditable
await loc.boundingBox();
await loc.inspect();
// { tagName, id, className, text, role, accessibleName, visible, attributes,
//   boundingBox }
```

The `isVisible`, `isChecked`, `isEnabled`, `isDisabled`, and `isEditable`
methods are immediate snapshots and return `false` when there is no current
match. Use `waitFor` when absence should be retried. Other single-element reads
and actions auto-wait.

Before acting on a newly rendered UI, inspect its live accessibility names:

```ts
const buttons = await page.getByRole("button").all();
const semantics = await Promise.all(buttons.map((button) => button.inspect()));
```

Descendant text contributes to the accessible name (`Done` plus a `3` badge is
typically `"Done 3"`). A failed named-role locator includes the available names
in its `CdpError`.

## Waiting

```ts
await loc.waitFor({ state: "visible" }); // attached | detached | visible | hidden
await page.waitForLoadState("domcontentloaded");
await page.waitForFunction(() => document.readyState === "complete");
await page.waitForSelector(".ready");
```

An exhausted locator wait is reported as `cdp_locator_state_mismatch`, with the
locator, requested state, and timeout in `errorData`. It is not collapsed into a
generic `cdp_evaluation_failed` error.

## Screenshots

```ts
const bytes = await page.screenshot({ type: "png", fullPage: true });
```

The result is `Uint8Array`; there is no filesystem `path` option in a
workerd-native client. Store bytes explicitly with `@workspace/runtime`
`blobstore.putBytes`. Unknown options are rejected with the supported option
list instead of being silently ignored.

## Timeouts

Auto-waiting defaults to **30 s**. Override globally or per call:

```ts
page.setDefaultTimeout(10_000);
await loc.click({ timeout: 2_000 });
```

## Errors

Failures throw a **`CdpError`** whose message names the target locator
(Playwright-style) and the reason, with `.locator` and `.cause` for handling:

```ts
import { CdpError } from "@workspace/cdp-client";

try {
  await page.getByTestId("missing").click();
} catch (e) {
  if (e instanceof CdpError) {
    e.message; // 'not actionable (not found) after 30000ms: getByTestId("missing")'
    e.locator; // 'getByTestId("missing")'
  }
}
```

`locator.toString()` returns the same description, handy for logging.

Exceptions from `page.evaluate`, locator callbacks, and in-page operations
preserve the browser exception description and stack. The message begins with
`Browser evaluation failed:` and includes the actual error name/message instead
of collapsing every exception to CDP's generic `Uncaught` label. Locator
operations wrap that detail in `CdpError` without discarding it.

Use locator actions for interaction. Calling `element.click()`, `form.submit()`,
or `form.requestSubmit()` through `evaluate()` bypasses locator actionability,
real CDP input dispatch, and semantic postcondition reporting. A failed
`click({ expect })` includes the dispatched locator, expected locator/state, and
timeout in `errorData`, so the caller can distinguish delivery from an
unobserved application outcome.

Functions passed to `page.evaluate`, `waitForFunction`, `locator.evaluate`, or
`locator.evaluateAll` are serialized into the page realm. They must be
self-contained apart from the explicit argument. Eval's cooperative deadline
instrumentation remains realm-safe when such a callback is serialized.

## Console capture

```ts
page.consoleEvents(); // [{ type, text, args }] captured since connect
page.clearConsoleEvents();
```

## Not supported (use raw `CdpConnection`)

These have no CDP-only path in a connectionless isolate and are intentionally
out of scope:

- **File uploads** (`setInputFiles`)
- **Multiple pages / popups** (single-target by design)
- **Cross-origin frames** (operations target the main frame)
- **Full network request interception** (`route`) — observation via
  `CdpConnection.on("Network.*", …)` works

For anything beyond the `Page`/`Locator` surface, `CdpConnection.send(method,
params)` / `.on(event, cb)` give you the entire CDP protocol.

## Build conditions

`package.json` exports resolve per target — all to the same implementation:

| condition          | entry            |
| ------------------ | ---------------- |
| `worker`/`workerd` | `src/worker.ts`  |
| `vibestudio-panel` | `src/browser.ts` |
| `default`          | `src/index.ts`   |

Types are published from `index.d.ts` (kept in sync with `src/worker.ts`).
