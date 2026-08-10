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

The Gmail agent is invoked through action-bar controls, custom message pills,
explicit `@gmail` mentions, direct user follow-ups immediately after one of
its own messages, and triage wake digests. It should not start a trajectory on
every message in a 1:1 channel; the worker uses
`respondPolicy = "mentioned-or-followup"`.

Incoming-mail attention is two-stage:

1. **Deterministic prefilter (free).** Only unread inbox mail is considered.
   Senders the user has replied to before wake the agent directly (the
   "known-sender shortcut", on by default).
2. **Batched LLM triage.** Everything else queues as metadata (from / subject /
   snippet / labels) and a cheap model pass decides wake / surface / ignore
   against the user's natural-language attention preferences. Runs are batched
   (≤25 candidates per call) and rate-capped (≤12/hour); nothing is spent
   before onboarding completes. On model failure the fallback is _surface_
   (visible, no wake) — never silent loss.

Preferences are plain text in the user's own words, saved by the agent via the
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

The Gmail worker owns its in-channel UI installation. On subscription it
registers the Gmail custom message renderers, publishes the Gmail action bar,
and starts first-run attention setup when the channel is not configured yet.

## Model Tool Surface

Composable tools (generated from the worker's single operation table):

| Tool                   | Purpose                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gmail_search`         | True thread-level search (`threads.list`) with full query syntax, `limit ≤ 50`, `pageToken` pagination; publishes an ephemeral `gmail.search` card unless `mirrorToCard: false`                                                                                                                                     |
| `gmail_read`           | Thread/message contents; `format: "metadata"` for headers-only, `"full"` for sanitized bodies; optional attachment list                                                                                                                                                                                             |
| `gmail_modify`         | Real Gmail labels by name (auto-created), `markRead`, `archive`, optional local-only `localCategory`; accepts many thread/message ids (message ids batch through `messages.batchModify`)                                                                                                                            |
| `gmail_draft`          | Agent-written drafts onto a compose card (`review` when complete, `drafting` when partial); `mode: "reply"` resolves recipient/subject from the thread; default send-as signature appended visibly at draft time; `from` validated against send-as aliases; `saveToGmail` persists (re-saves update, not duplicate) |
| `gmail_send`           | Immediate send — ONLY on explicit user request; otherwise the compose card's Send click authorizes; `from?` must be a configured send-as alias                                                                                                                                                                      |
| `gmail_contacts`       | Name → address candidates with interaction evidence (history first, Google contacts fallback); `mode: "suggest"` for offline typeahead                                                                                                                                                                              |
| `gmail_set_attention`  | Save natural-language attention preferences (`mode: "replace"` or `"append"`, `knownSenderShortcut`, `markConfigured`); tool calls include a scoped dry run re-evaluating recent surfaced/woken mail under the new text                                                                                             |
| `gmail_snooze`         | Archive now + reminder wake later (`remindAt` ISO / `inMs`, default 24h); `gmail_list_reminders` lists them                                                                                                                                                                                                         |
| `gmail_get_attachment` | Save an attachment as a workspace file (sanitized name, 10MB cap, binary-safe) for normal file tooling                                                                                                                                                                                                              |
| `gmail_publish_digest` | Publish a compact `gmail.digest` card (≤5 rows + `moreCount`)                                                                                                                                                                                                                                                       |

## Push Notifications

With a generic `webhookIngress` Cloud Pub/Sub subscription targeting
`workers/gmail-agent:GmailAgentWorker:gmail-push-router` and
`googlePubSubTopicName` in the Gmail agent config (see
[Google Workspace setup](../../skills/google-workspace/SETUP.md)), the worker starts a
`users.watch` on subscribe and renews it daily via its alarm. The server only
verifies/decodes the generic webhook delivery; Gmail mailbox fanout happens in
the Gmail worker. Pushes sync within seconds; polling stretches to a
30-minute safety net. Without the topic, history-API polling (default 5 min)
is the only sync driver.

## Attention Preference API

Preferences live on the Gmail Durable Object as plain text:

| Method                                                                                 | Purpose                                                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `getAttentionPrefs(channelId)`                                                         | `{ preferencesText, knownSenderShortcut, updatedAt }`                          |
| `setAttentionPrefs(channelId, { preferences, knownSenderShortcut?, markConfigured? })` | Save preferences (user-facing callers only; DO callers may read but not write) |

```typescript
import { callGmailAgent } from "@workspace/gmail/agent";

await callGmailAgent(chat.channelId, "setAttentionPrefs", {
  preferences: "Wake me for invoices and anything from acme.example.",
});
```

## Channel Method Surface

These methods are callable on the Gmail participant via
`chat.callMethodByHandle("gmail", method, args)` (and from cards/action bar):

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

Other agents in the channel get a read-mostly surface (same dispatch):

| Method                 | Args                                   | Purpose                                        |
| ---------------------- | -------------------------------------- | ---------------------------------------------- |
| `gmail_query`          | `{ q, maxResults? }`                   | Cache-first thread search with API fallback    |
| `gmail_getThread`      | `{ threadId }`                         | Sanitized thread messages                      |
| `gmail_getOverview`    | `{}`                                   | Snapshot: counts, auth status, actionable list |
| `gmail_requestDraft`   | `{ threadId?, to?, subject?, intent }` | Compose card in `review` state                 |
| `gmail_resolveContact` | `{ name, limit? }`                     | Read-only contact resolution                   |

Agents can prepare mail but never send it: only the user's Send click on the
compose card (or an explicit user instruction to the Gmail agent) sends.
Attention-preference writes remain gated to user-facing callers; reads are open.

## Wake Batching

Wake hits (known-sender + triage `wake` verdicts) are queued and debounced
(~90s) into one digest turn covering all queued hits, capped at 4 wake turns
per hour per channel. The digest turn writes ONE short chat message and
publishes ONE `gmail.digest` card via `gmail_publish_digest`.

## Custom Message Types

The helper package still ships five renderer modules (mobile-first: 44px touch
targets, single column, ≤2 visible actions, whole-row taps):

| Type            | Renderer                                               | Display | Notes                                                                 |
| --------------- | ------------------------------------------------------ | ------- | --------------------------------------------------------------------- |
| `gmail.setup`   | `../../packages/gmail/src/renderers/gmail-setup.tsx`   | inline  | Connection status, preference text, Edit hands off to chat            |
| `gmail.digest`  | `../../packages/gmail/src/renderers/gmail-digest.tsx`  | row     | Immutable per-wake digest; scrolls away with chat                     |
| `gmail.search`  | `../../packages/gmail/src/renderers/gmail-search.tsx`  | row     | Ephemeral; `searching → done` patched in place; new search = new card |
| `gmail.thread`  | `../../packages/gmail/src/renderers/gmail-thread.tsx`  | inline  | Auto-loads on expand; AI draft + Send, rest behind "More"             |
| `gmail.compose` | `../../packages/gmail/src/renderers/gmail-compose.tsx` | row     | Review-before-send, contact autocomplete, `toCandidates` one-click    |

`gmail.digest` and `gmail.search` share
`../../packages/gmail/src/renderers/thread-row.tsx`. The old
`gmail.inbox` desk card is retired and tombstoned via `messageType.cleared` on
UI install.

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
