# Custom Message Types

Register a custom React renderer with a channel, then publish typed message
instances against it. The channel persists registry and instances as typed
agentic events, so replay, fork, and pagination preserve the same view.

Use this when a built-in message shape doesn't fit — a weather card, a build
status badge, a sensor readout, a domain-specific decision tile. Use
[`inline_ui`](INLINE_UI.md) when you just need a one-shot React component in
the transcript; use a custom message type when many instances of the same
shape will be published and updated over time.

## Concepts

A custom message type has two halves:

1. A **registration** scoped to the channel — a `typeId`, a display mode, and a
   sandbox source (file path or inline code) that compiles to a renderer module.
2. **Instances** — `custom.started` (with an optional initial state) plus zero
   or more `custom.updated` events that fold into the rendered state.

The reducer in the renderer module decides how updates merge. If absent, the
last update wins.

### Module shape

The compiled module may export:

| Export    | Purpose                                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `default` | Required. React component receiving `{ messageId, typeId, state, expanded, displayMode, chat }`. Render compact inline content when `expanded` is false and the full view when `expanded` is true. |
| `Pill`    | Optional. A dedicated component for the collapsed inline view (`expanded === false`). When present it renders the bead and `default` only renders the expanded card. Same props as `default`.          |
| `reduce`  | Optional. `(state, update) => nextState`. Folds `custom.updated` payloads. Default: last update replaces state. A throwing reducer is caught — the prior state is kept and folding continues.          |
### Schema validation

Schemas are **data, not code**: the registration carries `stateSchema` (and
`updateSchema` for types that export `reduce`, since their updates are patches)
as plain JSON Schema documents. The same document is enforced in two places:

- **At emission time** — an agent publishing through its `cards` handle
  (`CardManager` in `@workspace/agentic-do`) gets a typed `CardValidationError`
  for state that fails the schema, which surfaces as a tool error the model can
  react to immediately.
- **At the render boundary** — the panel validates folded state before handing
  it to the component. On failure the card shows a compact validation callout
  instead of crashing the transcript, and publishes a `ui.feedback` event
  targeted at the card owner so the agent hears about the divergence.

Validation never runs in the channel reducer, so it stays out of replay/fold
determinism.

### Display modes

| Mode       | Rendering                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| `"inline"` | Bead inside the sender's message group with `expanded: false`. Click to expand the full card with `expanded: true`. |
| `"row"`    | Full chat row, like a normal message. Card renders the component with `expanded: true`.                             |

`displayMode` on the registration is the default. Each instance can override
via `displayMode` on `publishCustomMessage` / `custom.started`.

## From panel or worker code (PubSubClient)

Code holding a `PubSubClient` (panels, workers, headless sessions via
`manager.client`) uses the typed helpers:

```typescript
import type { PubSubClient } from "@workspace/pubsub";

await client.registerMessageType({
  typeId: "weather",
  displayMode: "inline",
  source: { type: "file", path: "skills/sandbox/references/weather-message-renderer.tsx" },
  imports: { "@radix-ui/themes": "npm:^3.2.1" },
});

const { messageId } = await client.publishCustomMessage({
  typeId: "weather",
  initialState: { city: "San Francisco", tempF: 64, condition: "Cloudy" },
});

await client.updateCustomMessage(messageId, { tempF: 66, condition: "Clearing" });

// Later, retire the type:
await client.clearMessageType("weather");
```

The `source` is either `{ type: "file", path }` or `{ type: "code", code }`
(inline TSX). `imports` accepts the same shape as `eval` / `inline_ui`
(`{ "@pkg": "npm:^1.2.3" }` or workspace refs).

File paths are **workspace-root-relative with no `workspace/` prefix** — the
panel resolves them inside its context, whose root mirrors the workspace root
(`skills/…`, `panels/…`, `packages/…`). Use `skills/my-skill/renderer.tsx`, not
`workspace/skills/my-skill/renderer.tsx` (the latter resolves to a non-existent
`<context>/workspace/…` and fails with ENOENT). This matches the action-bar file
convention. The file must exist at the panel context's projected working
head. A file added after a panel was opened appears after that context is
reprojected or the panel is recreated; do not infer source state from an
incidental disk snapshot.

Cleared types are tombstoned at a sequence — re-registering re-activates the
typeId without resurrecting previously cleared instances. Pagination and
out-of-order replay preserve latest-write-wins semantics; registry merges are
seq-aware and idempotent.

Lookup helpers:

```typescript
const all = await client.getMessageTypes();
const weather = await client.getMessageType("weather");
```

The complete renderer used above lives beside this guide at
`workspace/skills/sandbox/references/weather-message-renderer.tsx`.

## From sandbox code (eval / inline_ui / action_bar / feedback_custom)

The `chat` sandbox value exposes the same typed registry + instance helpers as a
`PubSubClient`. Register once, then publish and update instances:

```ts
const typeId = "weather";

// 1. Register the renderer (once per channel; safe to re-register — a fresh
//    registration bumps the seq and reloads the source).
await chat.registerMessageType({
  typeId,
  displayMode: "inline",
  source: { type: "file", path: "skills/sandbox/references/weather-message-renderer.tsx" },
  imports: { "@radix-ui/themes": "npm:^3.2.1" },
});

// 2. Publish and update instances.
const { messageId } = await chat.publishCustomMessage({
  typeId,
  initialState: { city: "San Francisco", tempF: 64, condition: "Cloudy" },
  displayMode: "inline",
});
await chat.updateCustomMessage(messageId, { tempF: 66, condition: "Clearing" });

// 3. Look up or retire the type.
const all = await chat.getMessageTypes();
const weather = await chat.getMessageType(typeId);
await chat.clearMessageType(typeId);
```

> Advanced: `registerMessageType` / `clearMessageType` are thin wrappers over
> typed `messageType.registered` / `messageType.cleared` agentic events. You can
> still hand-build those via `chat.publish(AGENTIC_EVENT_PAYLOAD_KIND, event)` if
> you need full control, but prefer the helpers above.

## Authoring the renderer module

The module file is loaded into the chat sandbox by the channel — same
compilation pipeline as `inline_ui`. Imports follow the
[sandbox import rules](SKILL.md#available-imports): workspace packages auto-
resolve, npm packages need `imports: { "pkg": "npm:^x.y.z" }` on the
registration, and file-loaded modules infer bare imports from the nearest
`package.json`.

Relative imports work, so you can split a renderer across sibling files:
`import { fmt } from "./helpers.js"` resolves to `helpers.ts`/`.tsx` (the
written `.js` extension maps to the TS source), and `import type { Foo } from
"./types.js"` is erased — the type-only module is never fetched into the
context, so a shared types file needs no runtime presence. Value relative
imports must exist in the panel's context like the renderer itself.

```tsx
// workspace/skills/sandbox/references/weather-message-renderer.tsx
import { Badge, Card, Flex, Text } from "@radix-ui/themes";

interface WeatherState {
  city: string;
  tempF: number;
  condition: string;
}
type WeatherUpdate = Partial<WeatherState>;

export function reduce(state: WeatherState, update: WeatherUpdate): WeatherState {
  return { ...state, ...update };
}

export default function WeatherMessage({
  state,
  expanded,
}: {
  state: WeatherState;
  expanded: boolean;
}) {
  if (!expanded) {
    return (
      <Flex align="center" gap="1">
        <Text size="1" weight="medium">
          {state.city}
        </Text>
        <Text size="1" color="gray">
          {state.tempF}F
        </Text>
      </Flex>
    );
  }

  return (
    <Card>
      <Flex direction="column" gap="2">
        <Flex align="center" justify="between" gap="3">
          <Text size="3" weight="bold">
            {state.city}
          </Text>
          <Badge color="blue" variant="soft">
            {state.condition}
          </Badge>
        </Flex>
        <Text size="6" weight="bold">
          {state.tempF}F
        </Text>
      </Flex>
    </Card>
  );
}
```

Rules:

- `export default` is required. Without it the card renders an error.
- Inline messages should render pill-sized content when `expanded` is false.
  The host owns expansion state and swaps the same message into an expanded
  card when selected.
- Collapsed inline messages are a click/keyboard-to-expand surface. Interactive
  controls inside collapsed content may bubble and expand the message; call
  `event.stopPropagation()` in those controls if they need independent behavior.
- The component must be pure with respect to `state` — updates re-render via
  the reducer fold. Don't keep authoritative state in component-local refs;
  publish a `custom.updated` event instead.
- The component's only injected handle is `chat` (`scope`/`scopes`/`help` are
  eval-only and are NOT passed to rendered components). Call `chat.publish` /
  `chat.callMethod` from event handlers when you need to send events back to the
  channel.
- The module is recompiled when `updatedAtSeq` advances (re-registration).
  Keep the module pure so identical re-registrations produce stable output.

### State, not scope

Custom-message components do **not** receive `scope`/`scopes` — that REPL scope
is server-side in the agent's `EvalDO` and is never shared into rendered
components. So:

- **Authoritative, replayable data must live in the message `state`.** Embed
  what the card needs in `initialState` / updates (bounded — the channel
  persists every byte). The same `state` renders identically on every observer
  panel and on replay.
- To persist interaction state across reloads, publish a `custom.updated` event
  (folded by `reduce`); do not keep authoritative state in component refs.

## Reducer semantics

- Updates are applied in channel sequence order. The reducer must be
  deterministic and commutative-safe across replay.
- If `reduce` is not exported, the latest `custom.updated` payload replaces
  the prior state wholesale.
- `initialState` is used as the fold seed (or as the displayed state when
  there are no updates and no reducer).

## Caveats

- Workspace source is built from the context's exact working head. If the
  module lives in a managed workspace unit, mutate it through the semantic
  adapter and follow [vibestudio-vcs](../vibestudio-vcs/SKILL.md) for commit and
  publication. The projected disk tree is not a second source of truth.
- Custom messages are panel-rendered. Headless sessions receive the events
  but won't materialize React output.
- Don't reuse a `typeId` for unrelated shapes — registry updates are
  latest-write-wins on `typeId`, and old instances will re-render through the
  new module.

## Operations & debugging

### Renderer load lifecycle

When a custom message arrives, the panel takes its type through these stages
(visible in the card's diagnostic view and as `[useMessageTypeRegistry]`
console traces):

| Stage | What is happening | Stuck here means |
| --- | --- | --- |
| `fetching-definition` | `getMessageType(typeId)` from the channel registry | registration never happened, or the channel RPC is failing |
| `loading-source` | `fs.readFile` of the registered source file | bad path, or the file is missing from this context |
| `compiling` | sandbox compile of the renderer module | an import needs the build service (see lint below), or a compile-pipeline bug |

A type that fails any stage shows an error pill/card with a **Retry** button.
A stage that exceeds ~30s publishes a `ui.feedback` event with category
`load_stalled` to the owning agent, so the agent learns its card never
rendered without the user reporting it.

### Self-containment rule (and lint)

Every **value** import in a renderer must come from the panel's host-exposed
modules (`react`, `react/jsx-runtime`, `@radix-ui/themes`,
`@radix-ui/react-icons`, …), the registration's `imports` map, or a relative
file. Anything else triggers a build-service round trip on every compile — at
best slow, at worst misresolved and permanently stuck. `import type` is always
free (erased at compile time).

Use `lintRendererSource(code, { imports })` from `@workspace/agentic-core`
(re-exported by `@workspace/agentic-do`) at registration time and refuse to
register on issues — the gmail agent's `installChannelUi` is the reference
implementation.

### Message-type doctor (test harness)

Any agent that registers renderers should run the doctor in its test suite —
it exercises the exact pipeline the panel runs (registration event → channel
reducer → projection → lint → compile with the build service forbidden) and
reports issues per stage:

```ts
// @vitest-environment jsdom
import { assertMessageTypesHealthy, installDoctorHostModules } from "@workspace/agentic-core";

installDoctorHostModules({
  react: await import("react"),
  "react/jsx-runtime": await import("react/jsx-runtime"),
  "react/jsx-dev-runtime": await import("react/jsx-dev-runtime"),
  "@radix-ui/themes": await import("@radix-ui/themes"),
  "@radix-ui/react-icons": await import("@radix-ui/react-icons"),
});
await assertMessageTypesHealthy(MY_MESSAGE_TYPES, {
  loadSourceFile: (p) => fs.readFile(path.join(REPO_ROOT, p), "utf8"),
});
```

Keep the doctor invocation in the package that owns the renderer definitions.
A type that fails it would have shipped as a stuck spinner or a build-service
stall in users' panels.

### Failure states, from the user's perspective

| State | UI | How it got there |
| --- | --- | --- |
| Owner-declared failure | red "failed" frame with the error message | the agent called `card.fail({ message })` (protocol: `custom.updated` with `status: "failed"`); a later successful `update()` clears it |
| Invalid state | amber validation callout | folded state failed the registered `stateSchema`; also publishes `ui.feedback` (`state_invalid`) to the owner |
| Render crash | red error callout with report status | the component threw; publishes `ui.feedback` (`render_failed`) and shows whether the report reached the agent |
| Load stuck/failed | diagnostic card with stage, elapsed, metadata, Retry | see lifecycle table above |

### Inspecting a card

- **User**: every expanded card has **Copy details** (full JSON: payload,
  registry status, definition metadata) and an **Inspect** toggle showing
  metadata plus the per-update fold history (each `custom.updated` payload and
  the state it produced — a reducer bug reads as "state went wrong at seq N").
  Loading/error pills are clickable and expand into the same diagnostic view.
- **Agent**: call the chat panel's `inspect_card` method with
  `{ messageId }` — it returns exactly what Copy details shows, plus a list of
  known cards when the id is wrong. Reach it like any participant method
  (the panel advertises it alongside other panel-rendered UI methods).

### Emission guarantees (CardManager)

- `cards.getOrCreate(channelId, typeId, naturalKey, state)` is durable and
  idempotent: the same natural key returns the same card across agent
  restarts; idempotency keys are deterministic (`custom:{agent}:{msg}:{seq}`),
  so retried publishes dedupe instead of double-applying.
- State (and updates, for reducing types) are validated against the
  registered JSON Schemas **at emission** — failures throw
  `CardValidationError`, which surfaces as a tool error the model can react
  to. Unregistered types throw `CardTypeNotRegisteredError`.
- `ui.feedback` events targeting the agent (render failures, invalid state,
  expired method calls, load stalls) are deduplicated by `occurrenceKey` and
  prepended to the agent's next turn as a diagnostic note — they never start
  a turn by themselves.
