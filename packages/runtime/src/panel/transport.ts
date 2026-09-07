import {
  bridgeStreamSurfaceOf,
  openBridgeStream,
  openBridgeUploadStream,
  rpcErrorDataOf,
  rpcErrorKindOf,
  responseEnvelopeFor,
  type BridgeStreamShellSurface,
  type EnvelopeRpcTransport,
  type RpcEnvelope,
  type RpcRequest,
} from "@vibestudio/rpc";
import { createRecoveryCoordinator } from "@vibestudio/shell-core/recoveryCoordinator";
import type { RecoveryCoordinator, RecoveryKind } from "@vibestudio/shell-core/recoveryCoordinator";

/**
 * The host bridge a panel reaches its server through. A panel lives in a webview
 * and cannot touch the host's server transport directly, so its RPC
 * crosses the webview boundary over the **shell bridge** — Electron
 * `contextBridge` IPC (`__vibestudioShell`) on desktop, the React-Native
 * `postMessage` bridge injected by `PanelWebView` on mobile. The host forwards
 * each panel's envelopes onto its single control channel as that panel's own
 * logical session (per-panel principal, lease, and recovery preserved exactly)
 * and delivers the demuxed inbound envelopes back via `onEnvelope`. There is no
 * panel-side socket and no direct `ws://…/rpc` connection.
 */
type vibestudioShellBridge = Partial<BridgeStreamShellSurface> & {
  /** Post one RPC envelope to the host (→ this panel's logical session on the pipe). */
  postEnvelope: (envelope: RpcEnvelope) => void | Promise<void>;
  /** Subscribe to inbound envelopes the host demuxes for this panel's session. */
  onEnvelope: (handler: (envelope: RpcEnvelope) => void) => () => void;
  /** Optional recovery signals (resubscribe / cold-recover) raised by the host. */
  onRecovery?: (kind: RecoveryKind, handler: () => void | Promise<void>) => () => void;
  /**
   * Optional first-class streaming: the host physically streams the response
   * body over the **bulk channel** and returns a `Response`. When absent, the
   * RPC client transparently falls back to the duplex stream-request /
   * stream-frame envelope path over `postEnvelope`/`onEnvelope`. A bridge that
   * exposes this MUST honour the `body` param (or throw) — never drop it.
   */
  stream?: (
    envelope: RpcEnvelope,
    signal?: AbortSignal | null,
    body?: ReadableStream<Uint8Array> | null
  ) => Promise<Response>;
  /** Electron-only: IPC dispatch for electron-local services (kept as-is). */
  serviceCall?: (method: string, ...args: unknown[]) => Promise<unknown>;
  /** Electron-only: resolves host ownership from the live service registry. */
  isLocalService?: (service: string) => Promise<boolean>;
};

export const recoveryCoordinator: RecoveryCoordinator = createRecoveryCoordinator();

function getShellBridge(): vibestudioShellBridge {
  const shell = (globalThis as any).__vibestudioShell as vibestudioShellBridge | undefined;
  if (
    !shell ||
    typeof shell.postEnvelope !== "function" ||
    typeof shell.onEnvelope !== "function"
  ) {
    throw new Error(
      "Vibestudio shell bridge is not available (missing __vibestudioShell.postEnvelope/onEnvelope)"
    );
  }
  return shell;
}

function isRpcEnvelope(value: unknown): value is RpcEnvelope {
  const envelope = value as Partial<RpcEnvelope> | null;
  const message = envelope?.message as { type?: unknown } | undefined;
  return (
    !!envelope &&
    typeof envelope === "object" &&
    typeof envelope.from === "string" &&
    typeof envelope.target === "string" &&
    !!message &&
    typeof message === "object" &&
    typeof message.type === "string"
  );
}

export function createPanelTransport(): EnvelopeRpcTransport {
  const shell = getShellBridge();
  const electronServiceCall =
    typeof shell.serviceCall === "function" ? shell.serviceCall.bind(shell) : undefined;
  const listeners = new Set<(envelope: RpcEnvelope) => void>();

  const deliver = (envelope: RpcEnvelope): void => {
    for (const listener of listeners) listener(envelope);
  };

  shell.onRecovery?.("resubscribe", () => recoveryCoordinator.run("resubscribe"));
  shell.onRecovery?.("cold-recover", () => recoveryCoordinator.run("cold-recover"));

  shell.onEnvelope((envelope) => {
    if (isRpcEnvelope(envelope)) deliver(envelope);
  });

  const transport: EnvelopeRpcTransport = {
    async send(envelope: RpcEnvelope): Promise<void> {
      // Route RPC requests to "main": Electron-local services go via IPC
      // through __vibestudioShell.serviceCall. Everything else rides the shell
      // bridge to the host, which muxes it onto the panel's logical session on
      // the control channel — so userland/workerd services need no static
      // routing edits and no panel-side socket exists.
      if (envelope.target === "main" && envelope.message.type === "request") {
        const request = envelope.message as RpcRequest;
        const dotIdx = request.method.indexOf(".");
        const service = dotIdx > 0 ? request.method.slice(0, dotIdx) : "";

        const routesToElectron =
          typeof shell.isLocalService === "function" && (await shell.isLocalService(service));
        if (routesToElectron) {
          if (!electronServiceCall) {
            // Electron-local service called from a non-Electron context
            // (mobile, headless). Fail fast with a clear message instead
            // of sending to the server where it'd fail with a confusing
            // "Unknown service" error.
            deliver(
              responseEnvelopeFor(
                envelope,
                { callerId: "main", callerKind: "shell" },
                {
                  type: "response",
                  requestId: request.requestId,
                  errorKind: "service",
                  error:
                    `Service '${service}' is an Electron-local service ` +
                    `and requires the Electron desktop app. It is not available ` +
                    `in this context.`,
                }
              )
            );
            return;
          }

          // Dispatch via Electron IPC and deliver a synthetic response
          void (async () => {
            try {
              const result = await electronServiceCall(request.method, ...(request.args ?? []));
              deliver(
                responseEnvelopeFor(
                  envelope,
                  { callerId: "main", callerKind: "shell" },
                  {
                    type: "response",
                    requestId: request.requestId,
                    result,
                  }
                )
              );
            } catch (err) {
              deliver(
                responseEnvelopeFor(
                  envelope,
                  { callerId: "main", callerKind: "shell" },
                  {
                    type: "response",
                    requestId: request.requestId,
                    errorKind: rpcErrorKindOf(err),
                    error: err instanceof Error ? err.message : String(err),
                    ...(rpcErrorDataOf(err) !== undefined
                      ? { errorData: rpcErrorDataOf(err) }
                      : {}),
                  }
                )
              );
            }
          })();
          return;
        }
      }

      await shell.postEnvelope(envelope);
    },

    onMessage(handler: (envelope: RpcEnvelope) => void): () => void {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };

  // First-class streaming rides the host session's native stream when exposed.
  // Otherwise the RPC client falls back to the duplex envelope path above.
  if (typeof shell.stream === "function") {
    const streamFn = shell.stream.bind(shell);
    // Pass `body` through verbatim — a bridge stream() that cannot carry one
    // must throw (§1.6); dropping it here would be a silent-upload-loss bug.
    transport.stream = (envelope, signal, body) => streamFn(envelope, signal ?? null, body ?? null);
  }

  // §1.6 upload hop: when the shell bridge exposes the stream surface
  // (streamOpen/streamBodyChunk/…), streaming REQUEST bodies pump across the
  // bridge as chunk messages and the HOST feeds them to this panel's transport
  // session (see @vibestudio/rpc bridgeStream.ts). The RPC client calls this ONLY
  // for requests WITH a body — body-less streams keep the duplex envelope path
  // byte-identical. Without the surface, a body throws loudly in the client
  // core.
  const streamSurface = bridgeStreamSurfaceOf(shell);
  if (streamSurface) {
    // The bridge's host owns the panel-principal session and its first-class
    // stream plane. Use that plane for body-less subscriptions as well as
    // uploads; plain envelope relays cannot carry the native response stream.
    transport.stream = (envelope, signal, body) =>
      openBridgeStream(streamSurface, envelope, signal ?? null, body ?? null);
    transport.streamBody = (envelope, signal, body) => {
      if (!body) {
        return Promise.reject(
          new Error(
            "panel bridge streamBody() requires a request body — body-less streams ride the duplex envelope path"
          )
        );
      }
      return openBridgeUploadStream(streamSurface, envelope, signal ?? null, body);
    };
  }

  return transport;
}
