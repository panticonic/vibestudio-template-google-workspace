import { vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import {
  AGENTIC_PROTOCOL_VERSION,
  brandId,
  encodeChannelPayloadStoredValues,
  invocationCompletedPayload,
  type AgenticEvent,
  type BlockId,
  type InvocationId,
  type MessageId,
} from "@workspace/agentic-protocol";
import { connectViaRpc, type PubSubClient } from "@workspace/pubsub";
import { GadWorkspaceDO } from "@workspace-workers/workspace-source";
import { PubSubChannel } from "../../../workers/pubsub-channel/channel-do.js";

export const TRANSCRIPT_TEST_CHANNEL_ID = "transcript-pipeline";
export const TRANSCRIPT_TEST_CHANNEL_TARGET = `do:workers/pubsub-channel:PubSubChannel:${TRANSCRIPT_TEST_CHANNEL_ID}`;
export const TRANSCRIPT_TEST_GAD_TARGET =
  "do:workers/workspace-source:GadWorkspaceDO:workspace";

function setRpcCaller(
  instance: PubSubChannel,
  callerId: string | null,
  callerKind: string | null
): void {
  (instance as unknown as { _currentRpcCallerId: string | null })._currentRpcCallerId = callerId;
  (instance as unknown as { _currentRpcCallerKind: string | null })._currentRpcCallerKind =
    callerKind;
}

export async function createTranscriptHarness(channelId = TRANSCRIPT_TEST_CHANNEL_ID) {
  const channelTarget = `do:workers/pubsub-channel:PubSubChannel:${channelId}`;
  const gad = await createTestDO(GadWorkspaceDO, {
    __objectKey: "workspace",
  });
  const channel = await createTestDO(PubSubChannel, { __objectKey: channelId });
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const blobs = new Map<string, string>();
  let blobCounter = 0;
  const putTextBlob = (value: string) => {
    const digest = `test-digest-${++blobCounter}`;
    blobs.set(digest, value);
    return { digest, size: value.length };
  };

  // The DO base now holds a ConnectionlessRpcClient ({ client, respond, deliver })
  // behind the `rpc` getter; pre-setting `_connectionless` short-circuits the
  // real (network) client construction.
  const mockClient = {
    emit: vi.fn(async (target: string, _event: string, payload: unknown) => {
      listeners.get(target)?.({ payload });
    }),
    call: vi.fn(async (target: string, method: string, args: unknown[]) => {
      if (target === "main" && method === "workers.resolveService") {
        return {
          kind: "durable-object",
          source: "vibestudio/internal",
          className: "GadWorkspaceDO",
          objectKey: "workspace",
          targetId: TRANSCRIPT_TEST_GAD_TARGET,
        };
      }
      if (target === "main" && method === "blobstore.putText") {
        const value = String(args[0] ?? "");
        return putTextBlob(value);
      }
      if (target === "main" && method === "blobstore.getText") {
        return blobs.get(String(args[0] ?? "")) ?? null;
      }
      if (target === TRANSCRIPT_TEST_GAD_TARGET) {
        const callable = gad.instance as unknown as Record<
          string,
          (...methodArgs: unknown[]) => unknown
        >;
        return await callable[method]!(...args);
      }
      // Fire-and-forget server housekeeping (alarmSet, setTitle,
      // resolveDurableObject validation) is a no-op in these unit tests.
      if (target === "main") return undefined;
      throw new Error(`unexpected channel rpc call ${target}.${method}`);
    }),
    expose: () => {},
    exposeAll: () => {},
    on: () => () => {},
  };
  (
    channel.instance as unknown as {
      _connectionless: { client: unknown; respond: unknown; deliver: unknown };
    }
  )._connectionless = {
    client: mockClient,
    // Inbound dispatch: `harness.channel.call(...)` reaches the DO via fetch →
    // the method-path adapter calls `respond(envelope)` to invoke the method.
    // Dispatch it straight onto the instance (the converged core's respond would
    // need a real exposeAll/transport; this mock invokes the class method).
    respond: async (envelope: {
      from?: string;
      target?: string;
      message?: { type?: string; requestId?: string; method?: string; args?: unknown[] };
    }) => {
      const msg = envelope.message ?? {};
      if (msg.type !== "request") return null;
      const callable = channel.instance as unknown as Record<string, (...a: unknown[]) => unknown>;
      const result = await callable[msg.method ?? ""]!(...(msg.args ?? []));
      return {
        from: envelope.target,
        target: envelope.from,
        delivery: { caller: { callerId: "main", callerKind: "server" } },
        provenance: [],
        message: { type: "response", requestId: msg.requestId, result },
      };
    },
    deliver: () => {},
  };

  function createParticipantRpc(opts: { id: string; name: string; type: string; handle: string }) {
    const call = vi.fn(async (target: string, method: string, args: unknown[]) => {
      if (target === "main" && method === "workers.resolveService") {
        return { kind: "durable-object", targetId: channelTarget };
      }
      if (target === channelTarget) {
        const participantId = typeof args[0] === "string" ? args[0] : null;
        const participantKind = participantId?.startsWith("panel:")
          ? "panel"
          : participantId?.startsWith("agent:")
            ? "agent"
            : null;
        setRpcCaller(channel.instance, participantId, participantKind);
        const callable = channel.instance as unknown as Record<
          string,
          (...methodArgs: unknown[]) => unknown
        >;
        return await callable[method]!(...args);
      }
      throw new Error(`unexpected client rpc call ${target}.${method}`);
    });

    return {
      selfId: opts.id,
      call,
      stream: vi.fn(
        async (
          target: string,
          method: string,
          args: unknown[],
          options?: { signal?: AbortSignal }
        ) => {
          const response = await call(target, method, args);
          if (!(response instanceof Response)) {
            throw new Error(`streaming client rpc ${target}.${method} did not return a Response`);
          }
          if (!response.body || !options?.signal) return response;

          const reader = response.body.getReader();
          const signal = options.signal;
          let terminal = false;
          let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
          const stop = async (reason?: unknown) => {
            if (terminal) return;
            terminal = true;
            signal.removeEventListener("abort", abort);
            await reader.cancel(reason).catch(() => {});
            try {
              streamController?.close();
            } catch {
              // The consumer already cancelled the response.
            }
          };
          const abort = () => {
            void stop(signal.reason);
          };
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              signal.addEventListener("abort", abort, { once: true });
            },
            async pull(controller) {
              const chunk = await reader.read();
              if (terminal) return;
              if (chunk.done) {
                terminal = true;
                signal.removeEventListener("abort", abort);
                controller.close();
                return;
              }
              controller.enqueue(chunk.value);
            },
            cancel(reason) {
              return stop(reason);
            },
          });
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
      ),
    };
  }

  function connectParticipant(opts: {
    id: string;
    name: string;
    type: string;
    handle: string;
    contextId?: string;
  }): PubSubClient {
    const rpc = createParticipantRpc(opts);
    return connectViaRpc({
      rpc: rpc as never,
      channel: channelId,
      clientId: opts.id,
      name: opts.name,
      type: opts.type,
      handle: opts.handle,
      contextId: opts.contextId ?? "ctx-transcript-pipeline",
    });
  }

  return { gad, channel, channelId, connectParticipant, createParticipantRpc, putTextBlob };
}

export async function appendTrajectoryEventsAndBroadcast(
  harness: Awaited<ReturnType<typeof createTranscriptHarness>>,
  events: AgenticEvent[]
) {
  const result = await harness.gad.call<{
    published: Array<{ channelId: string; envelopeId: string }>;
  }>("appendLogEvent", {
    logId: "trajectory:test",
    head: "branch:test",
    logKind: "trajectory",
    owner: { kind: "agent", id: "agent:onboarding" },
    events: await Promise.all(
      events.map(async (event) => {
        const encoded = (await encodeChannelPayloadStoredValues(
          { ...event, turnId: "turn:test" },
          {
            putText: async (value) => harness.putTextBlob(value),
          }
        )) as AgenticEvent;
        return {
          actor: encoded.actor,
          payloadKind: encoded.kind,
          payload: encoded.payload,
          causality: { ...(encoded.causality ?? {}), turnId: "turn:test" },
          appendedAt: encoded.createdAt,
          publish: { channels: [{ channelId: harness.channelId }] },
        };
      })
    ),
  });
  await harness.channel.call(
    "broadcastStoredEnvelopes",
    result.published.map((publication) => publication.envelopeId)
  );
  return result;
}

export function agenticPublication(event: AgenticEvent) {
  return event;
}

export function assistantMessage(id: string, content: string): AgenticEvent<"message.completed"> {
  return {
    kind: "message.completed",
    actor: { kind: "agent", id: "agent:onboarding", displayName: "Onboarding Agent" },
    causality: { messageId: brandId<MessageId>(id) },
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      role: "assistant",
      blocks: [{ blockId: brandId<BlockId>(`${id}:block:0`), type: "text", content }],
      outcome: "completed",
    },
    createdAt: new Date().toISOString(),
  };
}

export function invocationStarted(
  id: string,
  name: string,
  request: Record<string, unknown>
): AgenticEvent<"invocation.started"> {
  return {
    kind: "invocation.started",
    actor: { kind: "agent", id: "agent:onboarding", displayName: "Onboarding Agent" },
    causality: { invocationId: brandId<InvocationId>(id) },
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      name,
      request,
    },
    createdAt: new Date().toISOString(),
  };
}

export function invocationCompleted(
  id: string,
  result: unknown
): AgenticEvent<"invocation.completed"> {
  return {
    kind: "invocation.completed",
    actor: { kind: "agent", id: "agent:onboarding", displayName: "Onboarding Agent" },
    causality: { invocationId: brandId<InvocationId>(id) },
    payload: invocationCompletedPayload({ result }),
    createdAt: new Date().toISOString(),
  };
}
