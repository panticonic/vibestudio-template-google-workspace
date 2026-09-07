// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatMessage, MessageTypeDefinition } from "@workspace/agentic-core";
import { useMessageTypeRegistry, type MessageTypeRegistryState } from "./useMessageTypeRegistry";

function customMessage(typeId: string): ChatMessage {
  return {
    id: "custom:msg-1",
    senderId: "agent-1",
    content: "",
    contentType: "custom",
    custom: {
      messageId: "msg-1",
      typeId,
      displayMode: "inline",
      updates: [],
      lastSeq: -1,
    },
  };
}

function Probe({
  definitions,
  messages,
  onValue,
}: {
  definitions: MessageTypeDefinition[];
  messages: ChatMessage[];
  onValue: (value: MessageTypeRegistryState) => void;
}) {
  const value = useMessageTypeRegistry({
    client: null,
    definitions,
    messages,
  });
  onValue(value);
  return null;
}

describe("useMessageTypeRegistry", () => {
  it("completes compiles whose triggering effect was superseded by new registrations", async () => {
    // Regression: types registering in quick succession re-run the compile
    // effect; the in-flight compile's result must still land (the old
    // effect-scoped cancel flag dropped it while the pending-compile guard
    // blocked a recompile — a permanent "compiling" spinner).
    let latest: MessageTypeRegistryState | undefined;
    const globals = globalThis as Record<string, unknown>;
    globals["__vibestudioModuleMap__"] = globals["__vibestudioModuleMap__"] ?? {};
    globals["__vibestudioRequire__"] =
      globals["__vibestudioRequire__"] ??
      ((id: string) => {
        const mod = (globals["__vibestudioModuleMap__"] as Record<string, unknown>)[id];
        if (mod) return mod;
        throw new Error(`Module "${id}" not available`);
      });
    const moduleCode = "export default function Card() { return null; }";
    const first: MessageTypeDefinition = {
      typeId: "alpha",
      displayMode: "row",
      source: { type: "code", code: moduleCode },
      updatedAtSeq: 1,
      cleared: false,
    };
    const second: MessageTypeDefinition = {
      typeId: "beta",
      displayMode: "row",
      source: { type: "code", code: moduleCode },
      updatedAtSeq: 2,
      cleared: false,
    };

    const view = render(
      <Probe
        definitions={[first]}
        messages={[]}
        onValue={(value) => { latest = value; }}
      />,
    );
    // Re-render immediately with a NEW array identity while alpha compiles.
    view.rerender(
      <Probe
        definitions={[first, second]}
        messages={[]}
        onValue={(value) => { latest = value; }}
      />,
    );

    await waitFor(() => {
      expect(latest?.messageTypeComponents.get("alpha")?.status).toBe("ready");
      expect(latest?.messageTypeComponents.get("beta")?.status).toBe("ready");
    });
  });

  it("renders cleared message types as an explicit error instead of loading forever", async () => {
    let latest: MessageTypeRegistryState | undefined;
    const definitions: MessageTypeDefinition[] = [{
      typeId: "weather",
      updatedAtSeq: 10,
      clearedAtSeq: 20,
      cleared: true,
    }];

    render(
      <Probe
        definitions={definitions}
        messages={[customMessage("weather")]}
        onValue={(value) => { latest = value; }}
      />,
    );

    await waitFor(() => {
      expect(latest?.messageTypeComponents.get("weather")).toMatchObject({
        status: "error",
        message: "Message type weather was cleared",
      });
    });
  });
});
