/**
 * Tests for the RPC-based PubSub client (connectViaRpc).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CHANNEL_CLOSE_TIMEOUT_MS,
  connectViaRpc,
  resolveRpcChannelTarget,
} from "./rpc-client.js";
import type { PubSubClient } from "./client.js";
import type { IncomingEvent, MethodExecutionContext } from "./protocol-types.js";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  agentToolFailureFromUnknown,
  agenticEventSchema,
  invocationAbandonedPayload,
  invocationCancelledPayload,
  invocationCompletedPayload,
  invocationFailedPayload,
} from "@workspace/agentic-protocol";
import { createRecoveryCoordinator } from "@vibestudio/shell-core/recoveryCoordinator";
import { encodeEventWatchRecord } from "@vibestudio/shared/events";
import { ledgerTest } from "../../../tests/helpers/ledgerTest.js";
import { z } from "zod";

const CHANNEL = "test-channel";
const DO_TARGET = `do:workers/pubsub-channel:PubSubChannel:${CHANNEL}`;
const SELF_ID = "panel:panel-1";

// Valid UUIDs for method callIds (schema requires uuid format)
const CALL_ID_1 = "00000000-0000-4000-8000-000000000001";
const CALL_ID_SLOW = "00000000-0000-4000-8000-000000000002";
const TRANSPORT_ID_1 = "00000000-0000-4000-8000-000000000011";

function invocation(
  kind: string,
  callId: string,
  payload: Record<string, unknown>,
  opts?: { transportCallId?: string; turnId?: string }
) {
  const terminalPayload =
    kind === "invocation.completed"
      ? invocationCompletedPayload()
      : kind === "invocation.failed"
        ? invocationFailedPayload("tool_error", String(payload["reason"] ?? "method failed"), {
            terminalReasonCode: "method_failed",
            failure: agentToolFailureFromUnknown(payload, {
              operation: "channel-method",
              stage: "test",
            }),
          })
        : kind === "invocation.cancelled"
          ? invocationCancelledPayload("cancelled", String(payload["reason"] ?? "cancelled"), {
              terminalReasonCode: "cancelled",
            })
          : kind === "invocation.abandoned"
            ? invocationAbandonedPayload(String(payload["reason"] ?? "abandoned"), {
                terminalReasonCode: "runner_restarted_before_invocation_completed",
              })
            : { protocol: "agentic.trajectory.v1" };
  return {
    kind,
    actor: { kind: "panel", id: "panel:panel-1" },
    ...(opts?.turnId ? { turnId: opts.turnId } : {}),
    causality: {
      invocationId: callId,
      ...(opts?.transportCallId ? { transportCallId: opts.transportCallId } : {}),
    },
    payload: { ...terminalPayload, ...payload },
    createdAt: new Date().toISOString(),
  };
}

function messageEvent(id: string, content: string, actorId = "agent-1") {
  return {
    kind: "message.completed",
    actor: { kind: "agent", id: actorId, displayName: actorId },
    causality: { messageId: id },
    payload: {
      protocol: "agentic.trajectory.v1",
      role: "assistant",
      content,
    },
    createdAt: new Date().toISOString(),
  };
}

interface MockRpc {
  call: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
  selfId: string;
}

/**
 * Creates a mock RPC object. `emit` writes a record onto the active
 * subscription response body, matching the production resource lifetime.
 */
function createMockRpc() {
  const removeListener = vi.fn();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let approvalController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let pendingApprovalIds: string[] = [];
  let approvalSequence = 0;
  const pendingPayloads: unknown[] = [];
  const streamSignals: AbortSignal[] = [];
  const priorSignalStatesAtOpen: boolean[][] = [];
  const encoder = new TextEncoder();

  const rpc: MockRpc = {
    call: vi.fn(async (target: string, method: string) => {
      if (target === "main" && method === "workers.resolveService") {
        return { kind: "durable-object", targetId: DO_TARGET };
      }
      if (target === DO_TARGET && method === "claimMethodCall") {
        return { claimed: true, generation: 1 };
      }
      if (target === DO_TARGET && method === "markMethodCallExecutionStarted") {
        return { accepted: true };
      }
      return undefined;
    }),
    stream: vi.fn(
      async (
        target: string,
        method: string,
        args: unknown[],
        options?: { signal?: AbortSignal }
      ) => {
        if (target === "main" && method === "events.watch") {
          const requested = args[0] as Array<"shell-approval:pending-changed">;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              approvalController = controller;
              controller.enqueue(
                encodeEventWatchRecord({
                  kind: "watching",
                  events: requested,
                  epoch: "test-approval-epoch",
                })
              );
              controller.enqueue(
                encodeEventWatchRecord({
                  kind: "snapshot",
                  event: "shell-approval:pending-changed",
                  payload: {
                    pending: pendingApprovalIds.map((approvalId) => ({ approvalId })),
                  },
                  sequence: approvalSequence,
                })
              );
              options?.signal?.addEventListener(
                "abort",
                () => {
                  if (approvalController === controller) approvalController = null;
                  controller.close();
                },
                { once: true }
              );
            },
            cancel() {
              approvalController = null;
            },
          });
          return new Response(body);
        }
        priorSignalStatesAtOpen.push(streamSignals.map((signal) => signal.aborted));
        if (options?.signal) streamSignals.push(options.signal);
        const result = await rpc.call(target, method, args);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(
              encoder.encode(`${JSON.stringify({ kind: "subscribed", result })}\n`)
            );
            for (const payload of pendingPayloads.splice(0)) {
              controller.enqueue(
                encoder.encode(`${JSON.stringify({ kind: "message", payload })}\n`)
              );
            }
            options?.signal?.addEventListener(
              "abort",
              () => {
                removeListener();
                if (streamController === controller) {
                  streamController = null;
                  controller.close();
                }
              },
              { once: true }
            );
          },
          cancel() {
            streamController = null;
            removeListener();
          },
        });
        return new Response(body);
      }
    ),
    selfId: SELF_ID,
  };

  function writePayload(payload: unknown): void {
    if (!streamController) {
      pendingPayloads.push(payload);
      return;
    }
    streamController.enqueue(encoder.encode(`${JSON.stringify({ kind: "message", payload })}\n`));
  }

  function emit(msg: Record<string, unknown>) {
    if (msg["kind"] === "ready") {
      writePayload({
        channelId: CHANNEL,
        message: {
          kind: "control",
          type: "ready",
          ready: {
            contextId: msg["contextId"],
            channelConfig: msg["channelConfig"],
            totalCount: msg["totalCount"],
            envelopeCount: msg["envelopeCount"],
            firstEnvelopeSeq: msg["firstEnvelopeSeq"],
            hasMoreBefore: msg["hasMoreBefore"],
          },
        },
      });
      return;
    }
    if (msg["stream"] === "log") {
      writePayload({
        channelId: CHANNEL,
        message: {
          kind: "log",
          phase: msg["phase"] === "replay" ? "replay" : "live",
          event: {
            id: msg["id"],
            messageId: `test-${msg["id"]}`,
            type: msg["type"],
            payload: msg["payload"],
            senderId: msg["senderId"],
            ts: msg["ts"],
            senderMetadata: msg["senderMetadata"],
            contentClass: "internal",
            externalKeys: [],
            attachments: msg["attachments"],
          },
        },
      });
      return;
    }
    if (msg["stream"] === "signal") {
      writePayload({
        channelId: CHANNEL,
        message: {
          kind: "signal",
          messageId: msg["messageId"],
          type: msg["type"],
          payload: msg["payload"],
          senderId: msg["senderId"],
          ts: msg["ts"],
        },
      });
      return;
    }
    writePayload({ channelId: CHANNEL, message: msg });
  }

  function setPendingApprovals(approvalIds: string[]): void {
    pendingApprovalIds = approvalIds;
    if (!approvalController) return;
    approvalSequence += 1;
    approvalController.enqueue(
      encodeEventWatchRecord({
        kind: "event",
        event: "shell-approval:pending-changed",
        payload: { pending: approvalIds.map((approvalId) => ({ approvalId })) },
        sequence: approvalSequence,
      })
    );
  }

  function closeSubscription(): void {
    const controller = streamController;
    streamController = null;
    controller?.close();
  }

  return {
    rpc,
    emit,
    setPendingApprovals,
    removeListener,
    streamSignals,
    priorSignalStatesAtOpen,
    closeSubscription,
  };
}

/**
 * Helper: emit a sequence of replay presence joins, then a ready event,
 * with a microtask yield between to let the client process each.
 */
async function emitReplayAndReady(
  emit: (msg: Record<string, unknown>) => void,
  participants: Array<{ id: string; name: string; type: string }>,
  messages: Array<{ id: number; content: string; senderId: string }> = []
) {
  // Emit presence join replay events for each participant
  for (const p of participants) {
    emit({
      stream: "log",
      phase: "replay",
      id: 100 + participants.indexOf(p),
      type: "presence",
      payload: {
        action: "join",
        ref: { kind: p.type, id: p.id, participantId: p.id },
        metadata: { name: p.name, type: p.type },
      },
      senderId: p.id,
      ts: Date.now(),
    });
  }

  // Emit message replay events
  for (const m of messages) {
    emit({
      stream: "log",
      phase: "replay",
      id: m.id,
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: messageEvent(`msg-${m.id}`, m.content, m.senderId),
      senderId: m.senderId,
      ts: Date.now(),
    });
  }

  // Emit ready
  emit({
    kind: "ready",
    contextId: "ctx-123",
    channelConfig: { title: "Test Channel" },
    totalCount: messages.length,
    envelopeCount: messages.length,
    hasMoreBefore: false,
  });
}

describe("connectViaRpc", () => {
  let mockRpc: MockRpc;
  let emit: (msg: Record<string, unknown>) => void;
  let setPendingApprovals: (approvalIds: string[]) => void;
  let removeListener: ReturnType<typeof vi.fn>;
  let streamSignals: AbortSignal[];

  beforeEach(() => {
    const mock = createMockRpc();
    mockRpc = mock.rpc;
    emit = mock.emit;
    setPendingApprovals = mock.setPendingApprovals;
    removeListener = mock.removeListener;
    streamSignals = mock.streamSignals;
  });

  // ── 1. Subscribe + ready flow ──────────────────────────────────────────

  describe("subscribe + ready flow", () => {
    it("opens subscribe as the long-lived channel resource", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await Promise.resolve();
      await Promise.resolve();

      expect(mockRpc.stream).toHaveBeenCalledWith(
        DO_TARGET,
        "subscribe",
        [
          SELF_ID,
          expect.objectContaining({
            replay: true,
            replayMessageLimit: 500,
          }),
          expect.any(String),
        ],
        { signal: expect.any(AbortSignal) }
      );

      await emitReplayAndReady(emit, []);
      await client.ready();
      await client.close();
    });

    it("requires the resident receiver registrar from the owning Durable Object", async () => {
      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        deliveryMode: "resident",
      });

      await expect(client.ready()).rejects.toThrow(
        "Resident channel delivery requires the owning Durable Object registrar"
      );
      expect(mockRpc.stream).not.toHaveBeenCalledWith(
        DO_TARGET,
        "subscribe",
        expect.anything(),
        expect.anything()
      );
      await client.close();
    });

    it("routes finite resident delivery through the injected owner registrar", async () => {
      let joined = false;
      let receiver: ((payload: unknown) => void | Promise<void>) | undefined;
      let releaseHandler: (() => void) | undefined;
      const handlerGate = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      const residentEventHandler = vi.fn(async (event: IncomingEvent) => {
        if (!("payload" in event)) throw new Error("expected a payload-bearing resident event");
        if (residentEventHandler.mock.calls.length === 1) {
          expect(event.payload).toMatchObject({
            payload: { request: { value: "hydrated" } },
          });
          await handlerGate;
        }
      });
      const unregister = vi.fn();
      const rpc = {
        selfId: SELF_ID,
        stream: vi.fn(),
        registerResidentSession: vi.fn(
          (_channelId: string, next: (payload: unknown) => void | Promise<void>) => {
            receiver = next;
            return {
              transport: {
                call: <T = unknown>(target: string, method: string, args: unknown[]) =>
                  rpc.call(target, method, args) as Promise<T>,
              },
              close: unregister,
            };
          }
        ),
        call: vi.fn(async (target: string, method: string, _args?: unknown[]) => {
          if (target === "main" && method === "workers.resolveService") {
            return { kind: "durable-object", targetId: DO_TARGET };
          }
          if (target === DO_TARGET && method === "relationshipState") {
            return { revision: joined ? 1 : 0, active: joined };
          }
          if (target === DO_TARGET && method === "join") {
            joined = true;
            return {
              ok: true,
              participantId: SELF_ID,
              revision: 1,
              envelope: {
                mode: "initial",
                logEvents: [],
                snapshots: [],
                ready: {
                  contextId: "ctx-resident",
                  totalCount: 0,
                  envelopeCount: 0,
                  hasMoreBefore: false,
                },
              },
            };
          }
          if (target === DO_TARGET && method === "leave") return { ok: true };
          if (target === "main" && method === "blobstore.getText") {
            return JSON.stringify({ value: "hydrated" });
          }
          return undefined;
        }),
      };

      const client = connectViaRpc({
        rpc: rpc as any,
        channel: CHANNEL,
        channelTargetId: DO_TARGET,
        deliveryMode: "resident",
        residentEventHandler,
      });
      await client.ready();

      expect(rpc.registerResidentSession).toHaveBeenCalledWith(CHANNEL, expect.any(Function), {
        targetId: DO_TARGET,
      });
      expect(rpc.stream).not.toHaveBeenCalled();
      expect(rpc.call).not.toHaveBeenCalledWith("main", "workers.resolveService", expect.anything());
      expect(receiver).toBeTypeOf("function");
      expect(client.contextId).toBe("ctx-resident");

      let deliverySettled = false;
      const delivery = Promise.resolve(
        receiver!({
          channelId: CHANNEL,
          message: {
            kind: "log",
            phase: "live",
            event: {
              id: 1,
              messageId: "invocation-1",
              type: AGENTIC_EVENT_PAYLOAD_KIND,
              payload: invocation("invocation.started", CALL_ID_1, {
                name: "inspect",
                request: {
                  protocol: "vibestudio.blob-ref.v1",
                  digest: "resident-request",
                  size: 20,
                  encoding: "json",
                  originalBytes: 20,
                },
                transport: { kind: "local", awaiterId: "resident-call" },
              }),
              senderId: "agent-1",
              contentClass: "internal",
              externalKeys: [],
              ts: Date.now(),
            },
          },
        })
      ).then(() => {
        deliverySettled = true;
      });
      await vi.waitFor(() => expect(residentEventHandler).toHaveBeenCalledOnce());
      expect(deliverySettled).toBe(false);
      releaseHandler!();
      await delivery;
      expect(deliverySettled).toBe(true);

      await receiver!({
        channelId: CHANNEL,
        message: {
          kind: "log",
          phase: "live",
          event: {
            id: 3,
            messageId: "message-3",
            type: AGENTIC_EVENT_PAYLOAD_KIND,
            payload: messageEvent("message-3", "mailbox gaps are expected"),
            senderId: "agent-1",
            contentClass: "internal",
            externalKeys: [],
            ts: Date.now(),
          },
        },
      });
      expect(rpc.call.mock.calls.some(([, method]) => method === "getReplayAfter")).toBe(false);

      await client.close();
      expect(unregister).toHaveBeenCalledOnce();
      expect(rpc.call).toHaveBeenCalledWith(DO_TARGET, "leave", [
        { participantId: SELF_ID, revision: 2 },
      ]);
    });

    it("preserves non-recoverable structured RPC errors through the subscription boundary", async () => {
      const errorData = {
        authorityFailure: {
          remediation: {
            review: {
              approvalId: "review-123",
              title: "Welcome — here's what's in your workspace",
            },
          },
        },
      };
      const accessError = Object.assign(
        new Error("[workers.resolveService] Service resolution is not allowed"),
        { errorCode: "EACCES", errorData }
      );
      const rpc = {
        selfId: SELF_ID,
        call: vi.fn(async () => {
          throw accessError;
        }),
        stream: vi.fn(),
      };
      const errors: Error[] = [];
      const client = connectViaRpc({ rpc: rpc as any, channel: CHANNEL });
      client.onError((error) => errors.push(error));

      await expect(client.ready()).rejects.toMatchObject({
        code: "connection",
        errorCode: "EACCES",
        errorData,
      });
      expect(errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ errorCode: "EACCES", errorData })])
      );
      await client.close();
    });

    it("resumes the initial connection from the exact workspace review event", async () => {
      const errorData = {
        authorityFailure: {
          remediation: {
            review: {
              approvalId: "review-123",
              title: "Welcome — here's what's in your workspace",
            },
          },
        },
      };
      const pendingReview = Object.assign(
        new Error("[workers.resolveService] Waiting for you to finish reviewing Welcome"),
        { errorCode: "EREVIEWPENDING", errorData }
      );
      setPendingApprovals(["review-123"]);
      let attempts = 0;
      mockRpc.call.mockImplementation(async (target: string, method: string) => {
        if (target === "main" && method === "workers.resolveService") {
          attempts += 1;
          if (attempts < 2) throw pendingReview;
          return { kind: "durable-object", targetId: DO_TARGET };
        }
        return undefined;
      });
      const errors: Error[] = [];
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      client.onError((error) => errors.push(error));
      let ready = false;
      void client.ready().then(() => {
        ready = true;
      });

      await vi.waitFor(() => expect(attempts).toBe(1));
      expect(ready).toBe(false);
      expect(errors).toEqual([]);
      await vi.waitFor(() =>
        expect(mockRpc.stream).toHaveBeenCalledWith(
          "main",
          "events.watch",
          [["shell-approval:pending-changed"], expect.any(String)],
          { signal: expect.any(AbortSignal), bodyIdleTimeoutMs: null }
        )
      );

      setPendingApprovals([]);
      await vi.waitFor(() => expect(attempts).toBe(2));
      await emitReplayAndReady(emit, []);
      await client.ready();

      expect(ready).toBe(true);
      expect(errors).toEqual([]);
      await client.close();
    });

    it("does not charge workspace review waiting against service resolution", async () => {
      const errorData = {
        authorityFailure: {
          remediation: {
            review: {
              approvalId: "review-123",
              title: "Welcome — here's what's in your workspace",
            },
          },
        },
      };
      const pendingReview = Object.assign(
        new Error("[workers.resolveService] Waiting for you to finish reviewing Welcome"),
        { errorCode: "EREVIEWPENDING", errorData }
      );
      setPendingApprovals(["review-123"]);
      let attempts = 0;
      mockRpc.call.mockImplementation(async (target: string, method: string) => {
        if (target === "main" && method === "workers.resolveService") {
          attempts += 1;
          if (attempts === 1) throw pendingReview;
          return { kind: "durable-object", targetId: DO_TARGET };
        }
        return undefined;
      });

      let settled = false;
      const resolution = resolveRpcChannelTarget({
        rpc: mockRpc as any,
        reviewRpc: mockRpc,
        channel: CHANNEL,
        resolutionTimeoutMs: 10,
      }).finally(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(attempts).toBe(1));
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(settled).toBe(false);

      setPendingApprovals([]);
      await expect(resolution).resolves.toBe(DO_TARGET);
      expect(attempts).toBe(2);
      for (const call of mockRpc.call.mock.calls.filter(
        ([target, method]) => target === "main" && method === "workers.resolveService"
      )) {
        expect(call[3]).toEqual({ timeoutMs: 10 });
      }
    });

    it("advertises Zod methods as provider-valid JSON Schema", async () => {
      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          client_eval: {
            parameters: z.object({
              timeoutMs: z.number().int().positive().optional(),
            }),
            returns: z.object({ success: z.boolean() }),
            execute: vi.fn().mockResolvedValue({ success: true }),
          },
        },
      });
      await Promise.resolve();
      await Promise.resolve();

      const subscribeCall = mockRpc.stream.mock.calls.find((call) => call[1] === "subscribe");
      const metadata = subscribeCall?.[2]?.[1] as
        | {
            methods?: Array<{
              parameters: Record<string, unknown>;
              returns?: Record<string, unknown>;
            }>;
          }
        | undefined;
      const advertisement = metadata?.methods?.[0];

      expect(advertisement?.parameters).not.toHaveProperty("$schema");
      expect(advertisement?.parameters).toMatchObject({
        type: "object",
        properties: {
          timeoutMs: {
            type: "integer",
            exclusiveMinimum: 0,
          },
        },
      });
      expect(advertisement?.returns).not.toHaveProperty("$schema");

      await emitReplayAndReady(emit, []);
      await client.ready();
      await client.close();
    });

    it("rejects malformed explicit method schemas before subscribing", () => {
      expect(() =>
        connectViaRpc({
          rpc: mockRpc as any,
          channel: CHANNEL,
          methods: {
            client_eval: {
              parameters: {
                type: "object",
                properties: {
                  timeoutMs: {
                    type: "integer",
                    exclusiveMinimum: true,
                  },
                },
              },
              execute: vi.fn().mockResolvedValue({ success: true }),
            },
          },
        })
      ).toThrow(
        /Invalid JSON Schema advertised for method "client_eval" parameters:.*exclusiveMinimum.*number/
      );
      expect(mockRpc.stream).not.toHaveBeenCalled();
    });

    it("does not settle cooperative close before self-leave is acknowledged", async () => {
      let acknowledgeLeave: (() => void) | undefined;
      mockRpc.call.mockImplementation(async (target: string, method: string) => {
        if (target === "main" && method === "workers.resolveService") {
          return { kind: "durable-object", targetId: DO_TARGET };
        }
        if (target === DO_TARGET && method === "unsubscribe") {
          await new Promise<void>((resolve) => {
            acknowledgeLeave = resolve;
          });
        }
        return undefined;
      });
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready();

      let settled = false;
      const closing = client.close().then(() => {
        settled = true;
      });
      await vi.waitFor(() => {
        expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "unsubscribe", [
          SELF_ID,
          expect.any(String),
        ], { timeoutMs: CHANNEL_CLOSE_TIMEOUT_MS });
      });
      expect(settled).toBe(false);

      acknowledgeLeave?.();
      await closing;
      expect(settled).toBe(true);
    });

    it("aborts the subscription when cooperative close does not answer", async () => {
      vi.useFakeTimers();
      mockRpc.call.mockImplementation(
        async (
          target: string,
          method: string,
          _args: unknown[],
          options?: { timeoutMs?: number }
        ) => {
          if (target === "main" && method === "workers.resolveService") {
            return { kind: "durable-object", targetId: DO_TARGET };
          }
          if (target === DO_TARGET && method === "unsubscribe") {
            await new Promise<void>((_resolve, reject) => {
              setTimeout(
                () => reject(new Error("cooperative close timed out")),
                options?.timeoutMs
              );
            });
          }
          return undefined;
        }
      );
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready();

      const closing = client.close();
      const rejected = expect(closing).rejects.toThrow("cooperative close timed out");
      await vi.advanceTimersByTimeAsync(CHANNEL_CLOSE_TIMEOUT_MS);

      await rejected;
      expect(streamSignals.at(-1)?.aborted).toBe(true);
    });

    it("does not create a parallel PubSub heartbeat loop", async () => {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      try {
        await emitReplayAndReady(emit, []);
        await client.ready();
        expect(setIntervalSpy).not.toHaveBeenCalled();
        expect(mockRpc.call.mock.calls.some(([, method]) => method === "touch")).toBe(false);
      } finally {
        await client.close();
        setIntervalSpy.mockRestore();
      }
    });

    it("resolves ready() after replay + ready events", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });

      // Emit replay participants and ready
      await emitReplayAndReady(emit, [
        { id: "agent-1", name: "Claude", type: "agent" },
        { id: "panel:panel-1", name: "User", type: "panel" },
      ]);

      await client.ready();

      // Roster should have both participants
      const roster = client.roster;
      expect(roster["agent-1"]).toBeDefined();
      expect(roster["agent-1"]!.metadata).toEqual({ name: "Claude", type: "agent" });
      expect(roster["panel:panel-1"]).toBeDefined();
      expect(roster["panel:panel-1"]!.metadata).toEqual({ name: "User", type: "panel" });

      expect(client.connected).toBe(true);
      expect(client.contextId).toBe("ctx-123");
      expect(client.hasMoreBefore).toBe(false);

      await client.close();
    });

    it("adopts the authoritative human participant id for every post-subscribe operation", async () => {
      mockRpc.call.mockImplementation(async (target: string, method: string) => {
        if (target === "main" && method === "workers.resolveService") {
          return { kind: "durable-object", targetId: DO_TARGET };
        }
        if (target === DO_TARGET && method === "subscribe") {
          return {
            ok: true,
            participantId: "user:usr_alice",
            envelope: {
              mode: "initial",
              logEvents: [],
              snapshots: [
                {
                  kind: "roster-snapshot",
                  participants: [
                    {
                      id: "user:usr_alice",
                      ref: {
                        kind: "user",
                        id: "user:usr_alice",
                        participantId: "user:usr_alice",
                      },
                      metadata: { kind: "user", type: "user" },
                    },
                  ],
                  ts: Date.now(),
                },
              ],
              ready: {
                contextId: "ctx-1",
                totalCount: 0,
                envelopeCount: 0,
                hasMoreBefore: false,
              },
            },
          };
        }
        if (target === DO_TARGET && method === "publish") return { id: 1 };
        return undefined;
      });
      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        clientId: "panel:slot-a",
        name: "Chat panel",
        type: "panel",
      });

      await client.ready();
      expect(client.clientId).toBe("user:usr_alice");
      await client.publish("test", { ok: true });
      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "publish", [
        "user:usr_alice",
        "test",
        { ok: true },
        expect.any(Object),
      ]);

      await client.close();
      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "unsubscribe", [
        "user:usr_alice",
        expect.any(String),
      ], { timeoutMs: CHANNEL_CLOSE_TIMEOUT_MS });
    });

    it("resolves ready() from the subscribe acknowledgment after applying fallback replay", async () => {
      mockRpc.call.mockImplementation(async (target: string, method: string) => {
        if (target === "main" && method === "workers.resolveService") {
          return { kind: "durable-object", targetId: DO_TARGET };
        }
        if (method === "subscribe") {
          return {
            ok: true,
            envelope: {
              mode: "initial",
              logEvents: [
                {
                  id: 101,
                  messageId: "presence-101",
                  type: "presence",
                  payload: {
                    action: "join",
                    ref: { kind: "agent", id: "agent-1", participantId: "agent-1" },
                    metadata: { name: "Claude", type: "agent" },
                  },
                  senderId: "agent-1",
                  ts: Date.now(),
                },
                {
                  id: 201,
                  messageId: "msg-201",
                  type: AGENTIC_EVENT_PAYLOAD_KIND,
                  payload: messageEvent("00000000-0000-4000-8000-000000000201", "from replay"),
                  senderId: "agent-1",
                  contentClass: "internal",
                  externalKeys: [],
                  ts: Date.now(),
                },
              ],
              snapshots: [],
              ready: {
                contextId: "ctx-from-subscribe",
                channelConfig: { title: "Ack Channel" },
                totalCount: 1,
                envelopeCount: 1,
              },
            },
          };
        }
        return undefined;
      });

      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      const events = client.events({ includeReplay: true });
      const readyHandler = vi.fn();
      client.onReady(readyHandler);

      await client.ready();

      expect(client.connected).toBe(true);
      expect(client.contextId).toBe("ctx-from-subscribe");
      expect(client.channelConfig).toEqual({ title: "Ack Channel" });
      expect(client.roster["agent-1"]?.metadata).toEqual({ name: "Claude", type: "agent" });
      expect(readyHandler).toHaveBeenCalledTimes(1);

      let replayed = await events.next();
      while (!replayed.done && replayed.value.type !== AGENTIC_EVENT_PAYLOAD_KIND) {
        replayed = await events.next();
      }
      expect(replayed).toMatchObject({
        value: {
          delivery: "log",
          phase: "replay",
          pubsubId: 201,
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: {
            kind: "message.completed",
            causality: { messageId: "00000000-0000-4000-8000-000000000201" },
          },
        },
      });

      // If the queued event delivery catches up after the ack fallback, replay
      // and ready are deduped rather than surfacing a second boundary.
      emit({
        stream: "log",
        phase: "replay",
        id: 201,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: messageEvent("msg-201", "from replay"),
        senderId: "agent-1",
        ts: Date.now(),
      });
      emit({
        kind: "ready",
        contextId: "ctx-from-subscribe",
        channelConfig: { title: "Ack Channel" },
        totalCount: 1,
        envelopeCount: 1,
      });
      await Promise.resolve();
      expect(readyHandler).toHaveBeenCalledTimes(1);

      await client.close();
    });

    it("does not surface replay events when replayMode is skip", async () => {
      mockRpc.call.mockImplementation(async (target: string, method: string) => {
        if (target === "main" && method === "workers.resolveService") {
          return { kind: "durable-object", targetId: DO_TARGET };
        }
        if (method === "subscribe") {
          return {
            ok: true,
            envelope: {
              mode: "initial",
              logEvents: [
                {
                  id: 201,
                  messageId: "msg-201",
                  type: AGENTIC_EVENT_PAYLOAD_KIND,
                  payload: messageEvent("00000000-0000-4000-8000-000000000201", "from replay"),
                  senderId: "agent-1",
                  ts: Date.now(),
                },
              ],
              snapshots: [
                {
                  kind: "roster-snapshot",
                  participants: [
                    {
                      id: "agent-1",
                      ref: { kind: "agent", id: "agent-1", participantId: "agent-1" },
                      metadata: { name: "Agent", type: "agent" },
                    },
                  ],
                  ts: Date.now(),
                },
              ],
              ready: {
                contextId: "ctx-skip",
                totalCount: 1,
                envelopeCount: 1,
              },
            },
          };
        }
        return undefined;
      });

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        replayMode: "skip",
      });

      await client.ready();

      expect(client.contextId).toBe("ctx-skip");
      expect(client.roster).toEqual({});

      await client.close();
    });

    it("seeds late event subscribers with streamed replay after ready", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      emit({
        stream: "log",
        phase: "replay",
        id: 201,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: messageEvent("00000000-0000-4000-8000-000000000201", "from replay"),
        senderId: "agent-1",
        ts: Date.now(),
      });
      emit({
        kind: "ready",
        contextId: "ctx-from-subscribe",
        totalCount: 1,
        envelopeCount: 1,
      });
      await client.ready();

      const iter = client.events({ includeReplay: true });
      await expect(iter.next()).resolves.toMatchObject({
        value: {
          delivery: "log",
          phase: "replay",
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: {
            kind: "message.completed",
            causality: { messageId: "00000000-0000-4000-8000-000000000201" },
          },
        },
      });

      await client.close();
    });

    it("delivers buffered streamed replay to subscribers that are already listening before ready", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      const iter = client.events({ includeReplay: true });
      const next = iter.next();

      emit({
        stream: "log",
        phase: "replay",
        id: 201,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: messageEvent("00000000-0000-4000-8000-000000000201", "from replay"),
        senderId: "agent-1",
        ts: Date.now(),
      });
      emit({
        kind: "ready",
        contextId: "ctx-from-subscribe",
        totalCount: 1,
        envelopeCount: 1,
      });

      await client.ready();
      await expect(next).resolves.toMatchObject({
        value: {
          delivery: "log",
          phase: "replay",
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: {
            kind: "message.completed",
            causality: { messageId: "00000000-0000-4000-8000-000000000201" },
          },
        },
      });

      await client.close();
    });

    it("does not deliver buffered streamed replay to subscribers that opt out of replay", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      const iter = client.events();
      const next = iter.next();

      emit({
        stream: "log",
        phase: "replay",
        id: 201,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: messageEvent("00000000-0000-4000-8000-000000000201", "from replay"),
        senderId: "agent-1",
        ts: Date.now(),
      });
      emit({
        kind: "ready",
        contextId: "ctx-from-subscribe",
        totalCount: 1,
        envelopeCount: 1,
      });
      await client.ready();

      emit({
        stream: "log",
        phase: "live",
        id: 202,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: messageEvent("00000000-0000-4000-8000-000000000202", "from live"),
        senderId: "agent-1",
        ts: Date.now(),
      });

      await expect(next).resolves.toMatchObject({
        value: {
          delivery: "log",
          phase: "live",
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: {
            kind: "message.completed",
            causality: { messageId: "00000000-0000-4000-8000-000000000202" },
          },
        },
      });

      await client.close();
    });

    it("fires onRoster handlers during replay", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      const rosterUpdates: Array<{ participantId: string; action: string }> = [];
      client.onRoster((update) => {
        if (update.change) {
          rosterUpdates.push({
            participantId: update.change.participantId,
            action: update.change.type,
          });
        }
      });

      await emitReplayAndReady(emit, [{ id: "agent-1", name: "Claude", type: "agent" }]);

      await client.ready();

      expect(rosterUpdates).toContainEqual({ participantId: "agent-1", action: "join" });

      await client.close();
    });
  });

  // ── 2. Publish + receive ───────────────────────────────────────────────

  describe("publish + receive", () => {
    let client: PubSubClient;

    beforeEach(async () => {
      client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready();
      // Clear call history from subscribe
      mockRpc.call.mockClear();
      mockRpc.call.mockResolvedValue({ id: 42 });
    });

    it("publish() calls rpc.call with correct arguments", async () => {
      const pubsubId = await client.publish("custom.event", { id: "m1", content: "hello" });

      expect(pubsubId).toBe(42);
      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "publish", [
        SELF_ID,
        "custom.event",
        { id: "m1", content: "hello" },
        expect.objectContaining({}),
      ]);
    });

    it("send() publishes a typed agentic event envelope payload", async () => {
      const result = await client.send("hello", {
        replyTo: "msg-parent",
        mentions: ["agent:one"],
        metadata: { source: "test" },
        idempotencyKey: "send-1",
      });

      expect(result.pubsubId).toBe(42);
      expect(result.messageId).toMatch(/^[0-9a-f-]{36}$/);
      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "publish", [
        SELF_ID,
        AGENTIC_EVENT_PAYLOAD_KIND,
        expect.objectContaining({
          kind: "message.completed",
        }),
        expect.objectContaining({ idempotencyKey: "send-1" }),
      ]);

      const [, , args] = mockRpc.call.mock.calls[0]!;
      const payload = (args as unknown[])[2];
      const parsed = agenticEventSchema.parse(payload);
      expect(parsed.kind).toBe("message.completed");
      expect(parsed.causality?.messageId).toBe(result.messageId);
      expect(parsed.payload).toMatchObject({
        protocol: "agentic.trajectory.v1",
        role: "user",
        blocks: [expect.objectContaining({ type: "text", content: "hello" })],
        outcome: "completed",
        mentions: ["agent:one"],
        replyTo: "msg-parent",
      });
    });

    it("received envelopes appear in events() iterator", async () => {
      const iter = client.events();

      emit({
        stream: "log",
        phase: "live",
        id: 50,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: messageEvent("00000000-0000-4000-8000-000000000050", "world"),
        senderId: "agent-1",
        ts: Date.now(),
      });

      const first = await iter.next();
      expect(first.done).toBe(false);
      expect(first.value).toMatchObject({
        delivery: "log",
        phase: "live",
        pubsubId: 50,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: {
          kind: "message.completed",
          causality: { messageId: "00000000-0000-4000-8000-000000000050" },
        },
        senderId: "agent-1",
      });

      await client.close();
    });
  });

  // ── 3. Method calls ───────────────────────────────────────────────────

  describe("method execution", () => {
    it("executes registered method and publishes result back", async () => {
      const executeFn = vi.fn().mockResolvedValue({ answer: 42 });

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          compute: {
            description: "compute something",
            parameters: z.object({ x: z.number() }),
            execute: executeFn,
          },
        },
      });

      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (_target: string, method: string) =>
        method === "claimMethodCall"
          ? { claimed: true, generation: 1 }
          : method === "markMethodCallExecutionStarted"
            ? { accepted: true }
            : method === "submitMethodResult"
              ? { id: 301 }
              : undefined
      );

      // Simulate an invocation start arriving from another participant.
      emit({
        stream: "log",
        phase: "live",
        id: 200,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.started",
          CALL_ID_1,
          {
            name: "compute",
            request: { x: 7 },
            transport: {
              kind: "channel",
              channelId: CHANNEL,
              target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
              transportCallId: TRANSPORT_ID_1,
            },
          },
          { transportCallId: TRANSPORT_ID_1, turnId: "turn-1" }
        ),
        senderId: "caller-1",
        ts: Date.now(),
      });

      // Let the async method execution complete
      await vi.waitFor(() => {
        expect(executeFn).toHaveBeenCalled();
      });

      // Wait for the result submit call
      await vi.waitFor(() => {
        const submitCalls = mockRpc.call.mock.calls.filter(
          (c: unknown[]) => c[1] === "submitMethodResult"
        );
        expect(submitCalls.length).toBeGreaterThanOrEqual(1);
      });

      // Find the terminal result submit call.
      const resultCall = mockRpc.call.mock.calls.find(
        (c: unknown[]) => c[1] === "submitMethodResult"
      );
      expect(resultCall).toBeDefined();
      // Args: doTarget, "submitMethodResult", pid, transportCallId, content, isError, opts
      const resultArgs = resultCall![2] as unknown[];
      expect(resultArgs[1]).toBe(TRANSPORT_ID_1);
      expect(resultArgs[2]).toEqual({ answer: 42 });
      expect(resultArgs[3]).toBe(false);
      expect(resultArgs[4]).toMatchObject({
        invocationId: CALL_ID_1,
        turnId: "turn-1",
      });

      await client.close();
    });

    it("waits for fire-and-forget method progress before publishing the terminal result", async () => {
      const executeFn = vi.fn(async (_args, ctx) => {
        void ctx.stream("console line");
        return { done: true };
      });
      let releaseProgress!: () => void;
      const progressSubmitted = new Promise<void>((resolve) => {
        releaseProgress = resolve;
      });

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          compute: {
            description: "compute something",
            parameters: z.object({}),
            execute: executeFn,
          },
        },
      });

      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (_target: string, method: string) => {
        if (method === "claimMethodCall") return { claimed: true, generation: 1 };
        if (method === "markMethodCallExecutionStarted") return { accepted: true };
        if (method === "submitMethodProgress") {
          await progressSubmitted;
        }
        return undefined;
      });

      emit({
        stream: "log",
        phase: "live",
        id: 201,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.started",
          CALL_ID_1,
          {
            name: "compute",
            request: {},
            transport: {
              kind: "channel",
              channelId: CHANNEL,
              target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
              transportCallId: TRANSPORT_ID_1,
            },
          },
          { transportCallId: TRANSPORT_ID_1, turnId: "turn-1" }
        ),
        senderId: "caller-1",
        ts: Date.now(),
      });

      await vi.waitFor(() => {
        expect(mockRpc.call.mock.calls.some((call) => call[1] === "submitMethodProgress")).toBe(
          true
        );
      });
      expect(mockRpc.call.mock.calls.some((call) => call[1] === "submitMethodResult")).toBe(false);

      releaseProgress();
      await vi.waitFor(() => {
        expect(mockRpc.call.mock.calls.some((call) => call[1] === "submitMethodResult")).toBe(true);
      });

      const progressIndex = mockRpc.call.mock.calls.findIndex(
        (call) => call[1] === "submitMethodProgress"
      );
      const resultIndex = mockRpc.call.mock.calls.findIndex(
        (call) => call[1] === "submitMethodResult"
      );
      expect(progressIndex).toBeGreaterThanOrEqual(0);
      expect(resultIndex).toBeGreaterThan(progressIndex);

      await client.close();
    });

    it("dedupes redelivered invocation starts for the same transport call", async () => {
      let resolveWork!: (value: { answer: number }) => void;
      const executeFn = vi.fn(
        () =>
          new Promise<{ answer: number }>((resolve) => {
            resolveWork = resolve;
          })
      );

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          compute: {
            description: "compute something",
            parameters: z.object({}),
            execute: executeFn,
          },
        },
      });

      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (_target: string, method: string) =>
        method === "claimMethodCall"
          ? { claimed: true, generation: 1 }
          : method === "markMethodCallExecutionStarted"
            ? { accepted: true }
            : method === "submitMethodResult"
              ? { id: 302 }
              : undefined
      );

      const emitInvocationStarted = (id: number) => {
        emit({
          stream: "log",
          phase: "live",
          id,
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: invocation(
            "invocation.started",
            CALL_ID_1,
            {
              name: "compute",
              request: {},
              transport: {
                kind: "channel",
                channelId: CHANNEL,
                target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
                transportCallId: TRANSPORT_ID_1,
              },
            },
            { transportCallId: TRANSPORT_ID_1, turnId: "turn-1" }
          ),
          senderId: "caller-1",
          ts: Date.now(),
        });
      };

      emitInvocationStarted(201);
      await vi.waitFor(() => {
        expect(executeFn).toHaveBeenCalledTimes(1);
      });

      emitInvocationStarted(202);
      await Promise.resolve();
      await Promise.resolve();
      expect(executeFn).toHaveBeenCalledTimes(1);
      expect(
        mockRpc.call.mock.calls.filter((c: unknown[]) => c[1] === "claimMethodCall")
      ).toHaveLength(1);

      resolveWork({ answer: 42 });
      await vi.waitFor(() => {
        const submitCalls = mockRpc.call.mock.calls.filter(
          (c: unknown[]) => c[1] === "submitMethodResult"
        );
        expect(submitCalls).toHaveLength(1);
      });

      emitInvocationStarted(203);
      await Promise.resolve();
      await Promise.resolve();
      expect(executeFn).toHaveBeenCalledTimes(1);
      expect(
        mockRpc.call.mock.calls.filter((c: unknown[]) => c[1] === "submitMethodResult")
      ).toHaveLength(1);

      await client.close();
    });

    it("only warns about a redelivery skip once the handler is wedged (proportionate logging)", async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const executeFn = vi.fn(() => new Promise(() => undefined)); // never resolves: stays in-flight
      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          compute: { description: "compute", parameters: z.object({}), execute: executeFn },
        },
      });

      const emitStarted = (id: number) =>
        emit({
          stream: "log",
          phase: "live",
          id,
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: invocation(
            "invocation.started",
            CALL_ID_1,
            {
              name: "compute",
              request: {},
              transport: {
                kind: "channel",
                channelId: CHANNEL,
                target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
                transportCallId: TRANSPORT_ID_1,
              },
            },
            { transportCallId: TRANSPORT_ID_1 }
          ),
          senderId: "caller-1",
          ts: Date.now(),
        });

      try {
        await emitReplayAndReady(emit, []);
        await client.ready();
        warnSpy.mockClear();

        emitStarted(201);
        await vi.waitFor(() => expect(executeFn).toHaveBeenCalledTimes(1));

        const wedgeWarns = () =>
          warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes("still executing"));

        // A redelivery racing a freshly in-flight handler is a benign at-least-once race — skipped
        // (deduped) but NOT logged.
        emitStarted(202);
        await Promise.resolve();
        await Promise.resolve();
        expect(executeFn).toHaveBeenCalledTimes(1);
        expect(wedgeWarns()).toHaveLength(0);

        // Once the handler has been stuck well past the wedge threshold, a redelivery DOES warn.
        await vi.advanceTimersByTimeAsync(31_000);
        emitStarted(203);
        await vi.advanceTimersByTimeAsync(0);
        expect(executeFn).toHaveBeenCalledTimes(1);
        expect(wedgeWarns().length).toBeGreaterThanOrEqual(1);
        expect(String(wedgeWarns()[0]![0])).toMatch(/still executing after \d+s/);
      } finally {
        warnSpy.mockRestore();
        await client.close();
        vi.useRealTimers();
      }
    });

    it("retries a redelivered method call when the terminal submit was not accepted", async () => {
      const executeFn = vi.fn(async () => ({ answer: 42 }));

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          compute: {
            description: "compute something",
            parameters: z.object({}),
            execute: executeFn,
          },
        },
      });

      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (_target: string, method: string) =>
        method === "claimMethodCall"
          ? { claimed: true, generation: 1 }
          : method === "markMethodCallExecutionStarted"
            ? { accepted: true }
            : undefined
      );

      const emitInvocationStarted = (id: number) => {
        emit({
          stream: "log",
          phase: "live",
          id,
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: invocation(
            "invocation.started",
            CALL_ID_1,
            {
              name: "compute",
              request: {},
              transport: {
                kind: "channel",
                channelId: CHANNEL,
                target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
                transportCallId: TRANSPORT_ID_1,
              },
            },
            { transportCallId: TRANSPORT_ID_1, turnId: "turn-1" }
          ),
          senderId: "caller-1",
          ts: Date.now(),
        });
      };

      emitInvocationStarted(211);
      await vi.waitFor(() => {
        expect(
          mockRpc.call.mock.calls.filter((c: unknown[]) => c[1] === "submitMethodResult")
        ).toHaveLength(1);
      });

      emitInvocationStarted(212);
      await vi.waitFor(() => {
        expect(executeFn).toHaveBeenCalledTimes(2);
        expect(
          mockRpc.call.mock.calls.filter((c: unknown[]) => c[1] === "submitMethodResult")
        ).toHaveLength(2);
      });

      await client.close();
    });

    it("hydrates stored-value method arguments before validation", async () => {
      const executeFn = vi.fn().mockResolvedValue({ ok: true });
      const request = { x: 7 };
      const encodedRequest = JSON.stringify(request);

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          compute: {
            description: "compute something",
            parameters: z.object({ x: z.number() }).strict(),
            execute: executeFn,
          },
        },
      });

      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (target: string, method: string) => {
        if (method === "claimMethodCall") return { claimed: true, generation: 1 };
        if (method === "markMethodCallExecutionStarted") return { accepted: true };
        if (target === "main" && method === "blobstore.getText") return encodedRequest;
        return undefined;
      });

      emit({
        stream: "log",
        phase: "live",
        id: 201,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.started",
          CALL_ID_1,
          {
            name: "compute",
            request: {
              protocol: "vibestudio.blob-ref.v1",
              digest: "abc123",
              size: encodedRequest.length,
              encoding: "json",
              originalBytes: encodedRequest.length,
            },
            transport: {
              kind: "channel",
              channelId: CHANNEL,
              target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
              transportCallId: TRANSPORT_ID_1,
            },
          },
          { transportCallId: TRANSPORT_ID_1 }
        ),
        senderId: "caller-1",
        ts: Date.now(),
      });

      await vi.waitFor(() => {
        expect(executeFn).toHaveBeenCalledWith(
          request,
          expect.objectContaining({ callId: TRANSPORT_ID_1 })
        );
      });

      await client.close();
    });

    it("coalesces concurrent reads of the same immutable stored value", async () => {
      const executeFn = vi.fn().mockResolvedValue({ ok: true });
      const stored = JSON.stringify({ x: 7 });
      let releaseRead: ((value: string) => void) | undefined;

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          compute: {
            description: "compute something",
            parameters: z
              .object({
                left: z.object({ x: z.number() }),
                right: z.object({ x: z.number() }),
              })
              .strict(),
            execute: executeFn,
          },
        },
      });

      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (target: string, method: string) => {
        if (method === "claimMethodCall") return { claimed: true, generation: 1 };
        if (method === "markMethodCallExecutionStarted") return { accepted: true };
        if (target === "main" && method === "blobstore.getText") {
          return await new Promise<string>((resolve) => {
            releaseRead = resolve;
          });
        }
        return undefined;
      });

      const ref = {
        protocol: "vibestudio.blob-ref.v1",
        digest: "shared-digest",
        size: stored.length,
        encoding: "json",
        originalBytes: stored.length,
      };
      emit({
        stream: "log",
        phase: "live",
        id: 202,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.started",
          CALL_ID_1,
          {
            name: "compute",
            request: { left: ref, right: ref },
            transport: {
              kind: "channel",
              channelId: CHANNEL,
              target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
              transportCallId: TRANSPORT_ID_1,
            },
          },
          { transportCallId: TRANSPORT_ID_1 }
        ),
        senderId: "caller-1",
        ts: Date.now(),
      });

      await vi.waitFor(() => {
        expect(
          mockRpc.call.mock.calls.filter(
            (call: unknown[]) => call[0] === "main" && call[1] === "blobstore.getText"
          )
        ).toHaveLength(1);
      });
      releaseRead?.(stored);
      await vi.waitFor(() => {
        expect(executeFn).toHaveBeenCalledWith(
          { left: { x: 7 }, right: { x: 7 } },
          expect.objectContaining({ callId: TRANSPORT_ID_1 })
        );
      });

      await client.close();
    });

    it("does not time out method execution without a journaled deadline", async () => {
      vi.useFakeTimers();
      const executeFn = vi.fn(() => new Promise(() => undefined));
      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          feedback_form: {
            description: "waits for user input",
            parameters: z.any(),
            execute: executeFn,
          },
        },
      });

      try {
        await emitReplayAndReady(emit, []);
        await client.ready();
        mockRpc.call.mockClear();

        emit({
          stream: "log",
          phase: "live",
          id: 202,
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: invocation(
            "invocation.started",
            CALL_ID_1,
            {
              name: "feedback_form",
              request: { prompt: "Continue?" },
              transport: {
                kind: "channel",
                channelId: CHANNEL,
                target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
                transportCallId: TRANSPORT_ID_1,
              },
            },
            { transportCallId: TRANSPORT_ID_1 }
          ),
          senderId: "caller-1",
          ts: Date.now(),
        });

        await vi.waitFor(() => {
          expect(executeFn).toHaveBeenCalledTimes(1);
        });

        await vi.advanceTimersByTimeAsync(130_000);
        await Promise.resolve();

        expect(
          mockRpc.call.mock.calls.filter((c: unknown[]) => c[1] === "submitMethodResult")
        ).toHaveLength(0);
      } finally {
        await client.close();
        vi.useRealTimers();
      }
    });

    it("honors an explicit journaled method deadline", async () => {
      vi.useFakeTimers();
      const executeFn = vi.fn(() => new Promise(() => undefined));
      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          slowWork: {
            description: "waits",
            parameters: z.object({}).strict(),
            execute: executeFn,
          },
        },
      });

      try {
        await emitReplayAndReady(emit, []);
        await client.ready();
        mockRpc.call.mockClear();
        const deadlineAt = Date.now() + 5_000;

        emit({
          stream: "log",
          phase: "live",
          id: 203,
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: invocation(
            "invocation.started",
            CALL_ID_SLOW,
            {
              name: "slowWork",
              request: {},
              transport: {
                kind: "channel",
                channelId: CHANNEL,
                target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
                transportCallId: TRANSPORT_ID_1,
                deadlineAt,
              },
            },
            { transportCallId: TRANSPORT_ID_1 }
          ),
          senderId: "caller-1",
          ts: Date.now(),
        });

        await vi.waitFor(() => {
          expect(executeFn).toHaveBeenCalledTimes(1);
        });

        await vi.advanceTimersByTimeAsync(5_000);

        await vi.waitFor(() => {
          expect(
            mockRpc.call.mock.calls.filter((c: unknown[]) => c[1] === "submitMethodResult")
          ).toHaveLength(1);
        });
        expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "submitMethodResult", [
          SELF_ID,
          TRANSPORT_ID_1,
          `Method "slowWork" reached its journaled deadline`,
          true,
          expect.objectContaining({ terminalReasonCode: "method_execution_timeout" }),
        ]);
      } finally {
        await client.close();
        vi.useRealTimers();
      }
    });

    it("hydrates stored-value method results before resolving callers", async () => {
      const result = { answer: 42 };
      const encodedResult = JSON.stringify(result);

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
      });

      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (target: string, method: string) => {
        if (target === "main" && method === "blobstore.getText") return encodedResult;
        return undefined;
      });

      const handle = client.callMethod("provider-1", "compute", {});
      await Promise.resolve();

      emit({
        stream: "log",
        phase: "live",
        id: 401,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.completed",
          handle.invocationId,
          {
            result: {
              protocol: "vibestudio.blob-ref.v1",
              digest: "def456",
              size: encodedResult.length,
              encoding: "json",
              originalBytes: encodedResult.length,
            },
          },
          { transportCallId: handle.transportCallId }
        ),
        senderId: "provider-1",
        ts: Date.now(),
      });

      await expect(handle.result).resolves.toEqual({ content: result });

      await client.close();
    });

    it("applies method progress and terminal chunks in receive order", async () => {
      const progress = { partial: "first" };
      const encodedProgress = JSON.stringify(progress);
      let releaseHydration: ((value: string) => void) | undefined;

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
      });

      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (target: string, method: string) => {
        if (target === "main" && method === "blobstore.getText") {
          return await new Promise<string>((resolve) => {
            releaseHydration = resolve;
          });
        }
        return undefined;
      });

      const handle = client.callMethod("provider-1", "compute", {});
      const chunks: unknown[] = [];
      const streamDone = (async () => {
        for await (const chunk of handle.stream) {
          chunks.push(chunk.content);
        }
      })();
      const resultSettled = vi.fn();
      void handle.result.then(resultSettled);
      await Promise.resolve();

      emit({
        stream: "log",
        phase: "live",
        id: 411,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.output",
          handle.invocationId,
          {
            output: {
              protocol: "vibestudio.blob-ref.v1",
              digest: "progress",
              size: encodedProgress.length,
              encoding: "json",
              originalBytes: encodedProgress.length,
            },
          },
          { transportCallId: handle.transportCallId }
        ),
        senderId: "provider-1",
        ts: Date.now(),
      });
      emit({
        stream: "log",
        phase: "live",
        id: 412,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.completed",
          handle.invocationId,
          { result: { done: true } },
          { transportCallId: handle.transportCallId }
        ),
        senderId: "provider-1",
        ts: Date.now(),
      });

      await Promise.resolve();
      await vi.waitFor(() => {
        expect(releaseHydration).toBeDefined();
      });
      expect(resultSettled).not.toHaveBeenCalled();

      releaseHydration!(encodedProgress);
      await expect(handle.result).resolves.toEqual({ content: { done: true } });
      await streamDone;
      expect(chunks).toEqual([progress, { done: true }]);

      await client.close();
    });

    ledgerTest("channel.reconnect.authority-neutral", async () => {
      let recover!: () => Promise<void>;
      const registerResubscribeHandler = vi.fn((_id: string, handler: () => Promise<void>) => {
        recover = handler;
        return vi.fn();
      });
      const registerColdRecoverHandler = vi.fn(() => vi.fn());
      // The resubscribe replay carries the missed terminal as a durable
      // invocation.completed log event (no getSettledResult read-back).
      let pendingCallId: string | undefined;
      mockRpc.call.mockImplementation(async (target: string, method: string) => {
        if (target === "main" && method === "workers.resolveService") {
          return { kind: "durable-object", targetId: DO_TARGET };
        }
        if (method === "subscribe") {
          return {
            ok: true,
            envelope: {
              mode: "after",
              logEvents: pendingCallId
                ? [
                    {
                      id: 501,
                      messageId: "invocation-501",
                      type: AGENTIC_EVENT_PAYLOAD_KIND,
                      payload: invocation(
                        "invocation.completed",
                        pendingCallId,
                        { result: { answer: 42 } },
                        { transportCallId: pendingCallId }
                      ),
                      senderId: "provider-1",
                      contentClass: "internal",
                      externalKeys: [],
                      ts: Date.now(),
                    },
                  ]
                : [],
              snapshots: [],
              ready: {
                contextId: "ctx-recovered",
                totalCount: 0,
                envelopeCount: 0,
              },
            },
          };
        }
        return undefined;
      });

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        recoveryCoordinator: { registerResubscribeHandler, registerColdRecoverHandler },
      });
      await client.ready();
      mockRpc.call.mockClear();

      const handle = client.callMethod("provider-1", "compute", {});
      pendingCallId = handle.transportCallId;
      await recover();

      await expect(handle.result).resolves.toEqual({ content: { answer: 42 } });
      expect(mockRpc.stream).toHaveBeenCalledTimes(2);
      expect(removeListener).toHaveBeenCalledTimes(1);
      expect(mockRpc.call.mock.calls.some((call) => call[1] === "unsubscribe")).toBe(false);
      expect(mockRpc.call.mock.calls.some((call) => call[1] === "getSettledResult")).toBe(false);

      await client.close();
    });

    it("does not replace its initial subscription for an already-completed transport generation", async () => {
      const coordinator = createRecoveryCoordinator();
      await coordinator.run("resubscribe");
      const mock = createMockRpc();
      const client = connectViaRpc({
        rpc: mock.rpc as any,
        channel: CHANNEL,
        recoveryCoordinator: coordinator,
      });

      await emitReplayAndReady(mock.emit, []);
      await client.ready();
      await Promise.resolve();
      await Promise.resolve();

      expect(mock.rpc.stream).toHaveBeenCalledTimes(1);
      await client.close();
    });

    it("keeps the previous subscription alive until a future-generation replacement is acknowledged", async () => {
      const coordinator = createRecoveryCoordinator();
      const mock = createMockRpc();
      const client = connectViaRpc({
        rpc: mock.rpc as any,
        channel: CHANNEL,
        recoveryCoordinator: coordinator,
      });

      await emitReplayAndReady(mock.emit, []);
      await client.ready();
      const firstSignal = mock.streamSignals[0]!;
      expect(firstSignal.aborted).toBe(false);

      await coordinator.run("resubscribe");

      expect(mock.rpc.stream).toHaveBeenCalledTimes(2);
      expect(mock.priorSignalStatesAtOpen[1]).toEqual([false]);
      expect(firstSignal.aborted).toBe(true);
      await client.close();
    });

    it("never regresses the durable replay cursor when an overlapping reader replays an older event", async () => {
      const coordinator = createRecoveryCoordinator();
      const mock = createMockRpc();
      const client = connectViaRpc({
        rpc: mock.rpc as any,
        channel: CHANNEL,
        recoveryCoordinator: coordinator,
      });

      await emitReplayAndReady(mock.emit, []);
      await client.ready();
      const events = client.events({ includeReplay: true });
      mock.emit({
        stream: "log",
        phase: "live",
        id: 200,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: messageEvent("newer", "newer"),
        senderId: "agent-1",
        ts: Date.now(),
      });
      mock.emit({
        stream: "log",
        phase: "replay",
        id: 150,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: messageEvent("older", "older"),
        senderId: "agent-1",
        ts: Date.now(),
      });
      await events.next();
      await events.next();

      await coordinator.run("resubscribe");
      const metadata = mock.rpc.stream.mock.calls[1]?.[2]?.[1] as { sinceId?: number };
      expect(metadata.sinceId).toBe(200);
      await client.close();
    });

    it("recovers a terminated channel resource while the host transport remains connected", async () => {
      const coordinator = createRecoveryCoordinator();
      const mock = createMockRpc();
      const client = connectViaRpc({
        rpc: mock.rpc as any,
        channel: CHANNEL,
        recoveryCoordinator: coordinator,
      });

      await emitReplayAndReady(mock.emit, []);
      await client.ready();
      mock.closeSubscription();

      await vi.waitFor(() => expect(mock.rpc.stream).toHaveBeenCalledTimes(2));
      expect(mock.priorSignalStatesAtOpen[1]).toEqual([false]);
      await client.close();
    });

    it("keeps ready pending across a transient first-subscription failure and resolves on recovery", async () => {
      const coordinator = createRecoveryCoordinator();
      const mock = createMockRpc();
      mock.rpc.stream.mockRejectedValueOnce(new Error("first subscription transport failed"));
      const client = connectViaRpc({
        rpc: mock.rpc as any,
        channel: CHANNEL,
        recoveryCoordinator: coordinator,
      });
      const ready = client.ready();

      await vi.waitFor(() => expect(mock.rpc.stream).toHaveBeenCalledTimes(2));
      mock.emit({
        kind: "ready",
        contextId: "ctx-recovered-first-connect",
        totalCount: 0,
        envelopeCount: 0,
      });

      await expect(ready).resolves.toBeUndefined();
      await client.close();
    });

    it("redrives a replacement that terminates during its ACK instead of losing the request behind recovering", async () => {
      const coordinator = createRecoveryCoordinator();
      const mock = createMockRpc();
      const defaultStream = mock.rpc.stream.getMockImplementation()!;
      let streamAttempt = 0;
      mock.rpc.stream.mockImplementation(async (...args: Parameters<typeof defaultStream>) => {
        streamAttempt += 1;
        if (streamAttempt !== 2) return defaultStream(...args);
        const result = await mock.rpc.call(args[0], args[1], args[2]);
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(`${JSON.stringify({ kind: "subscribed", result })}\n`)
              );
              controller.enqueue(encoder.encode("not-json\n"));
              controller.close();
            },
          })
        );
      });
      const client = connectViaRpc({
        rpc: mock.rpc as any,
        channel: CHANNEL,
        recoveryCoordinator: coordinator,
      });
      await emitReplayAndReady(mock.emit, []);
      await client.ready();

      await coordinator.run("resubscribe");
      await vi.waitFor(() => expect(mock.rpc.stream).toHaveBeenCalledTimes(3));

      await client.close();
    });
  });

  describe("channel membership, invitations, and presence", () => {
    it("unwraps the typed channel management responses", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await Promise.resolve();
      await Promise.resolve();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (_target: string, method: string) => {
        if (method === "addMember") {
          return {
            userId: "usr_bob",
            memberId: "user:usr_bob",
            handle: "bob",
            addedBy: "user:usr_alice",
            addedAt: 1,
            alreadyMember: false,
          };
        }
        if (method === "removeMember") return { removed: true };
        if (method === "listMembers") return { members: [] };
        if (method === "listInvitesForMe") {
          return {
            invites: [
              {
                channelId: CHANNEL,
                userId: "usr_bob",
                memberId: "user:usr_bob",
                handle: "bob",
                addedBy: "user:usr_alice",
                addedAt: 1,
              },
            ],
          };
        }
        if (method === "acknowledgeInvite") return { acknowledged: true };
        if (method === "getChannelPresence") {
          return { entries: [], generatedAt: 2 };
        }
        return undefined;
      });

      await expect(client.addMember("usr_bob")).resolves.toMatchObject({
        memberId: "user:usr_bob",
        alreadyMember: false,
      });
      await expect(client.removeMember("usr_bob")).resolves.toEqual({ removed: true });
      await expect(client.listMembers()).resolves.toEqual([]);
      await expect(client.listInvitesForMe()).resolves.toMatchObject([
        { channelId: CHANNEL, userId: "usr_bob" },
      ]);
      await expect(client.acknowledgeInvite()).resolves.toBe(true);
      await expect(client.getChannelPresence()).resolves.toEqual({ entries: [], generatedAt: 2 });

      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "addMember", [{ userId: "usr_bob" }]);
      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "removeMember", [{ userId: "usr_bob" }]);
      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "listInvitesForMe", []);
      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "acknowledgeInvite", []);
      await client.close();
    });
  });

  // ── 4. Close ──────────────────────────────────────────────────────────

  describe("close", () => {
    it("leaves the subscription resource and fires disconnect handlers", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (_target: string, method: string) =>
        method === "claimMethodCall"
          ? { claimed: true, generation: 1 }
          : method === "markMethodCallExecutionStarted"
            ? { accepted: true }
            : undefined
      );

      const disconnectFn = vi.fn();
      client.onDisconnect(disconnectFn);

      await client.close();

      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "unsubscribe", [
        SELF_ID,
        expect.any(String),
      ], { timeoutMs: CHANNEL_CLOSE_TIMEOUT_MS });

      // Verify disconnect handler fired
      expect(disconnectFn).toHaveBeenCalledTimes(1);

      // The response stream reached its terminal cancellation.
      expect(removeListener).toHaveBeenCalled();

      // Verify connected is false
      expect(client.connected).toBe(false);
    });
  });

  // ── 5. Method cancel propagation ──────────────────────────────────────

  describe("method cancel propagation", () => {
    it("does not publish a method call when the caller signal is already aborted", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();

      const controller = new AbortController();
      controller.abort();

      const handle = client.callMethod("provider-1", "slowWork", {}, { signal: controller.signal });

      await expect(handle.result).rejects.toMatchObject({ code: "cancelled" });
      expect(mockRpc.call).not.toHaveBeenCalled();

      await client.close();
    });

    it("cancels an in-flight method call when the caller signal aborts", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (_target: string, method: string) =>
        method === "claimMethodCall"
          ? { claimed: true, generation: 1 }
          : method === "markMethodCallExecutionStarted"
            ? { accepted: true }
            : undefined
      );

      const controller = new AbortController();
      const handle = client.callMethod("provider-1", "slowWork", {}, { signal: controller.signal });
      await Promise.resolve();
      await Promise.resolve();

      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "callMethod", [
        SELF_ID,
        "provider-1",
        handle.callId,
        "slowWork",
        {},
        {
          invocationId: handle.invocationId,
          transportCallId: handle.transportCallId,
        },
      ]);

      controller.abort();

      await expect(handle.result).rejects.toMatchObject({ code: "cancelled" });
      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "cancelMethodCall", [
        SELF_ID,
        handle.callId,
      ]);

      await client.close();
    });

    it("awaits cancelMethodCall for explicit cancellation", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();

      let resolveCancel!: () => void;
      mockRpc.call.mockImplementation((_target: string, method: string) => {
        if (method === "cancelMethodCall") {
          return new Promise<void>((resolve) => {
            resolveCancel = resolve;
          });
        }
        return Promise.resolve(undefined);
      });

      const handle = client.callMethod("provider-1", "slowWork", {});
      void handle.result.catch(() => {});

      const cancelPromise = handle.cancel();
      let settled = false;
      void cancelPromise.then(() => {
        settled = true;
      });

      await Promise.resolve();
      expect(settled).toBe(false);
      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "cancelMethodCall", [
        SELF_ID,
        handle.callId,
      ]);

      resolveCancel();
      await cancelPromise;
      expect(settled).toBe(true);

      await client.close();
    });

    it("keeps pause calls on normal method transport until the provider result arrives", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (_target: string, method: string) =>
        method === "claimMethodCall"
          ? { claimed: true, generation: 1 }
          : method === "markMethodCallExecutionStarted"
            ? { accepted: true }
            : undefined
      );

      const handle = client.callMethod("agent-1", "pause", {
        reason: "User interrupted execution",
      });

      await Promise.resolve();
      expect(handle.complete).toBe(false);
      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "callMethod", [
        SELF_ID,
        "agent-1",
        handle.callId,
        "pause",
        { reason: "User interrupted execution" },
        {
          invocationId: handle.invocationId,
          transportCallId: handle.transportCallId,
        },
      ]);

      emit({
        stream: "log",
        phase: "live",
        id: 320,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.completed",
          handle.invocationId,
          { result: { paused: true } },
          { transportCallId: handle.transportCallId }
        ),
        senderId: "agent-1",
        ts: Date.now(),
      });

      await expect(handle.result).resolves.toEqual({ content: { paused: true } });
      expect(handle.complete).toBe(true);

      await client.close();
    });

    it("re-drives ambiguous method-start acknowledgements with the exact same identity", async () => {
      vi.useFakeTimers();
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      try {
        await emitReplayAndReady(emit, []);
        await client.ready();
        mockRpc.call.mockClear();

        let attempts = 0;
        mockRpc.call.mockImplementation(async (_target: string, method: string) => {
          if (method === "callMethod" && attempts++ < 2) {
            throw Object.assign(new Error("response lost after dispatch"), {
              errorKind: "internal",
            });
          }
          return undefined;
        });

        const handle = client.callMethod("agent-1", "pause", { reason: "test" });
        await Promise.resolve();
        expect(attempts).toBe(1);

        await vi.advanceTimersByTimeAsync(100);
        expect(attempts).toBe(2);
        await vi.advanceTimersByTimeAsync(200);
        expect(attempts).toBe(3);

        const starts = mockRpc.call.mock.calls.filter((call) => call[1] === "callMethod");
        expect(starts).toHaveLength(3);
        expect(starts[1]).toEqual(starts[0]);
        expect(starts[2]).toEqual(starts[0]);
        expect(handle.complete).toBe(false);

        emit({
          stream: "log",
          phase: "live",
          id: 601,
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: invocation(
            "invocation.completed",
            handle.invocationId,
            { result: { paused: true } },
            { transportCallId: handle.transportCallId }
          ),
          senderId: "agent-1",
          ts: Date.now(),
        });

        await expect(handle.result).resolves.toEqual({ content: { paused: true } });
      } finally {
        await client.close();
        vi.useRealTimers();
      }
    });

    it("accepts a durable terminal after an ambiguous start ACK without waiting for redrive", async () => {
      vi.useFakeTimers();
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      try {
        await emitReplayAndReady(emit, []);
        await client.ready();
        mockRpc.call.mockClear();

        let attempts = 0;
        mockRpc.call.mockImplementation(async (_target: string, method: string) => {
          if (method === "callMethod") {
            attempts += 1;
            throw Object.assign(new Error("acknowledgement lost"), { errorKind: "internal" });
          }
          return undefined;
        });

        const handle = client.callMethod("agent-1", "pause", {});
        await Promise.resolve();
        expect(attempts).toBe(1);
        expect(handle.complete).toBe(false);

        emit({
          stream: "log",
          phase: "live",
          id: 602,
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: invocation(
            "invocation.completed",
            handle.invocationId,
            { result: { paused: true } },
            { transportCallId: handle.transportCallId }
          ),
          senderId: "agent-1",
          ts: Date.now(),
        });

        await expect(handle.result).resolves.toEqual({ content: { paused: true } });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(attempts).toBe(1);
      } finally {
        await client.close();
        vi.useRealTimers();
      }
    });

    it("rejects a method start that the channel definitively refuses", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();

      const refusal = Object.assign(new Error("caller is not authorized"), {
        errorKind: "access",
      });
      mockRpc.call.mockRejectedValue(refusal);

      const handle = client.callMethod("agent-1", "pause", {});
      await expect(handle.result).rejects.toMatchObject({
        code: "connection-error",
        cause: refusal,
      });
      expect(mockRpc.call.mock.calls.filter((call) => call[1] === "callMethod")).toHaveLength(1);

      mockRpc.call.mockResolvedValue(undefined);
      await client.close();
    });

    it("aborts the executing method when invocation.cancelled arrives", async () => {
      let capturedSignal: AbortSignal | null = null;

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          slowWork: {
            description: "slow operation",
            parameters: z.object({}),
            execute: async (_args: unknown, ctx: MethodExecutionContext) => {
              capturedSignal = ctx.signal;
              // Wait until aborted
              await new Promise<void>((resolve) => {
                if (ctx.signal.aborted) {
                  resolve();
                  return;
                }
                ctx.signal.addEventListener("abort", () => resolve());
              });
              return { cancelled: true };
            },
          },
        },
      });

      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (_target: string, method: string) =>
        method === "claimMethodCall"
          ? { claimed: true, generation: 1 }
          : method === "markMethodCallExecutionStarted"
            ? { accepted: true }
            : undefined
      );

      // Trigger the method call
      emit({
        stream: "log",
        phase: "live",
        id: 300,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation("invocation.started", CALL_ID_SLOW, {
          name: "slowWork",
          request: {},
          transport: {
            kind: "channel",
            channelId: CHANNEL,
            target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
          },
        }),
        senderId: "caller-1",
        ts: Date.now(),
      });

      // Wait for the method to start executing
      await vi.waitFor(() => {
        expect(capturedSignal).not.toBeNull();
      });

      expect(capturedSignal!.aborted).toBe(false);

      // invocation.cancelled is now the provider-abort signal (no method-cancel).
      emit({
        stream: "log",
        phase: "live",
        id: 301,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation("invocation.cancelled", CALL_ID_SLOW, { reason: "cancelled" }),
        senderId: "caller-1",
        ts: Date.now(),
      });

      await vi.waitFor(() => expect(capturedSignal!.aborted).toBe(true));

      await client.close();
    });

    it("never starts a provider method when cancellation wins during claim admission", async () => {
      let resolveClaim!: (value: { claimed: boolean; generation: number }) => void;
      const claim = new Promise<{ claimed: boolean; generation: number }>((resolve) => {
        resolveClaim = resolve;
      });
      const execute = vi.fn(async () => ({ shouldNotRun: true }));
      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          sideEffect: {
            description: "side-effectful operation",
            parameters: z.object({}),
            execute,
          },
        },
      });

      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (_target: string, method: string) => {
        if (method === "claimMethodCall") return claim;
        return undefined;
      });

      emit({
        stream: "log",
        phase: "live",
        id: 350,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.started",
          CALL_ID_SLOW,
          {
            name: "sideEffect",
            request: {},
            transport: {
              kind: "channel",
              channelId: CHANNEL,
              target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
              transportCallId: TRANSPORT_ID_1,
            },
          },
          { transportCallId: TRANSPORT_ID_1 }
        ),
        senderId: "caller-1",
        ts: Date.now(),
      });
      await vi.waitFor(() =>
        expect(mockRpc.call.mock.calls.some((call) => call[1] === "claimMethodCall")).toBe(true)
      );

      emit({
        stream: "log",
        phase: "live",
        id: 351,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.cancelled",
          CALL_ID_SLOW,
          { reason: "cancelled" },
          { transportCallId: TRANSPORT_ID_1 }
        ),
        senderId: "caller-1",
        ts: Date.now(),
      });
      resolveClaim({ claimed: true, generation: 1 });
      await Promise.resolve();
      await Promise.resolve();

      expect(execute).not.toHaveBeenCalled();
      await client.close();
    });

    it("never starts a provider method when cancellation wins during execution-start admission", async () => {
      let resolveExecutionStart!: (value: { accepted: boolean }) => void;
      const executionStart = new Promise<{ accepted: boolean }>((resolve) => {
        resolveExecutionStart = resolve;
      });
      const execute = vi.fn(async () => ({ shouldNotRun: true }));
      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          sideEffect: {
            description: "side-effectful operation",
            parameters: z.object({}),
            execute,
          },
        },
      });

      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (_target: string, method: string) => {
        if (method === "claimMethodCall") return { claimed: true, generation: 1 };
        if (method === "markMethodCallExecutionStarted") return executionStart;
        return undefined;
      });

      emit({
        stream: "log",
        phase: "live",
        id: 360,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.started",
          CALL_ID_SLOW,
          {
            name: "sideEffect",
            request: {},
            transport: {
              kind: "channel",
              channelId: CHANNEL,
              target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
              transportCallId: TRANSPORT_ID_1,
            },
          },
          { transportCallId: TRANSPORT_ID_1 }
        ),
        senderId: "caller-1",
        ts: Date.now(),
      });
      await vi.waitFor(() =>
        expect(
          mockRpc.call.mock.calls.some((call) => call[1] === "markMethodCallExecutionStarted")
        ).toBe(true)
      );

      emit({
        stream: "log",
        phase: "live",
        id: 361,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.cancelled",
          CALL_ID_SLOW,
          { reason: "cancelled" },
          { transportCallId: TRANSPORT_ID_1 }
        ),
        senderId: "caller-1",
        ts: Date.now(),
      });
      resolveExecutionStart({ accepted: true });
      await Promise.resolve();
      await Promise.resolve();

      expect(execute).not.toHaveBeenCalled();
      await client.close();
    });

    it("can redeliver after execution-start admission loses its response", async () => {
      const execute = vi.fn(async () => ({ ok: true }));
      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          sideEffect: {
            description: "side-effectful operation",
            parameters: z.object({}),
            execute,
          },
        },
      });

      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      let markAttempts = 0;
      mockRpc.call.mockImplementation(async (_target: string, method: string) => {
        if (method === "claimMethodCall") return { claimed: true, generation: 1 };
        if (method === "markMethodCallExecutionStarted") {
          markAttempts += 1;
          if (markAttempts === 1) throw new Error("execution-start response lost");
          return { accepted: true };
        }
        if (method === "submitMethodResult") return { accepted: true };
        return undefined;
      });

      const started = (id: number) => ({
        stream: "log" as const,
        phase: "live" as const,
        id,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.started",
          CALL_ID_SLOW,
          {
            name: "sideEffect",
            request: {},
            transport: {
              kind: "channel",
              channelId: CHANNEL,
              target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
              transportCallId: TRANSPORT_ID_1,
            },
          },
          { transportCallId: TRANSPORT_ID_1 }
        ),
        senderId: "caller-1",
        ts: Date.now(),
      });

      emit(started(362));
      await vi.waitFor(() => expect(markAttempts).toBe(1));
      emit(started(363));

      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      expect(markAttempts).toBe(2);
      await client.close();
    });

    it("redrives a transient provider-claim failure without terminating or blocking the subscription", async () => {
      const execute = vi.fn(async () => ({ ok: true }));
      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          sideEffect: {
            description: "side-effectful operation",
            parameters: z.object({}),
            execute,
          },
        },
      });
      await emitReplayAndReady(emit, []);
      await client.ready();
      const received = client.events();
      mockRpc.call.mockClear();
      let claimAttempts = 0;
      mockRpc.call.mockImplementation(async (_target: string, method: string) => {
        if (method === "claimMethodCall") {
          claimAttempts += 1;
          if (claimAttempts === 1) throw new Error("claim response unavailable");
          return { claimed: true, generation: 1 };
        }
        if (method === "markMethodCallExecutionStarted") return { accepted: true };
        if (method === "submitMethodResult") return { id: 1 };
        return undefined;
      });

      emit({
        stream: "log",
        phase: "live",
        id: 370,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.started",
          CALL_ID_SLOW,
          {
            name: "sideEffect",
            request: {},
            transport: {
              kind: "channel",
              channelId: CHANNEL,
              target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
              transportCallId: TRANSPORT_ID_1,
            },
          },
          { transportCallId: TRANSPORT_ID_1 }
        ),
        senderId: "caller-1",
        ts: Date.now(),
      });
      emit({
        stream: "log",
        phase: "live",
        id: 371,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: messageEvent("still-live", "subscription stayed live"),
        senderId: "agent-1",
        ts: Date.now(),
      });

      expect((await received.next()).value).toMatchObject({ pubsubId: 370 });
      expect((await received.next()).value).toMatchObject({ pubsubId: 371 });
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      expect(claimAttempts).toBe(2);
      expect(mockRpc.stream).toHaveBeenCalledTimes(1);
      await client.close();
    });

    it("abortExecutingMethod fires the local signal synchronously without a channel round-trip", async () => {
      let capturedSignal: AbortSignal | null = null;

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          slowWork: {
            description: "slow operation",
            parameters: z.object({}),
            execute: async (_args: unknown, ctx: MethodExecutionContext) => {
              capturedSignal = ctx.signal;
              await new Promise<void>((resolve) => {
                if (ctx.signal.aborted) return resolve();
                ctx.signal.addEventListener("abort", () => resolve());
              });
              throw new Error("cancelled");
            },
          },
        },
      });

      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (_target: string, method: string) =>
        method === "claimMethodCall"
          ? { claimed: true, generation: 1 }
          : method === "markMethodCallExecutionStarted"
            ? { accepted: true }
            : undefined
      );

      emit({
        stream: "log",
        phase: "live",
        id: 400,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.started",
          CALL_ID_SLOW,
          {
            name: "slowWork",
            request: {},
            transport: {
              kind: "channel",
              channelId: CHANNEL,
              target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
              transportCallId: TRANSPORT_ID_1,
            },
          },
          { transportCallId: TRANSPORT_ID_1 }
        ),
        senderId: "caller-1",
        ts: Date.now(),
      });

      await vi.waitFor(() => {
        expect(capturedSignal).not.toBeNull();
      });
      expect(capturedSignal!.aborted).toBe(false);

      // Abort locally by transport call id — no channel cancelMethodCall needed.
      const aborted = client.abortExecutingMethod(TRANSPORT_ID_1);

      expect(aborted).toBe(true);
      expect(capturedSignal!.aborted).toBe(true);
      // The local abort itself issues no cancelMethodCall RPC.
      const cancelCalls = mockRpc.call.mock.calls.filter(
        (c: unknown[]) => c[1] === "cancelMethodCall"
      );
      expect(cancelCalls.length).toBe(0);
      await vi.waitFor(() => {
        const submitCall = mockRpc.call.mock.calls.find(
          (c: unknown[]) => c[1] === "submitMethodResult"
        );
        const args = submitCall?.[2] as unknown[] | undefined;
        expect(args).toEqual(expect.arrayContaining([TRANSPORT_ID_1, expect.anything(), true]));
        expect(args?.[4]).toMatchObject({
          terminalOutcome: "cancelled",
          terminalReasonCode: "cancelled",
        });
      });

      await client.close();
    });

    it("abortExecutingMethod returns false when no execution matches the call id", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready();
      expect(client.abortExecutingMethod(TRANSPORT_ID_1)).toBe(false);
      await client.close();
    });
  });
});
