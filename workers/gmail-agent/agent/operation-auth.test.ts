import { describe, expect, it, vi } from "vitest";
import { GmailApiError } from "@workspace/gmail";
import { missingScopeActionForOperation, operationAuth } from "./operations.js";
import { failGmailOperation } from "./error-policy.js";

describe("gmail operation auth metadata", () => {
  it("maps handler operation names to required Google scopes", () => {
    expect(operationAuth("gmail_modify")?.requiredScopes).toContain(
      "https://www.googleapis.com/auth/gmail.modify",
    );
    expect(operationAuth("gmail_draft")?.requiredScopes).toEqual(
      expect.arrayContaining([
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.settings.basic",
      ]),
    );
    expect(operationAuth("gmail_contacts")?.requiredScopes).toEqual(
      expect.arrayContaining(["https://www.googleapis.com/auth/gmail.modify"]),
    );
    expect(operationAuth("modify")).toBeUndefined();
    expect(operationAuth("draft")).toBeUndefined();
  });

  it("turns missing-scope failures into concrete reconnect/setup guidance", async () => {
    const action = missingScopeActionForOperation("resolveContact");
    expect(action).toContain("Reconnect Google Workspace");
    expect(action).toContain("Gmail API");

    const result = await failGmailOperation(
      {
        getChannelState: () => ({ syncState: "ok" }) as never,
        saveChannelState: vi.fn(),
        publishSetup: vi.fn(),
      },
      "ch-1",
      "resolveContact",
      new GmailApiError("missing scope", "forbidden", { status: 403 }),
    );

    expect(result.error).toMatchObject({
      code: "forbidden",
      action: expect.stringContaining("gmail.modify"),
    });
  });
  it("propagates original setup publication failure and retries its debt after auth state is saved", async () => {
    const state = { syncState: "ok" } as never;
    const original = new Error("original channel approval cancelled");
    const publishSetup = vi
      .fn()
      .mockRejectedValueOnce(original)
      .mockResolvedValueOnce(undefined);
    const deps = {
      getChannelState: () => state,
      saveChannelState: vi.fn(),
      publishSetup,
    };
    const expired = new GmailApiError("expired", "auth-expired", {
      status: 401,
    });
    await expect(
      failGmailOperation(deps, "ch-1", "search", expired),
    ).rejects.toBe(original);
    await expect(
      failGmailOperation(deps, "ch-1", "search", expired),
    ).resolves.toMatchObject({ error: { code: "auth-expired" } });
    expect(publishSetup).toHaveBeenCalledTimes(2);
    expect(deps.saveChannelState).toHaveBeenCalledTimes(1);
  });
});
