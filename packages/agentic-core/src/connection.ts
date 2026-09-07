/**
 * ConnectionManager — Headless PubSub connection lifecycle.
 *
 * PubSub connection lifecycle — connect, disconnect, event loop, roster.
 * Manages connect/disconnect, event loop, roster, reconnect.
 */

import { connectViaRpc, resolveRpcChannelTarget } from "@workspace/pubsub";
import type {
  PubSubClient,
  RosterUpdate,
  IncomingEvent,
  MethodDefinition,
  ChannelConfig,
} from "@workspace/pubsub";
import type { ChatParticipantMetadata, ConnectionConfig } from "./types.js";
import {
  DEFAULT_CHANNEL_ENVELOPE_PAGE_LIMIT,
  MAX_CHANNEL_ENVELOPE_PAGE_LIMIT,
} from "@vibestudio/shared/channelEnvelopePaging";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

/** A local channel subscription is expected to reach its replay boundary
 * promptly. More importantly, every connection attempt must have a terminal
 * outcome: without a deadline a lost ready marker leaves callers displaying a
 * permanent loading state and leaves the half-open transport alive forever. */
export const CONNECTION_READY_TIMEOUT_MS = 15_000;

/**
 * Client-supplied participant metadata for connecting (WP6 §5). `handle` is
 * OPTIONAL here: a human panel no longer asserts one — the channel derives the
 * authoritative identity (`user:<userId>`, account handle/displayName) from the
 * host-verified subject on the caller envelope (WP6 §3). What the client sends
 * is a panel LABEL for its own UI, not identity. Agents/vessels still supply
 * their own descriptor (they are not human accounts).
 */
export type ClientParticipantMetadata = Partial<ChatParticipantMetadata> &
  Pick<ChatParticipantMetadata, "name" | "type">;

export interface ConnectionCallbacks {
  onEvent?: (event: IncomingEvent) => void | Promise<void>;
  onRoster?: (roster: RosterUpdate<ChatParticipantMetadata>) => void;
  onError?: (error: Error) => void;
  onReconnect?: () => void;
  onStatusChange?: (status: ConnectionStatus) => void;
}

export interface ConnectionConnectOptions {
  channelId: string;
  channelTargetId?: string;
  methods: Record<string, MethodDefinition>;
  channelConfig?: ChannelConfig;
  contextId?: string;
}

export class ConnectionManager {
  private config: ConnectionConfig;
  private metadata: ClientParticipantMetadata;
  private callbacks: ConnectionCallbacks;
  private _client: PubSubClient<ChatParticipantMetadata> | null = null;
  private _status: ConnectionStatus = "disconnected";
  private _clientId: string | null = null;
  private unsubscribers: Array<() => void> = [];
  private connectAbortController: AbortController | null = null;
  private disconnectPromise: Promise<void> | null = null;

  constructor(opts: {
    config: ConnectionConfig;
    metadata: ClientParticipantMetadata;
    callbacks: ConnectionCallbacks;
  }) {
    this.config = opts.config;
    this.metadata = opts.metadata;
    this.callbacks = opts.callbacks;
  }

  get client(): PubSubClient<ChatParticipantMetadata> | null {
    return this._client;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  get connected(): boolean {
    return this._status === "connected";
  }

  get clientId(): string | null {
    return this._clientId;
  }

  async connect(options: ConnectionConnectOptions): Promise<PubSubClient<ChatParticipantMetadata>> {
    const { channelId, channelTargetId, methods, channelConfig, contextId } = options;
    const replayMessageLimit = Math.min(
      this.config.replayMessageLimit ?? DEFAULT_CHANNEL_ENVELOPE_PAGE_LIMIT,
      MAX_CHANNEL_ENVELOPE_PAGE_LIMIT
    );

    if (!this.config.rpc) {
      const error = new Error("PubSub RPC configuration not available");
      this.callbacks.onError?.(error);
      this.setStatus("error");
      throw error;
    }

    // Close existing connection if any
    try {
      await this.disconnect();
    } catch (error) {
      // A failed graceful leave is a transport failure. Surface it, then let
      // the new subscription replace the old transport generation.
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
    this.setStatus("connecting");
    const readyAbort = new AbortController();
    this.connectAbortController = readyAbort;
    let readyTimedOut = false;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;

    let newClient: PubSubClient<ChatParticipantMetadata> | null = null;
    try {
      const resolvedChannelTargetId =
        channelTargetId ??
        (await resolveRpcChannelTarget({
          rpc: this.config.rpc,
          reviewRpc: this.config.rpc,
          channel: channelId,
          protocol: this.config.protocol,
          signal: readyAbort.signal,
          resolutionTimeoutMs: CONNECTION_READY_TIMEOUT_MS,
        }));
      if (this.connectAbortController !== readyAbort) {
        throw new Error("Connection attempt was superseded");
      }
      // The replay deadline begins only after the service is runnable. A human
      // reviewing a fresh workspace is not a slow or half-open channel.
      readyTimer = setTimeout(() => {
        readyTimedOut = true;
        readyAbort.abort();
      }, CONNECTION_READY_TIMEOUT_MS);
      newClient = connectViaRpc<ChatParticipantMetadata>({
        rpc: this.config.rpc,
        channel: channelId,
        channelTargetId: resolvedChannelTargetId,
        contextId,
        channelConfig,
        // No asserted HUMAN handle (WP6 §5): the channel stamps human identity
        // from the host-verified subject, ignoring client-supplied handles.
        // Agents/headless workers still pass their own descriptor through.
        ...(this.metadata.handle !== undefined ? { handle: this.metadata.handle } : {}),
        name: this.metadata.name,
        type: this.metadata.type,
        clientId: this.config.clientId,
        protocol: this.config.protocol,
        // Roster reads stay `ChatParticipantMetadata` (the channel fills the
        // authoritative handle); only the OUTBOUND label may omit it.
        metadata: this.metadata as ChatParticipantMetadata,
        methods,
        replayMode: "stream",
        replayMessageLimit,
        deliveryMode: this.config.deliveryMode,
        ...(this.config.deliveryMode === "resident" && this.callbacks.onEvent
          ? { residentEventHandler: this.callbacks.onEvent }
          : {}),
        recoveryCoordinator: this.config.recoveryCoordinator,
      });

      // Wait for the initial replay to complete
      await newClient.ready(readyAbort.signal);
      if (contextId && newClient.contextId !== contextId) {
        const resolved = newClient.contextId ?? "none";
        await newClient.close();
        throw new Error(
          `Channel ${channelId} resolved in context ${resolved}, expected ${contextId}`
        );
      }
      if (this.connectAbortController !== readyAbort) {
        await newClient.close();
        throw new Error("Connection attempt was superseded");
      }
      this.connectAbortController = null;

      this._client = newClient;
      this._clientId = newClient.clientId ?? null;
      console.info("[ConnectionManager] channel replay connected", {
        channelId,
        requestedContextId: contextId ?? null,
        resolvedContextId: newClient.contextId ?? null,
        replayMessageLimit,
        totalMessageCount: newClient.totalMessageCount ?? null,
        envelopeCount: newClient.envelopeCount ?? null,
        firstEnvelopeSeq: newClient.firstEnvelopeSeq ?? null,
        hasMoreBefore: newClient.hasMoreBefore ?? null,
      });

      const unsubs: Array<() => void> = [];

      // Stream transports own an event iterator. Resident transports invoke
      // the application handler inside the finite delivery RPC above so the
      // durable sender cannot acknowledge an unprojected event.
      if (this.config.deliveryMode !== "resident") {
        const eventIterator = newClient.events({
          includeReplay: true,
          includeSignals: true,
        });
        let eventLoopRunning = true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let eventIteratorRef: AsyncIterableIterator<any> | null = eventIterator;

        void (async () => {
          try {
            for await (const event of eventIterator) {
              if (!eventLoopRunning) break;
              try {
                await this.callbacks.onEvent?.(event as IncomingEvent);
              } catch (eventError) {
                console.error("[ConnectionManager] Event callback error:", eventError);
                this.callbacks.onError?.(
                  eventError instanceof Error ? eventError : new Error(String(eventError))
                );
              }
            }
          } catch (streamError) {
            console.error("[ConnectionManager] Event stream error:", streamError);
            this.callbacks.onError?.(
              streamError instanceof Error ? streamError : new Error(String(streamError))
            );
          } finally {
            eventIteratorRef = null;
          }
        })();
        unsubs.push(() => {
          eventLoopRunning = false;
          eventIteratorRef?.return?.();
          eventIteratorRef = null;
        });
      }

      // Set up roster handler
      unsubs.push(
        newClient.onRoster((roster: RosterUpdate<ChatParticipantMetadata>) => {
          try {
            this.callbacks.onRoster?.(roster);
          } catch (rosterError) {
            console.error("[ConnectionManager] Roster callback error:", rosterError);
          }
        })
      );

      // Set up reconnect handler
      unsubs.push(
        newClient.onReconnect(() => {
          try {
            this.callbacks.onReconnect?.();
          } catch (reconnectError) {
            console.error("[ConnectionManager] Reconnect callback error:", reconnectError);
          }
        })
      );

      this.unsubscribers = unsubs;
      this.setStatus("connected");
      return newClient;
    } catch (err) {
      const error = readyTimedOut
        ? new Error(
            `Channel ${channelId} did not finish loading within ${CONNECTION_READY_TIMEOUT_MS / 1_000} seconds`
          )
        : err instanceof Error
          ? err
          : new Error(String(err));
      await newClient?.close().catch(() => undefined);
      if (readyAbort.signal.aborted && this.connectAbortController !== readyAbort) {
        throw error;
      }
      if (this.connectAbortController === readyAbort) {
        this.connectAbortController = null;
      }
      this.callbacks.onError?.(error);
      this.setStatus("error");
      await this.disconnect().catch(() => undefined);
      throw error;
    } finally {
      if (readyTimer !== null) clearTimeout(readyTimer);
    }
  }

  disconnect(): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise;
    this.connectAbortController?.abort();
    this.connectAbortController = null;

    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    const client = this._client;
    this._client = null;
    this._clientId = null;
    this.setStatus("disconnected");

    if (!client) return Promise.resolve();
    const closing = client.close();
    const tracked = closing.finally(() => {
      if (this.disconnectPromise === tracked) this.disconnectPromise = null;
    });
    this.disconnectPromise = tracked;
    return tracked;
  }

  private setStatus(status: ConnectionStatus): void {
    this._status = status;
    this.callbacks.onStatusChange?.(status);
  }
}
