/**
 * Workerd-specific type augmentations owned by the pubsub-channel worker.
 *
 * These extend the standard WebSocket and Response types with APIs
 * available in the workerd runtime (Hibernatable WebSocket API, WebSocketPair).
 */

declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

interface WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

interface ResponseInit {
  webSocket?: WebSocket;
}
