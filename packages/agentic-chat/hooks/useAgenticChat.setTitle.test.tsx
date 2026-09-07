// @vitest-environment jsdom

import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MethodDefinition, PubSubClient } from "@workspace/pubsub";

const pubsubMock = vi.hoisted(() => ({
  connectViaRpc: vi.fn(),
}));

vi.mock("@workspace/pubsub", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/pubsub")>()),
  connectViaRpc: pubsubMock.connectViaRpc,
}));

vi.mock("@workspace/tool-ui", () => ({
  useFeedbackManager: () => ({
    activeFeedbacks: new Map(),
    addFeedback: vi.fn(),
    removeFeedback: vi.fn(),
    dismissFeedback: vi.fn(),
    handleFeedbackError: vi.fn(),
  }),
  useToolApproval: () => ({
    settings: {},
    setGlobalFloor: vi.fn(),
  }),
}));

import { useAgenticChat } from "./useAgenticChat";
import type { ChatContextValue, ConnectionConfig } from "../types";
import { FULL_AGENTIC_CHAT_FEATURES, type AgenticChatFeature } from "../features";

function createClient(
  channelConfig: { title?: string; titleExplicit?: boolean } = {}
): PubSubClient & {
  updateChannelConfig: ReturnType<typeof vi.fn>;
} {
  return {
    clientId: "panel:chat",
    channelConfig,
    connected: false,
    ready: vi.fn(async () => undefined),
    onReady: vi.fn(() => () => undefined),
    close: vi.fn(),
    events: vi.fn(async function* () {}),
    onRoster: vi.fn(() => () => undefined),
    onReconnect: vi.fn(() => () => undefined),
    onConfigChange: vi.fn(() => () => undefined),
    getMessageTypes: vi.fn(async () => []),
    updateChannelConfig: vi.fn(async () => undefined),
  } as unknown as PubSubClient & { updateChannelConfig: ReturnType<typeof vi.fn> };
}

function createRpcCall() {
  return vi.fn(async (_target: string, method: string) => {
    if (method === "workers.resolveService") {
      return { kind: "durable-object", targetId: "do:channel:chat-title-test" };
    }
    if (method === "getProvenance") {
      return { kind: "root" };
    }
    return undefined;
  }) as unknown as ConnectionConfig["rpc"]["call"];
}

function Probe({
  config,
  onContext,
  features = FULL_AGENTIC_CHAT_FEATURES,
  loadDynamicImports = true,
}: {
  config: ConnectionConfig;
  onContext?: (value: ChatContextValue) => void;
  features?: readonly AgenticChatFeature[];
  loadDynamicImports?: boolean;
}) {
  const { contextValue } = useAgenticChat({
    config,
    channelName: "chat-title-test",
    metadata: { name: "Chat Panel", type: "panel", handle: "alice" },
    ...(loadDynamicImports
      ? {
          importLoader: vi.fn(async () => ({ bundle: "", format: "cjs" as const })),
        }
      : {}),
    features,
  });
  onContext?.(contextValue);
  return null;
}

describe("useAgenticChat set_title", () => {
  beforeEach(() => {
    document.title = "";
    pubsubMock.connectViaRpc.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the runtime RPC id, not the channel participant id, for browser handoff", async () => {
    const client = createClient();
    pubsubMock.connectViaRpc.mockReturnValue(client);
    const latestContext: { current: ChatContextValue | null } = { current: null };
    const config: ConnectionConfig = {
      clientId: "panel:slot-id",
      rpc: {
        selfId: "panel:runtime-entity",
        call: createRpcCall(),
        stream: vi.fn(async () => new Response()),
        on: vi.fn(() => () => undefined),
      },
    };

    const { unmount } = render(
      <Probe
        config={config}
        onContext={(value) => {
          latestContext.current = value;
        }}
      />
    );

    await waitFor(() => {
      expect(latestContext.current?.selfId).toBe("panel:chat");
    });
    expect(latestContext.current?.browserHandoffCaller).toEqual({
      id: "panel:runtime-entity",
      kind: "panel",
    });
    expect(pubsubMock.connectViaRpc).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "panel:slot-id" })
    );

    unmount();
  });

  it("keeps child transcript connection material stable across parent updates", async () => {
    const client = createClient();
    let publishConfig: ((config: { title?: string }) => void) | undefined;
    client.onConfigChange = vi.fn((callback: (config: { title?: string }) => void) => {
      publishConfig = callback;
      return () => undefined;
    }) as never;
    pubsubMock.connectViaRpc.mockReturnValue(client);
    const latestContext: { current: ChatContextValue | null } = { current: null };
    const config: ConnectionConfig = {
      clientId: "panel:slot-id",
      rpc: {
        selfId: "panel:runtime-entity",
        call: createRpcCall(),
        stream: vi.fn(async () => new Response()),
        on: vi.fn(() => () => undefined),
      },
    };

    const { unmount } = render(
      <Probe
        config={config}
        onContext={(value) => {
          latestContext.current = value;
        }}
      />
    );
    await waitFor(() => expect(publishConfig).toBeDefined());
    const initialConnection = latestContext.current!.childTranscript;

    act(() => publishConfig?.({ title: "Parent changed" }));

    await waitFor(() => expect(latestContext.current?.channelTitle).toBe("Parent changed"));
    expect(latestContext.current?.childTranscript).toBe(initialConnection);
    unmount();
  });

  it("keeps a transient connection failure visible while automatic retry is pending", async () => {
    const client = createClient();
    client.close = vi.fn(async () => undefined);
    client.ready = vi.fn(async () => {
      throw new Error("ReadError(Reset(513))");
    });
    pubsubMock.connectViaRpc.mockReturnValue(client);
    const latestContext: { current: ChatContextValue | null } = { current: null };
    const config: ConnectionConfig = {
      clientId: "panel:chat",
      rpc: {
        selfId: "panel:chat",
        call: createRpcCall(),
        stream: vi.fn(async () => new Response()),
        on: vi.fn(() => () => undefined),
      },
    };

    const { unmount } = render(
      <Probe
        config={config}
        onContext={(value) => {
          latestContext.current = value;
        }}
      />
    );

    await waitFor(
      () => {
        expect(latestContext.current?.connectionError?.message).toBe("ReadError(Reset(513))");
      },
      { timeout: 200 }
    );
    expect(pubsubMock.connectViaRpc).toHaveBeenCalledOnce();

    unmount();
  });

  it("recovers automatically after a transient initial connection failure", async () => {
    const failedClient = createClient();
    failedClient.close = vi.fn(async () => undefined);
    failedClient.ready = vi.fn(async () => {
      throw new Error("ReadError(Reset(513))");
    });
    const recoveredClient = createClient();
    pubsubMock.connectViaRpc
      .mockReturnValueOnce(failedClient)
      .mockReturnValueOnce(recoveredClient);
    const latestContext: { current: ChatContextValue | null } = { current: null };
    const config: ConnectionConfig = {
      clientId: "panel:chat",
      rpc: {
        selfId: "panel:chat",
        call: createRpcCall(),
        stream: vi.fn(async () => new Response()),
        on: vi.fn(() => () => undefined),
      },
    };

    const { unmount } = render(
      <Probe
        config={config}
        onContext={value => {
          latestContext.current = value;
        }}
      />
    );

    await waitFor(() => expect(latestContext.current?.connected).toBe(true), {
      timeout: 1_000,
    });
    expect(pubsubMock.connectViaRpc).toHaveBeenCalledTimes(2);
    expect(latestContext.current?.connectionError).toBeNull();

    unmount();
  });

  it("does not advertise a panel-owned set_title method", async () => {
    const client = createClient();
    let methods: Record<string, MethodDefinition> | undefined;
    pubsubMock.connectViaRpc.mockImplementation(
      (options: { methods: Record<string, MethodDefinition> }) => {
        methods = options.methods;
        return client;
      }
    );
    const call = createRpcCall();
    const config: ConnectionConfig = {
      clientId: "panel:chat",
      rpc: {
        selfId: "panel:chat",
        call,
        stream: vi.fn(async () => new Response()),
        on: vi.fn(() => () => undefined),
      },
    };

    const { unmount } = render(<Probe config={config} />);

    await waitFor(() => {
      expect(methods).toBeDefined();
    });
    expect(methods?.["set_title"]).toBeUndefined();

    unmount();
  });

  it("advertises the explicit full feature surface", async () => {
    const client = createClient();
    let methods: Record<string, MethodDefinition> | undefined;
    pubsubMock.connectViaRpc.mockImplementation(
      (options: { methods: Record<string, MethodDefinition> }) => {
        methods = options.methods;
        return client;
      }
    );
    const config: ConnectionConfig = {
      clientId: "panel:chat",
      rpc: {
        selfId: "panel:chat",
        call: createRpcCall(),
        stream: vi.fn(async () => new Response()),
        on: vi.fn(() => () => undefined),
      },
    };

    const { unmount } = render(<Probe config={config} />);

    await waitFor(() => expect(methods).toBeDefined());
    expect(Object.keys(methods ?? {})).toEqual(
      expect.arrayContaining([
        "feedback_form",
        "feedback_custom",
        "confirm",
        "ui_prompt",
        "inline_ui",
        "load_action_bar",
        "client_eval",
      ])
    );

    unmount();
  });

  it("does not advertise feature-owned methods when no features are selected", async () => {
    const client = createClient();
    let methods: Record<string, MethodDefinition> | undefined;
    pubsubMock.connectViaRpc.mockImplementation(
      (options: { methods: Record<string, MethodDefinition> }) => {
        methods = options.methods;
        return client;
      }
    );
    const config: ConnectionConfig = {
      clientId: "panel:chat",
      rpc: {
        selfId: "panel:chat",
        call: createRpcCall(),
        stream: vi.fn(async () => new Response()),
        on: vi.fn(() => () => undefined),
      },
    };

    const { unmount } = render(<Probe config={config} features={[]} loadDynamicImports={false} />);

    await waitFor(() => expect(methods).toBeDefined());
    for (const name of [
      "feedback_form",
      "feedback_custom",
      "confirm",
      "ui_prompt",
      "inline_ui",
      "load_action_bar",
      "client_eval",
    ]) {
      expect(methods?.[name]).toBeUndefined();
    }

    unmount();
  });

  it("projects an explicit channel title onto an attached panel", async () => {
    let onConfigChange: ((config: { title?: string; titleExplicit?: boolean }) => void) | undefined;
    const client = {
      ...createClient(),
      onConfigChange: vi.fn((handler) => {
        onConfigChange = handler;
        return () => undefined;
      }),
    } as unknown as PubSubClient;
    pubsubMock.connectViaRpc.mockReturnValue(client);
    const call = createRpcCall();
    const config: ConnectionConfig = {
      clientId: "panel:chat",
      rpc: {
        selfId: "panel:chat",
        call,
        stream: vi.fn(async () => new Response()),
        on: vi.fn(() => () => undefined),
      },
    };

    const { unmount } = render(<Probe config={config} />);

    await waitFor(() => {
      expect(onConfigChange).toBeDefined();
    });
    act(() => {
      onConfigChange?.({ title: "Persistent task store", titleExplicit: true });
    });
    await waitFor(() => {
      expect(document.title).toBe("Persistent task store");
      expect(call).toHaveBeenCalledWith("main", "runtime.setTitle", [
        "Persistent task store",
        { explicit: true },
      ]);
    });

    unmount();
  });

  it("projects a durable explicit title when the panel connects late", async () => {
    const client = createClient({ title: "Existing task title", titleExplicit: true });
    pubsubMock.connectViaRpc.mockReturnValue(client);
    const call = createRpcCall();
    const config: ConnectionConfig = {
      clientId: "panel:chat",
      rpc: {
        selfId: "panel:runtime-entity",
        call,
        stream: vi.fn(async () => new Response()),
        on: vi.fn(() => () => undefined),
      },
    };

    const { unmount } = render(<Probe config={config} />);

    await waitFor(() => {
      expect(document.title).toBe("Existing task title");
      expect(call).toHaveBeenCalledWith("main", "runtime.setTitle", [
        "Existing task title",
        { explicit: true },
      ]);
    });

    unmount();
  });
});
