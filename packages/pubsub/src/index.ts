/**
 * `@workspace/pubsub` — stateful pub/sub channels with structured
 * method calls, participant presence, replay, and chat-shaped binary
 * attachments. For point-to-point fetch-shaped
 * RPC (with streaming bodies) use `@vibestudio/rpc` instead. See
 * `docs/architecture/rpc-and-services.md` for the boundary.
 *
 * Provides real-time messaging between panels and workers via RPC
 * with Durable Object message history.
 *
 * @example Basic usage
 * ```typescript
 * import { connectViaRpc } from "@workspace/pubsub";
 *
 * const channelId = "chat";
 * const client = connectViaRpc({
 *   rpc,
 *   channel: channelId,
 *   name: `Channel ${channelId}`,
 *   type: "panel",
 * });
 *
 * await client.ready();
 *
 * for await (const event of client.events({ includeReplay: true })) {
 *   console.log(event.type, event);
 * }
 * ```
 */

export * from "./types.js";
export type { PubSubClient } from "./client.js";
export { CHANNEL_CLOSE_TIMEOUT_MS, connectViaRpc, resolveRpcChannelTarget } from "./rpc-client.js";
export type { RpcChannelTargetOptions, RpcConnectOptions } from "./rpc-client.js";
export { waitForApprovalResolution } from "./review-readiness.js";
export { draft7MetaSchema } from "./json-schema-draft-07.js";
export { iterateChannelReplayAfterPages, type ChannelReplayPageReader } from "./channel-replay.js";
export {
  CHANNEL_SUBSCRIPTION_BUFFER_BYTES,
  channelSubscriptionQueuingStrategy,
  encodeChannelSubscriptionRecord,
  enqueueChannelSubscriptionBytes,
  readChannelSubscriptionRecords,
  type ChannelSubscriptionEnqueueResult,
  type ChannelSubscriptionRecord,
} from "@vibestudio/service-schemas/channel";

// Content type constants
export * from "./content-types.js";

// Wire protocol types (shared with channel DO server)
export * from "./protocol-wire.js";

// Protocol types (agentic messaging types and events)
export * from "./protocol-types.js";

// Tracker types and interfaces
export * from "./tracker-types.js";

// Tracker factory functions
export { createThinkingTracker, createActionTracker } from "./tracker-factories.js";

// Tool name utilities
export * from "./tool-name-utils.js";

// Tool schemas and validation
export * from "./tool-types.js";

// Tool approval logic
export * from "./tool-approval.js";

// Context window usage types
export * from "./context-tracker.js";

// Action descriptions
export { getDetailedActionDescription } from "./action-descriptions.js";

// TODO list types and code generation
export { type TodoItem, getTodoListCode, getCachedTodoListCode } from "./todo-types.js";

// Protocol message schemas (Zod)
export * from "./protocol.js";

// Protocol schemas (feedback UI, field definitions)
export {
  FieldDefinitionSchema,
  FeedbackFormArgsSchema,
  FeedbackCustomArgsSchema,
  RequiredMethodSpecSchema,
  MethodAdvertisementSchema,
  AgentTypeAdvertisementSchema,
  RegisterMessageTypeArgsSchema,
  MessageTypeDefinitionSchema,
  PublishCustomMessageArgsSchema,
  UpdateCustomMessageArgsSchema,
  type FeedbackFormArgs,
  type FeedbackCustomArgs,
  type RegisterMessageTypeArgs,
  type PublishCustomMessageArgs,
  type UpdateCustomMessageArgs,
} from "./protocol-schemas.js";

// JSON Schema to Zod conversion (canonical home: agentic-protocol)
export { jsonSchemaToZod, jsonSchemaToZodRawShape, isRecord } from "@workspace/agentic-protocol";

// Image processing utilities
export {
  SUPPORTED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  isImageMimeType,
  validateAttachment,
  validateAttachments,
  uint8ArrayToBase64,
  base64ToUint8Array,
  buildClaudeContentBlocks,
  buildOpenAIContents,
  filterImageAttachments,
  formatBytes,
  type SupportedImageType,
  type AttachmentValidationResult,
  type ClaudeImageBlock,
  type ClaudeTextBlock,
  type ClaudeContentBlock,
  type OpenAIImageContent,
  type OpenAITextContent,
  type OpenAIContent,
} from "./image-utils.js";

// Async utilities
export { AsyncQueue, createFanout } from "./async-queue.js";

// Approval schema builder
export { createApprovalSchema, type CreateApprovalSchemaParams } from "./approval-schema.js";
