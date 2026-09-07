import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMock = vi.hoisted(() => ({
  openExternal: vi.fn(),
  openPanel: vi.fn(),
  credentials: {
    requestCredentialInput: vi.fn(),
    listStoredCredentials: vi.fn(),
    revokeCredential: vi.fn(),
  },
}));

vi.mock("@workspace/runtime", () => runtimeMock);

import {
  openSearchProviderSignup,
  requestSearchProviderApiKey,
} from "./index.js";

describe("search provider setup helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens signup inside Vibestudio by default", async () => {
    await openSearchProviderSignup("tavily");

    expect(runtimeMock.openPanel).toHaveBeenCalledWith(
      "https://app.tavily.com/home",
      { focus: true, title: "Tavily Search setup" }
    );
    expect(runtimeMock.openExternal).not.toHaveBeenCalled();
  });

  it("opens signup in the system browser when selected", async () => {
    await openSearchProviderSignup("brave", { browser: "external" });

    expect(runtimeMock.openExternal).toHaveBeenCalledWith(
      "https://api-dashboard.search.brave.com/app/keys"
    );
    expect(runtimeMock.openPanel).not.toHaveBeenCalled();
  });

  it("uses the host-owned credential prompt for the selected provider", async () => {
    runtimeMock.credentials.requestCredentialInput.mockResolvedValue({ id: "search-key" });

    await requestSearchProviderApiKey("exa");

    expect(runtimeMock.credentials.requestCredentialInput).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Add Exa Search",
        credential: expect.objectContaining({
          metadata: expect.objectContaining({ providerId: "exa" }),
        }),
        fields: [
          expect.objectContaining({ name: "token", type: "secret", required: true }),
        ],
      })
    );
  });
});
