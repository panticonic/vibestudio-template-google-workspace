# Gmail Troubleshooting

## Gmail API Calls Fail

Verify the Google Workspace setup first. The Gmail agent uses the same
credential audience as the Google Workspace skill.

## Agent Does Not Respond

The Gmail worker responds to explicit `@gmail` mentions, action bar/custom
message controls, the next user message after one of its own messages, and
triage wake digests. If it has not spoken recently, mention `@gmail` or use a
Gmail control.

Incoming email wakes the agent in two ways: deterministically for senders the
user has replied to before (the known-sender shortcut), and via the batched
LLM triage pass for everything else — but the triage pass only runs after
first-run setup completes (preferences saved or default kept). Check the
`gmail.setup` card's "Watching for" text; ask the agent in chat to change it.

## Attention Preference RPC Fails

Preference reads/writes use the concrete Gmail Durable Object, not a manifest
service. The object key must be `gmail-${channelId}` and the worker must
already be subscribed to that channel. Resolve it from eval with:

```typescript
const target = await workers.resolveDurableObject(
  "workers/gmail-agent",
  "GmailAgentWorker",
  `gmail-${channelId}`,
);
```

Then call `getAttentionPrefs` first to verify the target before writing with
`setAttentionPrefs`. Writes are accepted only from user-facing callers
(panel/shell/server/harness); DO callers can read but not write.

## Triage Never Wakes the Agent

- Confirm setup completed (`setup_status = configured` or saved preferences).
- Wake digests are debounced ~90s and capped at 4/hour; triage LLM runs are
  capped at 12/hour. Surfaced-but-not-woken threads still appear as attention
  hits and in `listActionableThreads`.
- If the triage model call fails twice, candidates fall back to *surface*
  (visible, no wake) — check the channel's model credential.

## Pills Do Not Render

Renderer sources under `packages/gmail/src/renderers/` must be committed and
available to the channel build loader. Custom message type paths are
workspace-root-relative and should not include a `workspace/` prefix. The Gmail
worker registers these renderers when it subscribes to the channel; resubscribe
or restart the Gmail worker if the channel has stale renderer metadata. The
retired `gmail.inbox` desk card is tombstoned via `messageType.cleared` on UI
install — stale desk cards collapse instead of erroring.

## Unread Counts Look Stale

Ask the agent to check mail (or call the `checkNow` method). The sync path
must process `messageAdded`, `messageDeleted`, `labelAdded`, and
`labelRemoved` history types. Thread refreshes go through the Gmail batch
endpoint; a whole-batch 429 backs off polling until the rate limit clears.
