# Testing Google Workspace

After saving the Google OAuth client setup, verify the setup in a Vibestudio
panel or eval context.

## Check Configuration And Stored Connection

```typescript
import {
  formatGoogleOnboardingStatus,
  getGoogleOnboardingStatus,
} from "@workspace-skills/google-workspace";

const status = await getGoogleOnboardingStatus();
console.log(formatGoogleOnboardingStatus(status));
```

Expected after setup and connect:

```typescript
{
  stage: "connected",
  configured: true,
  readyToConnect: true,
  connected: true,
  email: "user@example.com"
}
```

## Connect

```typescript
import { connectGoogle } from "@workspace-skills/google-workspace";

const result = await connectGoogle();
console.log(result);
```

This opens the browser, waits for the local OAuth callback, and stores the
resulting credential.

If this reports missing setup, save the Desktop app OAuth client fields with
the Google setup workflow UI/provider setup path. Do not ask the user to paste
client secrets into chat.

## Verify With A Live API Call

```typescript
import { verifyGoogleConnection } from "@workspace-skills/google-workspace";

const status = await verifyGoogleConnection("connection-id");
console.log(status);
```

Expected:

```typescript
{
  valid: true,
  email: "user@example.com",
  scopes: [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/presentations"
  ]
}
```

## Full Onboarding Check

```typescript
import {
  formatGoogleOnboardingStatus,
  getGoogleOnboardingStatus,
} from "@workspace-skills/google-workspace";

const status = await getGoogleOnboardingStatus({ verify: true });
console.log(formatGoogleOnboardingStatus(status));
```

Expected final stage:

```typescript
{
  stage: "verified",
  configured: true,
  readyToConnect: true,
  connected: true,
  verification: { valid: true }
}
```
