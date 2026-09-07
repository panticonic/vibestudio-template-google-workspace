import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RpcCaller } from "@vibestudio/rpc";
import type { StoredCredentialSummary } from "../shared/credentials.js";
import { connect, initPanelCredentials } from "./credentials.js";

const storedCredential: StoredCredentialSummary = {
  id: "cred-1",
  label: "Example",
  accountIdentity: { providerUserId: "user-1" },
  audience: [{ url: "https://api.example.com/", match: "origin" }],
  injection: {
    type: "header",
    name: "authorization",
    valueTemplate: "Bearer {token}",
  },
  scopes: ["scope-1"],
  lifecycle: { state: "active", canRefresh: false },
  metadata: {},
};

describe("panel credential OAuth API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates OAuth connection orchestration to the host", async () => {
    const callMock = vi.fn(async (_targetId: string, method: string): Promise<unknown> => {
      if (method === "credentials.connect") {
        return storedCredential;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    initPanelCredentials({
      call: callMock as RpcCaller["call"],
      stream: vi.fn(async () => new Response()) as unknown as RpcCaller["stream"],
    });

    await expect(connect({
      flow: {
        type: "oauth2-auth-code-pkce",
        authorizeUrl: "https://auth.example.com/oauth/authorize",
        tokenUrl: "https://auth.example.com/oauth/token",
        clientId: "client-1",
        scopes: ["scope-1"],
      },
      credential: {
        label: "Example",
        audience: [{ url: "https://api.example.com/", match: "origin" }],
        injection: {
          type: "header",
          name: "authorization",
          valueTemplate: "Bearer {token}",
        },
        scopes: ["scope-1"],
      },
    })).resolves.toEqual(storedCredential);

    expect(callMock).toHaveBeenCalledWith(
      "main",
      "credentials.connect",
      [
        expect.objectContaining({
          flow: expect.objectContaining({ clientId: "client-1" }),
        }),
      ],
    );
  });
});
