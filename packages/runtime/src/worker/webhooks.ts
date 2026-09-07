/**
 * Worker-side webhook ingress client types.
 *
 * Worker-side code accesses webhooks through the runtime's `webhooks`
 * namespace, which is bound to the right RPC bridge for the current
 * context. See the note in `./credentials.ts` for the same rationale.
 */

export type {
  CreateWebhookIngressSubscriptionRequest,
  RotateWebhookIngressSecretRequest,
  RotateWebhookIngressSecretResult,
  WebhookDeliveredPayload,
  WebhookDeliveryConfig,
  WebhookDeliveryEvent,
  WebhookIngressClient,
  WebhookIngressSubscriptionSummary,
  WebhookPayloadFormat,
  WebhookReplayConfig,
  WebhookResponsePolicy,
  WebhookTarget,
  WebhookVerifierConfig,
} from "../shared/webhooks.js";
