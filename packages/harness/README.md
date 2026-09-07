# @workspace/harness

In-process Pi runtime for the Vibestudio agent worker DO.

This package wraps the vendored `@earendil-works/pi-agent-core` subset through
`@workspace/pi-core` and consumes `pi-ai` through the workspace-owned
`@workspace/pi-ai` integration boundary. It provides:

- **`PiRunner`** — Worker DO companion class that owns one Pi `Agent`
  per channel. Constructs tools via the workerd-compatible RuntimeFs bridge,
  loads system prompt and skills via workspace.\* RPC, registers the
  three Vibestudio extension factories, bridges API keys via
  `setRuntimeApiKey`, and exposes `runTurn` / `steer` / `interrupt` / `fork`
  / `getStateSnapshot`.
- **Vibestudio extension factories** (`extensions/{approval-gate,channel-tools,ask-user}.ts`)
  — Pi extensions supplied inline via `extensionFactories`. Closure-bound to
  the worker, NOT Pi-package-portable.
- **`VibestudioExtensionUIContext`** — Implements Pi's `ExtensionUIContext`
  interface, routing UI primitives (`select`, `confirm`, `notify`, `setStatus`,
  …) through worker callbacks that send channel feedback_form / ephemeral
  events.
- **Channel boundary types** (`types.ts`) — `ChannelEvent`, `Attachment`,
  `SendMessageOptions`, `TurnInput`, `ParticipantDescriptor`, `TurnUsage`.

## Architecture

Before this package's rewrite, Vibestudio used a 4-layer pipeline with a Node.js
child process running the Anthropic SDK. That layer is gone. Pi runs
in-process inside the worker DO, the agent worker imports `PiRunner`
directly, and `PiRunner` emits canonical `agentic.trajectory.v1` events that
are persisted in GAD and published to the channel log for transcript consumers.

See `docs/pi-architecture.md` for the deep dive.

## Public exports

```typescript
import {
  PiRunner,
  type PiRunnerOptions,
  type PiStateSnapshot,
  type ThinkingLevel,

  // Extension factories
  createApprovalGateExtension,
  DEFAULT_SAFE_TOOL_NAMES,
  type ApprovalLevel,
  type ApprovalGateDeps,
  createChannelToolsExtension,
  type ChannelToolMethod,
  type ChannelToolsDeps,
  createAskUserExtension,
  type AskUserParams,
  type AskUserQuestion,
  type AskUserDeps,

  // UI bridge
  VibestudioExtensionUIContext,
  type VibestudioUIBridgeCallbacks,

  // Channel boundary types
  type Attachment,
  type ChannelEvent,
  type SendMessageOptions,
  type TurnInput,
  type TurnUsage,
  type ParticipantDescriptor,
  type UnsubscribeResult,
} from "@workspace/harness";
```

## Adding a new extension

1. Create `src/extensions/<name>.ts` exporting a factory function:
   ```typescript
   export function createMyExtension(deps: MyDeps): ExtensionFactory {
     return (pi) => {
       pi.on("tool_call", async (event) => {
         /* ... */
       });
     };
   }
   ```
2. Add it to `PiRunner.init()`'s `extensionFactories` list with the
   appropriate worker callbacks.
3. Add unit tests with a mock `ExtensionAPI` (see `extensions/approval-gate.test.ts`).

## Hook listener cancellation

Hook listeners registered through `PiRunner.hooks` must honor the
`AbortSignal` passed in the listener context:

```typescript
runner.hooks.on("transform_context", async (messages, context) => {
  if (context?.signal?.aborted) return messages;
  const result = await doWork({ signal: context?.signal });
  return applyResult(messages, result);
});
```

This applies to all new `event`, `transform_context`, and
`before_provider_request` listeners. Thread `context.signal` into any RPC,
fetch, file walk, or other cancellable async operation, and check it before
starting non-idempotent work. Vibestudio may stop awaiting a listener after
abort, but it cannot cancel side effects inside listener code that ignores the
signal.

## Tests

```bash
pnpm vitest run workspace/packages/harness/
```

Covers all three extension factories and the UI context bridge.
