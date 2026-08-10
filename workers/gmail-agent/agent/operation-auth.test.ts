import { describe, expect, it, vi } from "vitest";
import { GmailApiError } from "@workspace/gmail";
import { missingScopeActionForOperation, operationAuth } from "./operations.js";
import { failGmailOperation } from "./error-policy.js";

describe("gmail operation auth metadata", () => {
  it("maps handler operation names to required Google scopes", () => {
    expect(operationAuth("gmail_modify")?.requiredScopes).toContain(
      "https://www.googleapis.com/auth/gmail.modify"
    );
    expect(operationAuth("gmail_draft")?.requiredScopes).toEqual(
      expect.arrayContaining([
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.settings.basic",
      ])
    );
    expect(operationAuth("gmail_contacts")?.requiredScopes).toEqual(
      expect.arrayContaining([
        "https://www.googleapis.com/auth/contacts",
        "https://www.googleapis.com/auth/contacts.other.readonly",
      ])
    );
    expect(operationAuth("modify")).toBeUndefined();
    expect(operationAuth("draft")).toBeUndefined();
  });

  it("turns missing-scope failures into concrete reconnect/setup guidance", async () => {
    const action = missingScopeActionForOperation("resolveContact");
    expect(action).toContain("Reconnect Google Workspace");
    expect(action).toContain("People API");

    const result = await failGmailOperation(
      {
        getChannelState: () => ({ syncState: "ok" }) as never,
        saveChannelState: vi.fn(),
        publishSetup: vi.fn(),
      },
      "ch-1",
      "resolveContact",
      new GmailApiError("missing scope", "forbidden", { status: 403 })
    );

    expect(result.error).toMatchObject({
      code: "forbidden",
      action: expect.stringContaining("contacts.other.readonly"),
    });
  });
});
