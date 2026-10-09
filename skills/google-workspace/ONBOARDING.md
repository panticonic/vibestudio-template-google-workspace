# Google Workspace onboarding

Use the checked-in [GoogleWorkspaceSetup.tsx](GoogleWorkspaceSetup.tsx)
component for every incomplete Google setup state, rendered with `inline_ui`. Do
not turn the workflow into prose, feedback forms, or helper calls you write
yourself.

## Detect state

```ts
import { getGoogleOnboardingStatus } from "@workspace-skills/google-workspace";

return await getGoogleOnboardingStatus({ verify: true });
```

| Stage              | Meaning                                  | Action                                                  |
| ------------------ | ---------------------------------------- | ------------------------------------------------------- |
| `needs-setup`      | Desktop app details are not saved        | Render the setup component                              |
| `ready-to-connect` | App details are saved                    | Keep the component visible; its Connect button does it  |
| `connected`        | A credential exists but is not verified  | Keep the component visible; it runs verification itself |
| `verified`         | A live Google identity request succeeded | Continue onboarding                                     |
| `error`            | Status could not be read                 | Show the specific error and retry in the component      |

## Component contract

The component runs the whole user workflow. It:

- explains the Google Cloud project, API, consent-screen, Production, and
  Desktop app requirements;
- opens each Console step inside Vibestudio or in the user's normal browser;
- calls `configureGoogleOAuthClient()` from its button, so the host prompt
  collects the client ID and secret;
- calls `connectGoogle({ scopes })` for the Gmail-only or full Workspace
  selection the user made;
- verifies the live connection;
- shows pending, success, failure, and retry states.

It never keeps secrets in React state or chat, and it never hands setup choices
back to the agent to turn into eval code.

## Recovery

- If verification reports `credential-expired`, or the credential has no stored
  refresh token, reconnect with `connectGoogle({ force: true })`.
- If Google reports that an API is disabled, reopen the API library from the
  setup component and enable that API in the same project.
- In Testing mode, refresh tokens for Google user-data scopes can expire after
  seven days. Publish the consent screen to Production even if the app stays
  unverified for personal use.
- Read [TROUBLESHOOTING.md](TROUBLESHOOTING.md) only after a specific failure.

After Google reaches `verified`, continue to Gmail setup only if the user chose
a Gmail goal and the verified credential includes the Gmail scopes. A verified
identity alone does not grant access to any service.
