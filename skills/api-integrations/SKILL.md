---
name: api-integrations
description: Connect, use, or diagnose external APIs through host-mediated credentials and egress.
---

# API integrations

Credentials are host-held, URL-bound, and usable only through mediated egress.
Workspace code must never receive, log, or relay secret material.

Use `docs_search`/`docs_open` for current `credentials` schemas. The public
workspace client lives under `packages/runtime/src`; host-side wire schemas are
in the service-schema package.

## Missing credentials

Treat missing credentials as normal setup state. Ask only for non-secret facts
needed to identify the provider and audience. Never open a prompt with
placeholder endpoints, search source for a secret, or fall back to a lower-level
credential service.

Credential IDs are opaque — preserve the complete returned value including any
prefix. For diagnostic probes, convert only the canonical unavailable outcome to
`{ missing: true }` and rethrow everything else. Never return raw errors,
metadata, or request details.

Call the setup API once. A denial or cancellation ends that attempt.

## Setup experience

- Use one persistent `inline_ui` workflow for multi-step setup, with controls
  calling trusted helpers directly.
- Put provider-console links next to the step that needs them. Offer
  `openPanel(...)` and `openExternal(...)` when both apply.
- For OAuth authorize URLs, pass the expected redirect URI to
  `openExternal(...)` so the host validates the callback.
- Ask about user outcomes, not OAuth vocabulary, credential formats, or storage
  mechanics. Put exceptional choices behind an advanced path.
- Collect secrets only through host-owned credential input or a dedicated
  provider workflow — never chat, feedback forms, or panel React state.
- Keep provider choice, access intent, browser action, progress, error, and
  retry in one workflow per connection attempt.

Use owner skills for GitHub, Google Workspace, and web-search providers.

## Credential mechanisms

Import `credentials` from `@workspace/runtime` (not an ambient eval global).
Prefer provider OAuth over static tokens when available.

| Method | Use for |
| --- | --- |
| `requestCredentialInput` | User-entered static API keys or tokens |
| `connect` | Host-owned OAuth (host stores tokens; userland supplies public config and audience) |
| `configureClient` | Separate OAuth client material storage |
| `fetch` | Authenticated HTTP requests |
| `gitHttp` | Git smart HTTP |
| `forAudience` / `hookForUrl` | Only when their live contract matches the caller's transport |

Read the live schema for supported OAuth flow discriminants. Choose
authorization-code with PKCE for redirect-capable interactive clients, device
code when callbacks can't reach the server, and client credentials only for
service identity.

When durable renewal is requested, verify the stored result's lifecycle facts —
requested scopes or a refresh token alone don't guarantee renewal. OAuth client
configs are bound to their endpoints; create a distinct config when that binding
changes.

## Using credentials

```ts
import { credentials } from "@workspace/runtime";

const response = await credentials.fetch(
  "https://api.example.com/items",
  undefined,
  { credentialId },
);
```

The credential audience must cover the exact destination. Never splice tokens
into URLs or headers yourself.

For unmanaged Git, use `@vibestudio/git` with `credentials.gitHttp()`. For
shared managed repos, use the runtime `git` provider and [Git
Bridge](../../extensions/git-bridge/SKILL.md). Remote declarations contain
credential-free HTTP(S) URLs and logical credential names, never concrete
secrets. Imports return unpublished semantic candidates and never advance
protected main by themselves.

For external-project onboarding, read
[EXTERNAL_GIT_PROJECTS.md](../onboarding/EXTERNAL_GIT_PROJECTS.md). For webhook
receivers, use live capability docs and the owning unit's authority contract;
credential storage is not a substitute for request verification.
