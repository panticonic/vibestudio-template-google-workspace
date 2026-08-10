# Gmail Agent Onboarding

## Detect State

```typescript
import { getGmailAgentSetupStatus } from "@workspace/gmail/agent";

const status = await getGmailAgentSetupStatus();
return status;
```

Stages:

| Stage | Meaning | Next Action |
|-------|---------|-------------|
| `needs-google-workspace` | Google OAuth is missing or unverified | Complete the Google Workspace skill |
| `needs-channel-setup` | Google Workspace is verified, but Gmail is not registered in this workspace | Run `setupGmailAgent({ channelId: chat.channelId })` |
| `ready` | Gmail agent is registered for this workspace | Use the Gmail action bar or `@gmail` |

## Setup

After Google Workspace reports verified, run Gmail setup directly:

```typescript
import { setupGmailAgent } from "@workspace/gmail/agent";

await setupGmailAgent({ channelId: chat.channelId });
```

The setup helper subscribes the Gmail worker and records it for panel reloads.
The Gmail worker then installs its own channel UI (renderers + action bar) and
starts the first-run attention conversation: it asks what mail deserves the
user's attention and saves the answer as natural-language preferences via its
`gmail_set_attention` tool.

Default incoming-mail attention is conservative: mail from senders the user
has replied to before wakes the agent (deterministic, free); everything else
goes through a batched cheap-model triage pass against the saved preference
text — and only after onboarding completes.

To set preferences programmatically (user-facing callers only):

```typescript
import { callGmailAgent } from "@workspace/gmail/agent";

await callGmailAgent(chat.channelId, "setAttentionPrefs", {
  preferences: "Invoices, scheduling changes, and anything from customer.example.",
  markConfigured: true,
});
```

## Completion Criteria

- Google Workspace credential is verified.
- The Gmail agent participant is present with handle `gmail`.
- Gmail custom message renderers are registered in the channel by the worker.
- The Gmail action bar is loaded from the worker's channel UI event.
- The user has either saved attention preferences in their own words or
  explicitly kept the default (known-sender wakes only).
