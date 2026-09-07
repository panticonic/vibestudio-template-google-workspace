// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

// In-memory stand-in mirroring runtime agentApi's state-provider registry, so we
// can assert what a debugging agent would observe via handle.state() without
// importing the full @workspace/runtime panel entry (which has side effects).
const { agentApi, providers } = vi.hoisted(() => {
  const providers = new Map<string, () => unknown>();
  const agentApi = {
    registerStateProvider(key: string, provider: () => unknown) {
      providers.set(key, provider);
      return () => providers.delete(key);
    },
    state() {
      return Object.fromEntries([...providers].map(([key, provider]) => [key, provider()]));
    },
  };
  return { agentApi, providers };
});

vi.mock("@workspace/runtime", () => ({ agentApi, Rpc: {} }));

import { useAgentState } from "../hooks";

describe("useAgentState", () => {
  beforeEach(() => {
    providers.clear();
  });

  it("exposes the current value to agentApi.state()", () => {
    const { rerender, unmount } = renderHook(({ v }) => useAgentState("editor", v), {
      initialProps: { v: { dirty: false } as Record<string, unknown> },
    });

    expect(agentApi.state()).toEqual({ editor: { dirty: false } });

    // Re-renders update what agents see without re-registering.
    rerender({ v: { dirty: true } });
    expect(agentApi.state()).toEqual({ editor: { dirty: true } });

    // Registration is cleaned up on unmount.
    unmount();
    expect(agentApi.state()).toEqual({});
  });

  it("supports multiple independent keys", () => {
    renderHook(() => {
      useAgentState("a", 1);
      useAgentState("b", 2);
    });

    expect(agentApi.state()).toEqual({ a: 1, b: 2 });
  });
});
