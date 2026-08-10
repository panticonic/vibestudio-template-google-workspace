# Google Workspace onboarding

Use the checked-in [GoogleWorkspaceSetup.tsx](GoogleWorkspaceSetup.tsx)
component for every incomplete Google setup state. Render it with `inline_ui`.
Do not turn the workflow into prose, feedback forms, or agent-authored helper
calls.

## Detect state

```ts
import { getGoogleOnboardingStatus }
  from "@workspace-skills/google-workspace";

return await getGoogleOnboardingStatus({ verify: true });
```

| Stage | Meaning | Action |
| --- | --- | --- |
| `needs-setup` | Desktop app details are not saved | Render the setup component |
| `ready-to-connect` | App details are saved | Keep the component visible; its Connect button owns the call |
| `connected` | A credential exists but is not verified | Keep the component visible; it verifies directly |
| `verified` | A live Google identity request succeeded | Continue onboarding |
| `error` | Status could not be read | Show the concrete error and retry in the component |

## Component contract

The component owns the entire user workflow:

- explains the Google Cloud project, API, consent-screen, Production, and
  Desktop app requirements;
- opens each Console step internally or in the user's normal browser;
- calls `configureGoogleOAuthClient()` from its button so the host-owned prompt
  collects the client ID and secret;
- calls `connectGoogle()` from its Connect button;
- verifies the live connection;
- renders pending, success, failure, and retry state.

It never stores secrets in React state or chat. It never returns setup choices
to the agent for translation into eval code.

## Recovery

- If verification reports `credential-expired` or the credential has no durable
  refresh token, reconnect with `connectGoogle({ force: true })`.
- If Google reports an API-disabled error, reopen the API library in the setup
  component and enable the named API in the same project.
- Testing-mode refresh tokens for Google user-data scopes can expire after
  seven days. Publish the consent screen to Production even when the app remains
  unverified for personal use.
- Consult [TROUBLESHOOTING.md](TROUBLESHOOTING.md) only after a concrete
  failure.

After Google reaches `verified`, continue to Gmail-specific setup only if the
user selected a Gmail goal.
