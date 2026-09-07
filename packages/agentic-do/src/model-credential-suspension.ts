import type { EffectOutcome } from "@workspace/agent-loop";

type ModelCredentialSuspensionOutcome = Extract<EffectOutcome, { kind: "model-suspended" }>;

export function modelCredentialReconnectOutcome(input: {
  providerId: string;
  modelBaseUrl?: string;
  reason?: string;
  failureCode?: string;
}): ModelCredentialSuspensionOutcome {
  return {
    kind: "model-suspended",
    reason: "credential",
    providerId: input.providerId,
    ...(input.modelBaseUrl ? { modelBaseUrl: input.modelBaseUrl } : {}),
    waitReason: "model_credential_reconnect_required",
    ...(input.reason ? { diagnosticReason: input.reason } : {}),
    ...(input.failureCode ? { failureCode: input.failureCode } : {}),
  };
}
