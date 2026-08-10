---
name: google-workspace
description: Set up broad Google Workspace OAuth credentials with staged local bindings for Gmail, Calendar, Drive, Docs, Sheets, Slides, People, and identity.
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
Calendar, Drive, Docs, Sheets, Slides, People, and identity. The goal is not
just "make OAuth work"; guide the user toward a durable setup with a Desktop
app OAuth client, Production publishing, offline refresh tokens, a broad
upstream Workspace grant, staged local bindings, and a verified live API call.

## Onboarding Policy

Be explicit about state and next action. Do not ask the user to paste secrets
into chat. When Google setup is incomplete, render
[GoogleWorkspaceSetup.tsx](GoogleWorkspaceSetup.tsx) with `inline_ui`; do not
replace it with a plain numbered list.
Do not split project, API, publishing, client type, browser placement, or
credential collection into separate feedback forms. Those are steps inside one
workflow, not independent onboarding questions.

Use this order:

1. Run `getGoogleOnboardingStatus()` and summarize the stage.
2. Unless `stage === "verified"`, show the persistent setup component.
3. Let its buttons call configuration, connection, and verification helpers.
4. Do not translate UI choices into agent-authored eval calls.
5. If `stage === "verified"`, continue onboarding.

`connectGoogle()` must be the connection path for Google Workspace. It requests
Google offline access and opts into Vibestudio refresh-token persistence. If
status or verification reports `credential-expired`, replace the old credential
with `connectGoogle({ force: true })`.

Vibestudio intentionally asks Google for a broad Workspace bundle once, then
stores separate local bindings: `google-gmail`, `google-calendar`,
`google-drive`, `google-docs`, `google-sheets`, `google-slides`,
`google-people`, and `google-identity`. Agents should use the service-specific
client/helper instead of asking the user to reconnect when moving from Gmail to
Calendar or Docs.

When the user is setting up Gmail specifically, continue with
[Gmail onboarding](../../workers/gmail-agent/docs/ONBOARDING.md) after Google
Workspace reaches `verified`.

Never skip the Production publishing step. Testing-mode refresh tokens for
Gmail, Calendar, and Drive expire after 7 days.

## What The User Must Do

1. Create or choose a Google Cloud project.
2. Enable the Gmail, Calendar, Drive, Docs, Sheets, Slides, and People APIs.
3. Configure the OAuth consent screen with the required scopes.
4. Publish the app to Production, even while unverified.
5. Create OAuth credentials with application type **Desktop app**.
6. Use the component's **Save Desktop app details** button. It calls
   `configureGoogleOAuthClient()` and the trusted prompt collects
   `installed.client_id` and `installed.client_secret`.
7. Use the component's **Connect Google** button.
8. Let the component verify a live Google API call.

Deep-link every Google Console step where possible. Offer both:

- **Internal**: `openPanel(url, { focus: true })`
- **External**: `openExternal(url)` through the approval-gated browser-open API

In component handlers, await and catch either helper, show action-scoped
pending/error state, and keep unrelated controls enabled while panel boot or an
approval decision is pending.

If the agent opens an internal browser panel only for setup guidance,
verification, or diagnostics, keep the handle and close it when that step is
complete. Leave it open only when the user needs to continue interacting with
Google Cloud or the OAuth flow in that panel.

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

Use `checkGoogleConnection()` only for terse status checks. Prefer
`getGoogleOnboardingStatus()` during onboarding because it includes next
actions, warnings, and checklist state.

## Files

| Document                                 | Content                             |
| ---------------------------------------- | ----------------------------------- |
| [ONBOARDING.md](ONBOARDING.md)           | Agent-facing guided onboarding flow |
| [SETUP.md](SETUP.md)                     | Step-by-step Google Cloud setup     |
| [TESTING.md](TESTING.md)                 | Runtime verification snippets       |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common errors and fixes             |
| [index.ts](index.ts)                     | Importable onboarding helpers       |

## Related Follow-Up

| Skill          | When to use                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `google-drive` | Browse, upload, share, export, or sync Google Drive files after Google Workspace is verified                                      |
| `gmail`        | Set up the Gmail channel agent, custom message pills, action bar, and Gmail-specific workflows after Google Workspace is verified |
