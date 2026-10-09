---
name: google-workspace
description: Set up selected Google Workspace OAuth credentials with staged local bindings for Gmail, Calendar, Drive, Docs, Sheets, Slides, People, and identity.
onboarding:
  capabilities:
    - id: connection.google-workspace
      title: Google Workspace
      summary: Connect Gmail, Calendar, and Drive through one durable Google relationship.
      category: connections
      role: connection
      scope: user-workspace
      tier: direct
      visibility: primary
      actions:
        setup: { via: owner-skill }
        repair: { via: owner-skill }
        reconnect: { via: owner-skill }
        check: { via: owner-skill }
        inspect: { via: about-page, page: credentials }
        revoke: { via: about-page, page: credentials }
        grants: { via: about-page, page: permissions }
      setup:
        successDescription: A live Google user-info check succeeds for the stored connection.
        status:
          kind: credential-connection
          providerId: google-workspace
          clientConfigId: google-workspace
          verifyUrl: https://www.googleapis.com/oauth2/v3/userinfo
          identityField: email
---

# Google Workspace Skill

Use this skill to configure and verify Google Workspace OAuth for Gmail,
Calendar, Drive, Docs, Sheets, Slides, People, and identity. The aim is a setup
that keeps working, not just a one-time OAuth success. Guide the user to:

- a Desktop app OAuth client
- Production publishing
- offline refresh tokens
- permissions for the workflow they chose
- staged local bindings
- a verified live API call

## Onboarding Policy

Tell the user the current state and the next action. Do not ask them to paste
secrets into chat. When Google setup is incomplete, render
[GoogleWorkspaceSetup.tsx](GoogleWorkspaceSetup.tsx) with `inline_ui`; do not
replace it with a numbered list. Do not split the project, API, publishing,
client type, browser choice, or credential steps into separate feedback forms.
They are steps of one workflow, not separate onboarding questions.

Use this order:

1. Run `getGoogleOnboardingStatus()` and summarize the stage.
2. Unless `stage === "verified"`, show the persistent setup component.
3. Let its buttons call the configuration, connection, and verification
   helpers. Do not turn UI choices into eval calls of your own.
4. If `stage === "verified"`, continue onboarding.

Always connect Google Workspace with `connectGoogle()`. It requests Google
offline access and turns on Vibestudio's refresh-token storage. If status or
verification reports `credential-expired`, replace the old credential with
`connectGoogle({ force: true })`.

The setup card requests Gmail permissions first. **All Workspace apps** adds
Calendar, Drive, Docs, Sheets, Slides, and People. `connectGoogle({ scopes })`
requests the full selected scope set in a new Desktop-app consent flow, because
Google installed apps do not support incremental authorization. Existing grants
are kept when the selection grows. Bindings cover only the selected APIs. Before
the next workflow, check that the stored credential has the scopes it needs;
verifying identity alone does not prove access to mail or files.

When the user is setting up Gmail specifically, continue with
[Gmail onboarding](../../workers/gmail-agent/docs/ONBOARDING.md) once Google
Workspace reaches `verified`.

Never skip publishing to Production. In Testing mode, refresh tokens for Gmail,
Calendar, and Drive expire after 7 days.

## What The User Must Do

1. Create or choose a Google Cloud project.
2. Enable the Gmail, Calendar, Drive, Docs, Sheets, Slides, and People APIs.
3. Configure the OAuth consent screen with the required scopes.
4. Publish the app to Production, even while it is unverified.
5. Create OAuth credentials with application type **Desktop app**.
6. Click the component's **Save Desktop app details** button. It calls
   `configureGoogleOAuthClient()`, and the trusted prompt collects
   `installed.client_id` and `installed.client_secret`.
7. Click the component's **Connect Google** button.
8. Let the component verify a live Google API call.

Deep-link every Google Console step you can. Offer both:

- **Internal**: `openPanel(url, { focus: true })`
- **External**: `openExternal(url)`, the approval-gated browser-open API

In component handlers, await and catch either helper, show pending and error
state on the action that triggered it, and keep other controls enabled while a
panel boots or an approval is pending.

If the agent opens an internal browser panel only for setup guidance,
verification, or diagnostics, keep the handle and close the panel when that
step is done. Leave it open only if the user still needs it to work in Google
Cloud or the OAuth flow.

Read [SETUP.md](SETUP.md) for the full guided setup and
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common Google OAuth errors.

## Runtime Helpers

The helper package is importable in eval and panels:

```typescript
import {
  checkGoogleConnection,
  configureGoogleOAuthClient,
  connectGoogle,
  formatGoogleOnboardingStatus,
  getGoogleOnboardingStatus,
  verifyGoogleConnection,
} from "@workspace-skills/google-workspace";
```

Recommended status flow:

```typescript
const status = await getGoogleOnboardingStatus();
console.log(formatGoogleOnboardingStatus(status));

// Unless already verified, render:
// inline_ui({
//   path: "skills/google-workspace/GoogleWorkspaceSetup.tsx",
//   props: {},
// })
```

Use `checkGoogleConnection()` only for brief status checks. During onboarding,
use `getGoogleOnboardingStatus()`, which also returns next actions, warnings,
and checklist state.

## Reaching the Gmail agent from another conversation

The Gmail agent joins its channel with the handle `gmail`, which registers it in
the workspace agent directory as `gmail@<channelId>`, an address other agents
can message directly. Any agent in the workspace can find it and talk to it:

```ts
discover_agents({ query: "email" });
// → agent:gmail@ch-inbox   [idle]   Gmail
//     Triaged 12 threads; 2 need a reply.

notify({
  to: "agent:gmail@ch-inbox",
  content:
    "Can you extract the newsletter senders from the last 20 messages tagged `newsletters`?",
});
```

The message arrives as a normal message in the Gmail channel, marked as coming
from you and your conversation, and the reply comes back the same way. An agent
instance is a (worker, channel) pair, so plain `agent:gmail` is refused when the
worker is in more than one channel; include the channel.

In the other direction, the Gmail agent escalates to its owner. Triage digests
go out as `notify({ to: "owner" })` at the `inbox` level (a persistent entry
plus a phone push), and anything that truly cannot wait uses
`alert: "interrupt"`. Sync failures and reauthorization prompts are sent the
same way instead of only being logged. See the `messaging` skill for the syntax
and etiquette.

## Files

| Document                                 | Content                             |
| ---------------------------------------- | ----------------------------------- |
| [ONBOARDING.md](ONBOARDING.md)           | Agent-facing guided onboarding flow |
| [SETUP.md](SETUP.md)                     | Step-by-step Google Cloud setup     |
| [TESTING.md](TESTING.md)                 | Runtime verification snippets       |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common errors and fixes             |
| [index.ts](index.ts)                     | Importable onboarding helpers       |

## Related Follow-Up

Use these once Google Workspace is verified:

| Skill          | When to use                                                                           |
| -------------- | ------------------------------------------------------------------------------------- |
| `google-drive` | Browse, upload, share, export, or sync Google Drive files                             |
| `gmail`        | Set up the Gmail channel agent, custom message pills, action bar, and Gmail workflows |
