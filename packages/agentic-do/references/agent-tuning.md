# Agent Tuning

Use this guide when changing the AI chat agent's model, provider, credential
setup, thinking effort, approval behavior, or response policy.

## Two Tiers

Cold-start choices live in `src/agent-config.ts`:

- `DEFAULT_MODEL` chooses the default `provider:modelId`.
- `PROVIDER_CREDENTIAL_SETUPS` wires OAuth or API-key credential collection and
  is derived from the shared provider presets in
  `@workspace/model-catalog/providerConnect`.
- These choices apply when a worker boots or when an agent is created with an
  `extraConfig.model` override. `setModel({ model })` changes the persisted live
  agent setting afterward; behavior settings belong to the agent, not to one
  channel subscription.

To inspect configured provider credential presets from eval, import the small
model-catalog surface rather than the full agent DO package:

```ts
import { listProviderConnectPresets } from "@workspace/model-catalog/providerConnect";
const providers = listProviderConnectPresets();
```

Session knobs are method calls on the agent participant:

- `setThinkingLevel({ level })` where `level` is `minimal`, `low`, `medium`, or
  `high`.
- `setFastMode({ enabled })` requests the accelerated Codex service tier on
  models that advertise it.
- `setModel({ model })` where `model` is a current `provider:modelId` catalog
  entry.
- `setApprovalLevel({ level })` where `level` is `0`, `1`, or `2`.
- `setRespondPolicy({ policy, from? })` where `policy` is `all`, `mentioned`,
  `mentioned-strict`, or `from-participants`.
- `getAgentSettings()` returns current values and whether each came from state,
  subscription config, or defaults.
- `connectModelCredential({ providerId, ... })` starts the provider's OAuth or
  API-key credential flow.

## Switching The Default Model

Edit `src/agent-config.ts` and set `DEFAULT_MODEL`.

Examples:

- OpenAI Codex: `openai-codex:gpt-5.6-sol`
- Anthropic flagship: `anthropic:claude-opus-4-7`
- Anthropic Sonnet: `anthropic:claude-sonnet-4-6`
- Google Vertex flagship: `google-vertex:gemini-3.1-pro`

When editing `agent-config.ts`, prefer the provider's current flagship. If you
do not know what that is, check the provider's announcements page; the catalog
exposed through `@workspace/pi-ai/providers/all` is the source of truth for ids
wired into the runtime.

The enabled thinking levels accepted by the harness are `minimal`, `low`,
`medium`, `high`, `xhigh`, and `max`. The configuration UI only shows
levels advertised by the selected model. Programmatic values unsupported by a
model are clamped by pi-ai to that model's supported range.

## Adding An OAuth Provider

Add or update the provider preset in the shared provider-connect registry:
`@workspace/model-catalog/providerConnect`. In workspace source, that registry
lives at `../model-catalog/src/providerConnect.ts`.

Verify every URL and scope against the provider's current docs before enabling
it. OAuth endpoints and scopes are product-specific and can drift.

If the provider returns account identity in a nonstandard claim, also update the
concrete worker override that passes token claims to the model SDK. For the
standard chat agent, that is
`../../workers/agent-worker/ai-chat-worker.ts`.

## Adding An API-Key Provider

Add or update the provider preset in `@workspace/model-catalog/providerConnect`.
In workspace source, edit `../model-catalog/src/providerConnect.ts`.

Set:

- `providerId` by using the provider id as the map key.
- `DEFAULT_MODEL` to the matching `provider:modelId`.
- `credential.audience` to the provider API origin/base path.
- `credential.injection.name` and `valueTemplate` to the provider's auth header
  convention.

`materialTemplate` controls what token material is stored.
`credential.injection` controls what is placed on outbound model requests.

## Tuning A Live Session

Use `inline_ui`, `ActionButton`, or a small action bar that calls the agent
participant's methods. A minimal inline UI can call:

```tsx
await chat.callMethod(agentParticipantId, "setThinkingLevel", { level: "high" });
await chat.callMethod(agentParticipantId, "setFastMode", { enabled: true });
await chat.callMethod(agentParticipantId, "setApprovalLevel", { level: 1 });
await chat.callMethod(agentParticipantId, "setRespondPolicy", {
  policy: "from-participants",
  from: ["participant-id"],
});
const settings = await chat.callMethod(agentParticipantId, "getAgentSettings", {});
```

## Per-Channel Overrides

Headless/session subscribers may pass `extraConfig`:

```ts
{
  model: "anthropic:claude-sonnet-4-6",
  thinkingLevel: "high",
  fastMode: true,
  fallbackModel: "openai-codex:gpt-5.6-luna",
  fallbackThinkingLevel: "minimal",
  fallbackOn: ["usage_limit_terminal"],
  fallbackScope: "all-turns",
  approvalLevel: 1,
  respondPolicy: "mentioned",
  systemPrompt: "Extra instructions...",
  systemPromptMode: "append",
}
```

Lookup order:

- `model`, `thinkingLevel`, and `fastMode`: persisted live settings (initially seeded from
  the agent-creation config), then default.
- `fallbackModel`, `fallbackThinkingLevel`, `fallbackOn`, and `fallbackScope`:
  persisted live setting seeded from agent creation. Failover activates once,
  then every post-tool continuation in that turn stays on the journaled
  fallback route; a fallback failure closes the turn instead of creating an
  unbounded retry loop. `fallbackScope: "all-turns"`
  includes direct user turns; `"unattended"` limits it to background work.
- `approvalLevel`: channel consent config when set, otherwise the persisted
  per-agent value, then default.
- `respondPolicy` and `respondFrom`: persisted live setting seeded from agent
  creation, then default.

`fallbackOn` contains durable model failure codes. For example,
`["usage_limit_terminal"]` switches only after an actual terminal usage-limit
failure; ordinary provider failures remain visible and do not silently change
models. The fallback call records both the failed and selected model refs in the
trajectory.
