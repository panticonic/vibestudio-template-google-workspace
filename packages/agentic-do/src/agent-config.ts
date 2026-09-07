import type { ThinkingLevel } from "@workspace/harness";

type ApprovalLevel = 0 | 1 | 2;
import {
  listProviderConnectPresets,
  toAgentCredentialSetup,
} from "@workspace/model-catalog/providerConnect";
import { DEFAULT_AGENT_MODEL_REF } from "@workspace/model-catalog/catalog";

/** Connect-preset props handed to the credential-connect card. */
export type ModelCredentialSetupProps = NonNullable<ReturnType<typeof toAgentCredentialSetup>>;

export const OPENAI_CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";

/** Default model in "provider:modelId" form. pi-ai owns the provider registry. */
export const DEFAULT_MODEL = DEFAULT_AGENT_MODEL_REF;

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/** Default approval: 0=manual, 1=auto-safe, 2=full-auto. */
export const DEFAULT_APPROVAL_LEVEL: ApprovalLevel = 2;

export const DEFAULT_RESPOND_POLICY = "all" as const;

/**
 * Agent-side model credential connect setups. Derived from the shared provider
 * connect presets (`@workspace/model-catalog/providerConnect`) so the panel
 * picker and the agent share one source. Any provider in the shared preset list
 * can be connected from first-run onboarding, the model picker, or a mid-turn
 * credential prompt.
 */
export const PROVIDER_CREDENTIAL_SETUPS: Record<string, ModelCredentialSetupProps> = (() => {
  const setups: Record<string, ModelCredentialSetupProps> = {};
  for (const preset of listProviderConnectPresets()) {
    const setup = toAgentCredentialSetup(preset.providerId);
    if (setup) setups[preset.providerId] = setup;
  }
  return setups;
})();

export const MODEL_CREDENTIAL_PROVIDER_IDS = Object.freeze(
  listProviderConnectPresets().map((preset) => preset.providerId)
);
