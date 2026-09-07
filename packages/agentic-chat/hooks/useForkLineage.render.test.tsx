// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@workspace/agentic-core";
import { useForkLineage, type UseForkLineageOptions } from "./useForkLineage";

function message(content: string): ChatMessage {
  return {
    id: "assistant-1",
    senderId: "agent-1",
    content,
    kind: "message",
    complete: false,
    seq: 1,
  };
}

describe("useForkLineage render stability", () => {
  it("keeps its action projection stable when a non-fork message streams", () => {
    const rpc: UseForkLineageOptions["rpc"] = {
      selfId: "panel-1",
      call: async <Result,>() => undefined as Result,
    };
    const base = {
      rpc,
      channelId: null,
      selfId: "panel-1",
      replaySettled: false,
    } satisfies Omit<UseForkLineageOptions, "messages">;
    const { result, rerender } = renderHook(
      ({ messages }: { messages: ChatMessage[] }) =>
        useForkLineage({
          ...base,
          messages,
          selfMetadata: { type: "panel", name: "Panel", handle: "alice" },
        }),
      { initialProps: { messages: [message("a")] } }
    );
    const initial = result.current;

    rerender({ messages: [message("ab")] });

    expect(result.current).toBe(initial);
  });

  it("loads the durable fork roster and reconciles unread from persisted cursors", async () => {
    const rpc: UseForkLineageOptions["rpc"] = {
      selfId: "panel-1",
      call: async <Result,>(target: string, method: string, args: unknown[]) => {
        if (target === "main" && method === "workers.resolveService") {
          return { targetId: `do:channel:${String(args[1])}` } as Result;
        }
        if (method === "getProvenance") return { kind: "root" } as Result;
        if (method === "listForks") {
          return {
            headSeq: 12,
            forks: [
              {
                parentChannelId: "root-channel",
                forkId: "fork-1",
                forkedChannelId: "child-channel",
                forkedContextId: "child-context",
                forkPointId: 5,
                label: "Investigate caching",
                reason: "fork",
                actor: { kind: "agent", id: "agent-1" },
                createdAtSeq: 6,
                headSeq: 9,
                archived: false,
              },
            ],
          } as Result;
        }
        throw new Error(`unexpected ${target}.${method}`);
      },
    };
    const nav = {
      switchTo: () => {},
      openInNewPanel: () => {},
      readForkCursors: () => ({ "child-channel": 7, "root-channel": 12 }),
    };
    const { result } = renderHook(() =>
      useForkLineage({
        rpc,
        channelId: "root-channel",
        contextId: "root-context",
        selfId: "panel-1",
        messages: [],
        replaySettled: true,
        client: {} as UseForkLineageOptions["client"],
        nav,
      })
    );

    await waitFor(() => expect(result.current.children).toHaveLength(1));
    expect(result.current.children[0]).toMatchObject({
      channelId: "child-channel",
      label: "Investigate caching",
      headSeq: 9,
      unread: true,
    });
  });

  it("loads the complete lineage tree instead of only the current spine", async () => {
    const projection = (
      parentChannelId: string,
      forkId: string,
      channelId: string,
      contextId: string,
      label: string
    ) => ({
      parentChannelId,
      forkId,
      forkedChannelId: channelId,
      forkedContextId: contextId,
      forkPointId: 1,
      label,
      reason: "fork",
      actor: { kind: "agent" as const, id: "agent-1" },
      createdAtSeq: 2,
      headSeq: 2,
      archived: false,
    });
    const forksByChannel = {
      root: [
        projection("root", "fork-a", "child-a", "context-a", "Path A"),
        projection("root", "fork-b", "child-b", "context-b", "Path B"),
      ],
      "child-a": [projection("child-a", "fork-c", "child-c", "context-c", "Path C")],
      "child-b": [],
      "child-c": [],
    };
    const rpc: UseForkLineageOptions["rpc"] = {
      selfId: "panel-1",
      call: async <Result,>(target: string, method: string, args: unknown[]) => {
        if (target === "main" && method === "workers.resolveService") {
          return { targetId: `do:channel:${String(args[1])}` } as Result;
        }
        const targetChannel = target.slice("do:channel:".length);
        if (method === "getProvenance") {
          return (
            targetChannel === "child-a"
              ? {
                  kind: "fork",
                  forkedFrom: "root",
                  parentContextId: "context-root",
                  forkPointId: 1,
                  rootChannelId: "root",
                }
              : { kind: "root" }
          ) as Result;
        }
        if (method === "listForks") {
          return {
            headSeq: 2,
            forks: forksByChannel[targetChannel as keyof typeof forksByChannel] ?? [],
          } as Result;
        }
        throw new Error(`unexpected ${target}.${method}`);
      },
    };
    const { result } = renderHook(() =>
      useForkLineage({
        rpc,
        channelId: "child-a",
        contextId: "context-a",
        selfId: "panel-1",
        messages: [],
        replaySettled: true,
        client: {} as UseForkLineageOptions["client"],
        nav: { switchTo: () => {}, openInNewPanel: () => {} },
      })
    );
    await waitFor(() => expect(result.current.provenance?.kind).toBe("fork"));

    let tree = [] as Awaited<ReturnType<typeof result.current.loadTree>>;
    await act(async () => {
      tree = await result.current.loadTree();
    });
    expect(tree[0]?.contextId).toBe("context-root");
    expect(tree[0]?.children.map((node) => node.label)).toEqual(["Path A", "Path B"]);
    expect(tree[0]?.children[0]?.children.map((node) => node.label)).toEqual(["Path C"]);
  });

  it("surfaces cursor persistence failures instead of dropping them", async () => {
    const rpc: UseForkLineageOptions["rpc"] = {
      selfId: "panel-1",
      call: async <Result,>(target: string, method: string, args: unknown[]) => {
        if (target === "main" && method === "workers.resolveService") {
          return { targetId: `do:channel:${String(args[1])}` } as Result;
        }
        if (method === "getProvenance") return { kind: "root" } as Result;
        if (method === "listForks") return { headSeq: 12, forks: [] } as Result;
        throw new Error(`unexpected ${target}.${method}`);
      },
    };
    const nav = {
      switchTo: () => {},
      openInNewPanel: () => {},
      readForkCursors: () => ({}),
      markForkRead: async () => {
        throw new Error("storage unavailable");
      },
    };
    const { result } = renderHook(() =>
      useForkLineage({
        rpc,
        channelId: "root-channel",
        contextId: "root-context",
        selfId: "panel-1",
        messages: [],
        replaySettled: true,
        client: {} as UseForkLineageOptions["client"],
        nav,
      })
    );

    await waitFor(() => expect(result.current.provenance?.kind).toBe("root"));

    await act(async () => {
      try {
        await result.current.actions.markForkRead?.("root-channel", 13);
      } catch (cause) {
        result.current.actions.reportError("Could not save the conversation read position", cause);
      }
    });
    expect(result.current.error).toBe(
      "Could not save the conversation read position: storage unavailable"
    );
  });

  it("quietly retries a read cursor after the workspace review resolves", async () => {
    const rpc: UseForkLineageOptions["rpc"] = {
      selfId: "panel-1",
      call: async <Result,>(target: string, method: string, args: unknown[]) => {
        if (target === "main" && method === "workers.resolveService") {
          return { targetId: `do:channel:${String(args[1])}` } as Result;
        }
        if (method === "getProvenance") return { kind: "root" } as Result;
        if (method === "listForks") return { headSeq: 12, forks: [] } as Result;
        throw new Error(`unexpected ${target}.${method}`);
      },
    };
    const pending = Object.assign(new Error("Waiting for workspace review"), {
      code: "EREVIEWPENDING",
      errorData: {
        authorityFailure: {
          reasonCode: "review-pending",
          remediation: {
            review: { approvalId: "workspace-review", title: "what's in your workspace" },
          },
        },
      },
    });
    const markForkRead = vi
      .fn<(channelId: string, headSeq: number) => Promise<void>>()
      .mockRejectedValueOnce(pending)
      .mockResolvedValue(undefined);
    const nav = {
      switchTo: () => {},
      openInNewPanel: () => {},
      readForkCursors: () => ({}),
      markForkRead,
    };
    const { result, rerender } = renderHook(
      ({ retrySignal }: { retrySignal: number }) =>
        useForkLineage({
          rpc,
          channelId: "root-channel",
          contextId: "root-context",
          selfId: "panel-1",
          messages: [],
          replaySettled: true,
          retrySignal,
          client: {} as UseForkLineageOptions["client"],
          nav,
        }),
      { initialProps: { retrySignal: 0 } }
    );

    await waitFor(() => expect(markForkRead).toHaveBeenCalledTimes(1));
    expect(result.current.error).toBeUndefined();

    rerender({ retrySignal: 1 });
    await waitFor(() => expect(markForkRead).toHaveBeenCalledTimes(2));
    expect(markForkRead).toHaveBeenLastCalledWith("root-channel", 12);
    expect(result.current.error).toBeUndefined();
  });
});
