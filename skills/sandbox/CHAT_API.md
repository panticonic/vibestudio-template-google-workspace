# Chat API

The `chat` object lets panel-rendered components (inline_ui, load_action_bar
action-bar components, feedback_custom) interact with the conversation.

> Note: `chat` is **also available in agent `eval`** (bound to the agent's
> current channel). The agent `eval` tool runs server-side in your `EvalDO`,
> which injects a `chat` proxy that forwards each call to the agent DO — so it
> publishes as the agent. Everything below works from agent eval, except
> `chat.focusMessage` (panel-only; resolves `false` server-side), and
> `chat.participantByHandle` is `await`ed (the roster is fetched over RPC). CLI
> or panel eval (no channel) gets no `chat` — use the injected `rpc`/`services`
> instead. See [EVAL.md](EVAL.md#chat-agent-eval).

## Access

- **Inline UI / action-bar components**: received as `{ props, chat }` prop
- **Feedback components**: received as `{ onSubmit, onCancel, onError, chat }` prop

## Interface

```typescript
interface ChatSandboxValue {
  /** Publish an event to the channel */
  publish(
    eventType: string,
    payload: unknown,
    options?: { idempotencyKey?: string }
  ): Promise<unknown>;

  /** Send a visible user-authored message to the channel */
  send(content: string, options?: { idempotencyKey?: string }): Promise<unknown>;

  /**
   * Scroll the chat to a message and briefly highlight it. Resolves false
   * when the message is not in the rendered transcript (paged-out history,
   * headless sessions). Use after creating a card so the user lands on it -
   * e.g. a digest row's "Reply" focusing the compose card it produced.
   */
  focusMessage(messageId: string): Promise<boolean>;

  /** Publish a custom-message instance for a registered message type */
  publishCustomMessage(
    input: { typeId: string; initialState?: unknown; displayMode?: "inline" | "row" },
    options?: { idempotencyKey?: string }
  ): Promise<{ messageId: string; pubsubId: number | undefined }>;

  /** Publish a custom-message update */
  updateCustomMessage(
    messageId: string,
    update: unknown,
    options?: { idempotencyKey?: string }
  ): Promise<number | undefined>;

  /** Look up one durable channel envelope by its stable id; null when absent. */
  replayEnvelope(envelopeId: string): Promise<unknown | null>;

  /** List participants in the current conversation channel. */
  getParticipants(): Promise<
    Array<{
      id: string;
      ref: unknown;
      type: "user" | "panel" | "headless" | "agent";
      name: string;
      isPerson: boolean;
      isAgent: boolean;
      handle?: string;
      methods?: Array<unknown>;
    }>
  >;

  /** Call a method on a channel participant */
  callMethod(
    participantId: string,
    method: string,
    args: unknown,
    options?: { timeoutMs?: number }
  ): Promise<unknown>;

  /** Call a method and return the full transport result envelope */
  callMethodResult(
    participantId: string,
    method: string,
    args: unknown,
    options?: { timeoutMs?: number }
  ): Promise<{
    content: unknown;
    attachments?: unknown[];
    contentType?: string;
  }>;

  /** Resolve a participant by handle, accepting "gmail" or "@gmail" (async:
   *  the same surface works server-side, where the roster is fetched over RPC) */
  participantByHandle(
    handle: string
  ): Promise<{ id: string; metadata: Record<string, unknown> } | null>;

  /** Call by participant handle and return the provider payload */
  callMethodByHandle(
    handle: string,
    method: string,
    args: unknown,
    options?: { timeoutMs?: number }
  ): Promise<unknown>;

  /** Call by participant handle and return the full invocation envelope */
  callMethodResultByHandle(
    handle: string,
    method: string,
    args: unknown,
    options?: { timeoutMs?: number }
  ): Promise<{
    content: unknown;
    attachments?: unknown[];
    contentType?: string;
  }>;

  /** Current context ID */
  contextId: string;

  /** Current channel ID */
  channelId: string | null;

  /** RPC bridge — call any server/main service */
  rpc: { call: (target: string, method: string, args: unknown[]) => Promise<unknown> };
}
```

## chat.getParticipants

Read the current conversation's live participant roster:

```typescript
const participants = await chat.getParticipants();
return participants.map(({ id, ref, type, name, isPerson, isAgent, handle }) => ({
  id,
  ref,
  type,
  name,
  isPerson,
  isAgent,
  handle,
}));
```

This is channel scope and can include people, agents, and headless participants.
Identity and classification fields are top-level. `type: "user"` is a person
and `type: "agent"` is an agent; `panel` and `headless` are client transports,
not agents. Use `isPerson`/`isAgent` directly rather than inferring a role from
the participant id or reference.
It is not workspace-wide human presence. For that, use
`services.workspacePresence.list()`; for durable membership and roles, use
`services.account.listWorkspaceMembers()`. When diagnosing durable channel
history, `services.gad.inspectChannelRoster(...)` may provide the corresponding
channel evidence.

## chat.send

Send a user-authored prompt back to the conversation.

```typescript
await chat.send("Hello from sandbox!");
```

`chat.send(content, options?)` wraps the text in a canonical `message.completed`
agentic event and publishes it. (The low-level `chat.publish(eventType, payload)`
is for typed event kinds — a raw `"message"` record is NOT reduced into the
transcript.) The message appears in the conversation, is treated as panel/user
intent, and can start a normal agent turn. IDs are generated by the channel
client. Interactive components should use this path when a UI action represents
a user choice or follow-up instruction that should be fed back to the agent,
such as "refresh", "deploy", or "continue".

Do not use `chat.send` for agent-authored acknowledgements or ordinary eval
status. Those should come from the agent's normal response path, or from an
appropriate typed non-message event/UI surface when the result is not a user
prompt.

## chat.publish

Send typed non-message events to the PubSub channel. All transcript-visible
messages are written through the typed agentic event log and rendered from the
durable PubSub channel history. GAD may back that channel history, but the
sandbox contract is still PubSub: producers send channel events, the UI reduces
channel events, and GAD records provenance joins for audit/query workflows.

Do not publish transcript UI by hand as raw `"message"` records. Use the
`inline_ui`, `load_action_bar`, `feedback_form`, and `feedback_custom` tools;
the host records their durable UI/invocation events and preserves the expected
rendering. For custom message types — a registered React renderer that backs
many updatable instances over time — see [CUSTOM_MESSAGES.md](CUSTOM_MESSAGES.md);
those events are also published through `chat.publish` but use the
`agentic.trajectory.v1/event` payload kind.

For provenance queries, use `gad.getTrajectoryForEnvelope()` or
`gad.listPublishedEnvelopesForTrajectory()` rather than reading private
trajectory state as if it were the chat transcript.

`await chat.replayEnvelope(envelopeId)` performs a lineage-aware lookup of one
durable envelope on the current channel and returns `null` when the id belongs
to another log (for example, a VCS commit event). The same method is available
in panel components and agent-owned server eval.

## chat.callMethod

Call a registered method on a specific channel participant. Blocks until the method returns.
This resolves to the provider's actual return value.

```typescript
// Call a method on an agent
const result = await chat.callMethod("agent-participant-id", "someMethod", { arg1: "value" });
```

For diagnostics against a participant that may itself be stalled, pass a
bounded timeout so the diagnostic turn can report a non-responsive target
instead of becoming stalled too:

```typescript
const result = await chat.callMethod(
  agentParticipantId,
  "inspectMethodSuspensions",
  {},
  { timeoutMs: 15_000 }
);
```

This is useful for inline UI components that need to trigger agent-side behavior directly.
It is channel-scoped: the target must be a participant in the current
`chat.channelId`. For another panel's chat, inspect that panel's state args to
find its channel id, then use GAD inspectors or the channel DO's read-only
`inspectAgent` method against that channel.

## chat.callMethodByHandle

Resolve a channel participant by its advertised handle and call a method. Pass
either `"gmail"` or `"@gmail"`; both forms work.

```typescript
const result = await chat.callMethodByHandle("gmail", "checkNow", {});
```

`chat.callMethodByHandle()` resolves to the provider payload. Use
`chat.callMethodResultByHandle()` only when you need the full invocation result
envelope.

## chat.callMethodResult

Call a registered method and receive the full invocation result envelope.
Use this only when you need result metadata such as `attachments` or `contentType`.
For normal method calls, prefer `chat.callMethod()`.

```typescript
const result = await chat.callMethodResult("agent-participant-id", "someMethod", {});
console.log(result.content, result.contentType, result.attachments);
```

## chat.publishCustomMessage / chat.updateCustomMessage

Publish or update an instance of a previously registered custom message type.
These helpers create the correct `custom.started` / `custom.updated` events and
return the generated `messageId` for later updates.

```typescript
const { messageId } = await chat.publishCustomMessage({
  typeId: "gmail.compose",
  initialState: { to: "a@example.com", subject: "Hello" },
  displayMode: "row",
});

await chat.updateCustomMessage(messageId, { status: "sent" });
```

## chat.rpc

Full RPC bridge to all server and main-process services. Same as `rpc` from `@workspace/runtime`, but available in components that don't import the runtime.

```typescript
// Filesystem
const content = await chat.rpc.call("main", "fs.readFile", ["src/index.ts", "utf-8"]);

// DO-backed app database
// Resolve a manifest-declared Durable Object service, then call its narrow methods.
const store = await chat.rpc.call("main", "workers.resolveService", [
  "example.todos.v1",
  "project-123",
]);
if (store.kind !== "durable-object") throw new Error("Expected DO service");
const rows = await chat.rpc.call(store.targetId, "listTodos", []);

// Build
const build = await chat.rpc.call("main", "build.getBuild", ["panels/my-app"]);

// Browser data (panel/component runtime; resolves the manifest-declared broker)
import { browserData } from "@workspace/runtime";
const importHosts = await browserData.listImportHosts();

// Workers (running worker instances)
const instances = await chat.rpc.call("main", "runtime.listEntities", [{ kind: "worker" }]);
```

## chat.contextId / chat.channelId

Read-only identifiers for the current panel context and PubSub channel.

```typescript
console.log("Context:", chat.contextId); // e.g., "ctx-tree-new-abc123"
console.log("Channel:", chat.channelId); // e.g., "chat-504fef6a"
```

## Sender Identity

Messages sent with `chat.send(...)` appear as coming from the **panel** (the
user side), not the agent. This is because the panel's PubSub client is the
sender. Use this path when an inline UI, action bar, or other user-triggered
control needs to send a visible follow-up prompt on behalf of the user:

```typescript
await chat.send("Deployment started");
```

Do **not** use `chat.publish("message", { content })` for transcript-visible
messages. That creates a legacy raw PubSub row (`type: "message"`) which is
persisted in the channel log but is not reduced by the current `agentic-chat`
transcript UI. Low-level `chat.publish(...)` is for canonical typed events such
as `agentic.trajectory.v1/event` or custom message/update events, not ordinary
chat text.
