// @vitest-environment jsdom

import { Theme } from "@radix-ui/themes";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ModelCredentialRequiredCard from "./ModelCredentialRequiredCard";

describe("ModelCredentialRequiredCard", () => {
  it("explains workspace and system browser choices for initial OAuth credential setup", () => {
    const chat = {
      callMethod: vi.fn(async () => ({ ok: true })),
    };

    render(
      <Theme>
        <ModelCredentialRequiredCard
          chat={chat}
          props={{
            providerId: "openai-codex",
            modelRef: "openai-codex:gpt-5.5",
            modelBaseUrl: "https://chatgpt.com/backend-api",
            agentParticipantId: "do:agent",
            flow: { type: "oauth2-auth-code-pkce" },
          }}
        />
      </Theme>
    );

    expect(
      screen.getByText(
        "Choose the browser that is already signed in to the account you want to connect. If neither is signed in, pick the one you want to use."
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use workspace browser/i })).toBeTruthy();
    expect(
      screen.getByText("Choose this when the account is signed in inside this workspace.")
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use system browser/i })).toBeTruthy();
    expect(
      screen.getByText("Choose this when your regular browser already has the right account.")
    ).toBeTruthy();
  });

  it("uses refresh-specific browser labels when reconnecting credentials", () => {
    const chat = {
      callMethod: vi.fn(async () => ({ ok: true })),
    };

    render(
      <Theme>
        <ModelCredentialRequiredCard
          chat={chat}
          props={{
            providerId: "openai-codex",
            modelRef: "openai-codex:gpt-5.5",
            modelBaseUrl: "https://chatgpt.com/backend-api",
            agentParticipantId: "do:agent",
            flow: { type: "oauth2-auth-code-pkce" },
            reason: "Provided authentication token is expired. Please try signing in again.",
          }}
        />
      </Theme>
    );

    expect(
      screen.getByText(
        "Choose the browser that is signed in to the account you want to reconnect. If neither is signed in, pick the one you want to use."
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Refresh in workspace browser/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Refresh in system browser/i })).toBeTruthy();
  });

  it("only offers the native system browser on mobile hosts", () => {
    Object.assign(globalThis, { __vibestudioHostPlatform: "mobile" });
    try {
      render(
        <Theme>
          <ModelCredentialRequiredCard
            chat={{ callMethod: vi.fn(async () => ({ ok: true })) }}
            props={{
              providerId: "openai-codex",
              modelBaseUrl: "https://chatgpt.com/backend-api",
              agentParticipantId: "do:agent",
              flow: { type: "oauth2-auth-code-pkce" },
            }}
          />
        </Theme>
      );

      expect(screen.getByRole("button", { name: /Use system browser/i })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Use workspace browser/i })).toBeNull();
    } finally {
      delete (globalThis as { __vibestudioHostPlatform?: unknown }).__vibestudioHostPlatform;
    }
  });

  it("switches the selected model before connecting credentials and persists best-effort", async () => {
    const calls: Array<{ participantId: string; method: string; args: unknown }> = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const chat = {
      callMethod: vi.fn(async (participantId: string, method: string, args: unknown) => {
        calls.push({ participantId, method, args });
        if (method === "persist_agent_model") throw new Error("approval denied");
        return { ok: true };
      }),
    };

    render(
      <Theme>
        <ModelCredentialRequiredCard
          chat={chat}
          props={{
            providerId: "openai-codex",
            modelRef: "openai-codex:gpt-5.5",
            modelBaseUrl: "https://chatgpt.com/backend-api",
            agentParticipantId: "do:agent",
            browserHandoffCallerId: "panel:runtime-1",
            browserHandoffCallerKind: "panel",
            modelPersistenceParticipantId: "panel:chat-participant",
            providerOptions: [
              {
                providerId: "openai-codex",
                providerLabel: "ChatGPT",
                modelRef: "openai-codex:gpt-5.5",
                modelName: "GPT-5.5",
                modelBaseUrl: "https://chatgpt.com/backend-api",
                flow: { type: "oauth2-auth-code-pkce" },
              },
              {
                providerId: "anthropic",
                providerLabel: "Anthropic",
                modelRef: "anthropic:claude-3-5-sonnet-20241022",
                modelName: "Claude 3.5 Sonnet",
                modelBaseUrl: "https://api.anthropic.com",
                flow: { type: "api-key" },
              },
            ],
          }}
        />
      </Theme>
    );

    fireEvent.click(screen.getByText("Anthropic"));
    fireEvent.click(screen.getByRole("button", { name: /Enter API Key/i }));

    await waitFor(() => expect(chat.callMethod).toHaveBeenCalledTimes(3));
    expect(calls.map((call) => [call.participantId, call.method])).toEqual([
      ["do:agent", "setModel"],
      ["panel:chat-participant", "persist_agent_model"],
      ["do:agent", "connectModelCredential"],
    ]);
    expect(calls[1]?.args).toEqual({
      participantId: "do:agent",
      model: "anthropic:claude-3-5-sonnet-20241022",
    });
    expect(calls[2]?.args).toMatchObject({
      providerId: "anthropic",
      modelBaseUrl: "https://api.anthropic.com",
      modelRef: "anthropic:claude-3-5-sonnet-20241022",
      browserOpenMode: "internal",
      browserHandoffCallerId: "panel:runtime-1",
      browserHandoffCallerKind: "panel",
    });
    await waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});
