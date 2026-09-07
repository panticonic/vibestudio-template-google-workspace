/**
 * SignalEventEnvelope — typed contract for structured channel signal
 * payloads.
 *
 * The pubsub channel DO sends signal messages as
 * `{ id, content: string, contentType?: string }`. We layer a typed
 * convention on top: certain `contentType` values mean "the content is JSON
 * encoding a typed payload". `parseSignalEvent` decodes the payload while
 * filtering on contentType.
 *
 * The matching writer is `ChannelClient.sendSignalEvent<T>` in
 * `@workspace/agentic-do/src/channel-client.ts`.
 */

export interface SignalEventEnvelope<T> {
  contentType: string;
  payload: T;
}

/** A minimal signal message shape. */
export interface SignalMessageLike {
  content: string;
  contentType?: string;
}

/**
 * Decode a signal message into a typed payload, filtering by contentType.
 * Returns null if the contentType doesn't match or if the JSON is malformed.
 */
export function parseSignalEvent<T>(
  msg: SignalMessageLike,
  expectedContentType: string,
): T | null {
  if (msg.contentType !== expectedContentType) return null;
  try {
    return JSON.parse(msg.content) as T;
  } catch {
    return null;
  }
}
