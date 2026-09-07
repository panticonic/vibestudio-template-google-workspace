import { describe, expect, it, vi } from "vitest";
import { localToolExecutor } from "./index.js";

describe("localToolExecutor", () => {
  const blobstore = {
    getText: vi.fn(),
    putText: vi.fn(async (value: string) => ({
      digest: "a".repeat(64),
      size: new TextEncoder().encode(value).byteLength,
    })),
  };
  it("preserves a local tool termination request as durable turn control", async () => {
    const outcome = await localToolExecutor.execute({
      descriptor: {
        kind: "local_tool",
        effectId: "effect-1",
        channelId: "channel-1",
        invocationId: "invocation-1",
        tool: "complete",
        args: { report: "done" },
      } as never,
      state: {} as never,
      signal: new AbortController().signal,
      deps: {
        blobstore,
        localTools: {
          alreadyApplied: async () => null,
          run: async () => ({
            result: { protocolContent: [], details: { outcome: "success" } },
            isError: false,
            terminate: true,
          }),
        },
      } as never,
      onEphemeral: () => undefined,
    });

    expect(outcome).toMatchObject({
      kind: "tool",
      isError: false,
      turnControl: { kind: "terminate" },
    });
  });

  it.each(["already_handled", "not_addressed", "no_foreground_work"])(
    "settles a turn whose suspend reason is %s",
    async (reason) => {
      const outcome = await localToolExecutor.execute({
        descriptor: {
          kind: "local_tool",
          effectId: `effect-${reason}`,
          channelId: "channel-1",
          invocationId: `invocation-${reason}`,
          tool: "suspend_turn",
          args: { reason },
        } as never,
        state: {} as never,
        signal: new AbortController().signal,
        deps: {
          blobstore,
          localTools: {
            alreadyApplied: async () => null,
            run: async () => ({
              result: {
                protocolContent: [],
                details: { suspendTurn: true, reason },
              },
              isError: false,
            }),
          },
        } as never,
        onEphemeral: () => undefined,
      });

      expect(outcome).toMatchObject({
        kind: "tool",
        isError: false,
        turnControl: { kind: "terminate" },
      });
    },
  );

  it("keeps a turn open while concrete background work remains", async () => {
    const outcome = await localToolExecutor.execute({
      descriptor: {
        kind: "local_tool",
        effectId: "effect-waiting",
        channelId: "channel-1",
        invocationId: "invocation-waiting",
        tool: "suspend_turn",
        args: { reason: "waiting_for_background" },
      } as never,
      state: {} as never,
      signal: new AbortController().signal,
      deps: {
        blobstore,
        localTools: {
          alreadyApplied: async () => null,
          run: async () => ({
            result: {
              protocolContent: [],
              details: {
                suspendTurn: true,
                reason: "waiting_for_background",
              },
            },
            isError: false,
          }),
        },
      } as never,
      onEphemeral: () => undefined,
    });

    expect(outcome).toMatchObject({
      kind: "tool",
      isError: false,
      turnControl: {
        kind: "suspend",
        reason: "waiting_for_background",
      },
    });
  });

  it("does not execute a mutation whose semantic command is already complete", async () => {
    const run = vi.fn();
    const outcome = await localToolExecutor.execute({
      descriptor: {
        kind: "local_tool",
        effectId: "effect-replayed",
        channelId: "channel-1",
        invocationId: "invocation-replayed",
        tool: "write",
        args: { path: "file.txt", content: "value" },
      } as never,
      state: {} as never,
      signal: new AbortController().signal,
      deps: {
        blobstore,
        localTools: {
          alreadyApplied: async () => ({
            commandId: "command-replayed",
            command: { kind: "command", value: { status: "complete" } },
          }),
          run,
        },
      } as never,
      onEphemeral: () => undefined,
    });

    expect(run).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: "tool",
      isError: false,
      result: {
        protocolContent: [
          {
            type: "text",
            text: expect.stringContaining("command-replayed"),
          },
        ],
        details: {
          replayed: true,
          evidence: { commandId: "command-replayed" },
        },
      },
    });
  });

  it("returns executor failures in the canonical tool-result envelope", async () => {
    const outcome = await localToolExecutor.execute({
      descriptor: {
        kind: "local_tool",
        effectId: "effect-failed",
        channelId: "channel-1",
        invocationId: "invocation-failed",
        tool: "read",
        args: {},
      } as never,
      state: {} as never,
      signal: new AbortController().signal,
      deps: {
        blobstore,
        localTools: {
          alreadyApplied: async () => null,
          run: async () => {
            throw Object.assign(new Error("host read failed"), {
              code: "host_unavailable",
            });
          },
        },
      } as never,
      onEphemeral: () => undefined,
    });

    expect(outcome).toMatchObject({
      kind: "tool",
      isError: true,
      terminalReasonCode: "host_unavailable",
      result: {
        protocolContent: [
          { type: "text", text: expect.stringContaining("host read failed") },
        ],
        details: { failure: { code: "host_unavailable" } },
      },
    });
  });

  it("normalizes returned domain failures instead of only thrown failures", async () => {
    const outcome = await localToolExecutor.execute({
      descriptor: {
        kind: "local_tool",
        effectId: "effect-domain-failed",
        channelId: "channel-1",
        invocationId: "invocation-domain-failed",
        tool: "verify",
        args: {},
      } as never,
      state: {} as never,
      signal: new AbortController().signal,
      deps: {
        blobstore,
        localTools: {
          alreadyApplied: async () => null,
          run: async () => ({
            result: {
              protocolContent: [{ type: "text", text: "build failed" }],
              details: {
                errorData: {
                  code: "build_failed",
                  remediation: "Repair source.",
                },
              },
            },
            isError: true,
          }),
        },
      } as never,
      onEphemeral: () => undefined,
    });

    expect(outcome).toMatchObject({
      kind: "tool",
      isError: true,
      terminalReasonCode: "build_failed",
      failure: {
        code: "build_failed",
        recovery: { instruction: "Repair source." },
      },
      result: { details: { failure: { code: "build_failed" } } },
    });
  });

  it("stores oversized results behind a typed artifact resource", async () => {
    blobstore.putText.mockClear();
    const outcome = await localToolExecutor.execute({
      descriptor: {
        kind: "local_tool",
        effectId: "effect-large",
        channelId: "channel-1",
        invocationId: "invocation-large",
        tool: "diagnostics",
        args: {},
      } as never,
      state: {} as never,
      signal: new AbortController().signal,
      deps: {
        blobstore,
        localTools: {
          alreadyApplied: async () => null,
          run: async () => ({
            result: {
              protocolContent: [{ type: "text", text: "x".repeat(60_000) }],
              details: {
                rows: Array.from({ length: 100 }, (_, index) => ({ index })),
              },
            },
            isError: false,
          }),
        },
      } as never,
      onEphemeral: () => undefined,
    });

    expect(blobstore.putText).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      result: {
        details: {
          artifact: {
            protocol: "agent-tool-artifact.v1",
            uri: `artifact:${"a".repeat(64)}`,
            byteLength: expect.any(Number),
          },
        },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("x".repeat(40_000));
  });
});
