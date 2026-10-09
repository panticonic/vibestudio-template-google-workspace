---
name: gmail
description: Gmail-aware channel agent setup, model-driven inbox triage, search, compose flows, and Gmail custom message renderers.
onboarding:
  capabilities:
    - id: contextual.gmail-agent
      title: Gmail agent
      summary: Configure channel-specific email attention and automation after Google is ready.
      category: personalization
      role: contextual-setup
      scope: channel
      tier: direct
      visibility: contextual
---

# Gmail Skill

Use this skill after Google Workspace OAuth is configured. Gmail reuses the
`google-workspace` credential audience and requires Gmail API access.

## Agent Behavior

The Gmail agent runs when triggered by action-bar controls, custom message
pills, explicit `@gmail` mentions, a user reply directly after one of its own
messages, or a triage wake digest. It does not start a trajectory for every
message in a 1:1 channel; the worker uses
`respondPolicy = "mentioned-or-followup"`.

Incoming mail is screened in two stages:

1. **Deterministic prefilter (free).** Only unread inbox mail is considered.
   Mail from senders the user has replied to before wakes the agent directly
   (the "known-sender shortcut", on by default).
2. **Batched LLM triage.** Everything else is queued as metadata (from,
   subject, snippet, labels), and a cheap model pass decides wake, surface, or
   ignore based on the user's attention preferences, written in natural
   language. Runs are batched (at most 25 candidates per call) and rate-limited
   (at most 12 per hour). Nothing is spent before onboarding completes. If the
   model call fails, the message is surfaced (visible, no wake), never silently
   dropped.

Preferences are plain text in the user's own words, saved by the agent with the
`gmail_set_attention` tool. There is no rule engine and no rule editor UI.

## Runtime Helpers

```typescript
import {
  callGmailAgent,
  getGmailAgentSetupStatus,
  resolveGmailAgentWorker,
  setupGmailAgent,
} from "@workspace/gmail/agent";
```

Recommended flow:

1. Run `getGmailAgentSetupStatus()`.
2. If Google Workspace is not verified, follow
   [Google Workspace onboarding](../../skills/google-workspace/ONBOARDING.md).
3. Once Google Workspace is verified, run
   `setupGmailAgent({ channelId: chat.channelId })` from the target chat
   context. Do not start another OAuth flow after verification.

The Gmail worker installs its own in-channel UI. When it subscribes to a
channel, it registers the Gmail custom message renderers, publishes the Gmail
action bar, and starts first-run attention setup if the channel is not yet
configured.

## Model Tool Surface

These tools are generated from the worker's operation table and can be combined
freely:

- `gmail_search`: thread-level search (`threads.list`) with full query syntax,
  `limit ≤ 50`, and `pageToken` pagination. Publishes an ephemeral
  `gmail.search` card unless `mirrorToCard: false`.
- `gmail_read`: thread or message contents. `format: "metadata"` returns
  headers only; `"full"` returns sanitized bodies. Can list attachments.
- `gmail_modify`: apply Gmail labels by name (created if missing), `markRead`,
  `archive`, and an optional local-only `localCategory`. Accepts many thread or
  message IDs; message IDs are batched through `messages.batchModify`.
- `gmail_draft`: write a draft onto a compose card (`review` when complete,
  `drafting` when partial). `mode: "reply"` takes the recipient and subject
  from the thread. The default send-as signature is appended visibly when the
  draft is written. `from` is checked against send-as aliases. `saveToGmail`
  saves the draft to Gmail; saving again updates it instead of duplicating it.
- `gmail_send`: send a compose the agent owns (`messageId` from
  `gmail_draft`), ONLY when the user explicitly asks. Otherwise, the user's
  Send click on the compose card is the authorization. `from?` must be a
  configured send-as alias.
- `gmail_contacts`: name → address candidates with interaction evidence
  (history first, then Google contacts). `mode: "suggest"` gives offline
  typeahead.
- `gmail_set_attention`: save attention preferences (`mode: "replace"` or
  `"append"`, `knownSenderShortcut`, `markConfigured`). Each call includes a
  scoped dry run that re-evaluates recently surfaced or woken mail under the
  new text.
- `gmail_snooze`: archive now and wake with a reminder later (`remindAt` as
  ISO or `inMs`; default 24h). `gmail_list_reminders` lists reminders.
- `gmail_get_attachment`: save an attachment as a workspace file (sanitized
  name, 10MB cap, binary-safe) for use with normal file tools.
- `gmail_publish_digest`: publish a compact `gmail.digest` card (at most 5 rows
  plus `moreCount`).

## Push Notifications

Push needs a generic `webhookIngress` Cloud Pub/Sub subscription that targets
`workers/gmail-agent:GmailAgentWorker:gmail-push-router`, plus
`googlePubSubTopicName` in the Gmail agent config (see
[Google Workspace setup](../../skills/google-workspace/SETUP.md)). With both in
place, the worker starts a `users.watch` when it subscribes and renews it daily
from its alarm. The server only verifies and decodes the generic webhook
delivery; the Gmail worker fans it out to the mailbox. Pushes sync within
seconds, and polling drops to a 30-minute safety net. Without the topic, the
worker syncs only by polling the history API (every 5 minutes by default).

## Attention Preference API

Preferences are stored as plain text on the Gmail Durable Object:

| Method                                                                                 | Purpose                                                   |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `getAttentionPrefs(channelId)`                                                         | `{ preferencesText, knownSenderShortcut, updatedAt }`     |
| `setAttentionPrefs(channelId, { preferences, knownSenderShortcut?, markConfigured? })` | Save preferences (user-facing callers only; DOs can read) |

```typescript
import { callGmailAgent } from "@workspace/gmail/agent";

await callGmailAgent(chat.channelId, "setAttentionPrefs", {
  preferences: "Wake me for invoices and anything from acme.example.",
});
```

## Channel Method Surface

Call these on the Gmail participant with
`chat.callMethodByHandle("gmail", method, args)`; cards and the action bar use
them too:

| Method                              | Args                                  | Purpose                                                                                                        |
| ----------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `checkNow`                          | `{}`                                  | Sync now                                                                                                       |
| `markConfigured`                    | `{ summary? }`                        | Finish first-run setup                                                                                         |
| `reconnect`                         | `{}`                                  | Re-verify the Google credential; returns `{ ok, auth }`                                                        |
| `gmail_search`                      | `{ q, limit?, pageToken? }`           | Search; publishes a `gmail.search` card                                                                        |
| `gmail_read`                        | `{ threadId, format, ... }`           | Sanitized thread/message contents (transient)                                                                  |
| `openThread`                        | `{ threadId }`                        | Publish/focus a standalone `gmail.thread` card                                                                 |
| `compose`                           | `{ to?, subject?, body?, threadId? }` | New compose card (`drafting`)                                                                                  |
| `draftReply`                        | `{ threadId }`                        | One-shot AI-drafted reply card in `review` state (no-model-turn button path)                                   |
| `gmail_send`                        | compose payload + `messageId`         | Send; user Send click or explicit user request only                                                            |
| `gmail_snooze`                      | `{ threadId, remindAt? }`             | Archive and schedule a reminder                                                                                |
| `gmail_get_attachment`              | attachment metadata                   | Save an attachment into the workspace                                                                          |
| `saveDraft` / `discardCompose`      | compose payload / `{ messageId }`     | Save to Gmail drafts (re-save updates via `draftId`) / discard. Recipient-less drafts park in `drafting` state |
| `resolveContact` / `contactSuggest` | `{ name }` / `{ prefix }`             | Contact resolution / offline typeahead                                                                         |
| `archiveThread` / `markRead`        | `{ threadId }`                        | Thread-card triage buttons                                                                                     |
| `listActionableThreads`             | `{ limit? }`                          | Current actionable threads                                                                                     |
| `setPollInterval`                   | `{ pollIntervalMs }`                  | Configure polling                                                                                              |
| `getAttentionPrefs`                 | `{}`                                  | Read the attention preference text                                                                             |

## Multi-Agent Participant API

Other agents in the channel get a mostly read-only set of methods, called the
same way:

| Method                 | Args                                   | Purpose                                        |
| ---------------------- | -------------------------------------- | ---------------------------------------------- |
| `gmail_query`          | `{ q, maxResults? }`                   | Cache-first thread search with API fallback    |
| `gmail_getThread`      | `{ threadId }`                         | Sanitized thread messages                      |
| `gmail_getOverview`    | `{}`                                   | Snapshot: counts, auth status, actionable list |
| `gmail_requestDraft`   | `{ threadId?, to?, subject?, intent }` | Compose card in `review` state                 |
| `gmail_resolveContact` | `{ name, limit? }`                     | Read-only contact resolution                   |

Agents can prepare mail but never send it. Only the user's Send click on the
compose card, or an explicit user instruction to the Gmail agent, sends mail.
Only user-facing callers can write attention preferences; anyone can read them.

## Wake Batching

Wake hits (known senders plus triage `wake` verdicts) are queued and debounced
(about 90s) into one digest turn covering all queued hits, with at most 4 wake
turns per hour per channel. The digest turn writes ONE short chat message and
publishes ONE `gmail.digest` card via `gmail_publish_digest`.

## Custom Message Types

The helper package ships five renderer modules, designed mobile-first: 44px
touch targets, a single column, at most 2 visible actions, and whole-row taps.

| Type            | Renderer                                               | Display | Notes                                                                 |
| --------------- | ------------------------------------------------------ | ------- | --------------------------------------------------------------------- |
| `gmail.setup`   | `../../packages/gmail/src/renderers/gmail-setup.tsx`   | inline  | Connection status, preference text, Edit hands off to chat            |
| `gmail.digest`  | `../../packages/gmail/src/renderers/gmail-digest.tsx`  | row     | Immutable per-wake digest; scrolls away with chat                     |
| `gmail.search`  | `../../packages/gmail/src/renderers/gmail-search.tsx`  | row     | Ephemeral; `searching → done` patched in place; new search = new card |
| `gmail.thread`  | `../../packages/gmail/src/renderers/gmail-thread.tsx`  | inline  | Auto-loads on expand; AI draft + Send, rest behind "More"             |
| `gmail.compose` | `../../packages/gmail/src/renderers/gmail-compose.tsx` | row     | Review-before-send, contact autocomplete, `toCandidates` one-click    |

`gmail.digest` and `gmail.search` share
`../../packages/gmail/src/renderers/thread-row.tsx`. The old `gmail.inbox` desk
card is retired; UI install tombstones it with `messageType.cleared`.

## Action Bar

`../../packages/gmail/src/action-bar.tsx` is a single 44px row: Compose plus an
expanding search field. Everything else (check now, bulk triage, preference
edits) happens in chat.

## Files

| Document                                                                           | Content                                 |
| ---------------------------------------------------------------------------------- | --------------------------------------- |
| [docs/ONBOARDING.md](docs/ONBOARDING.md)                                           | Setup flow for agents                   |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)                                 | Common Gmail setup and sync failures    |
| [../../packages/gmail/src/action-bar.tsx](../../packages/gmail/src/action-bar.tsx) | Pinned Gmail launcher                   |
| [docs/system-prompt.md](docs/system-prompt.md)                                     | Gmail agent prompt (documentation copy) |
| [../../packages/gmail/src/agent.ts](../../packages/gmail/src/agent.ts)             | Importable onboarding helpers           |
