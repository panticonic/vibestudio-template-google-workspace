import { describe, expect, it } from "vitest";
import {
  GOOGLE_WORKSPACE_BROAD_SCOPES,
  googleWorkspaceBindings,
  googleWorkspaceCredential,
} from "./providers.js";

describe("Google Workspace credential catalog", () => {
  it("keeps staged service bindings within the credential binding limit", () => {
    expect(googleWorkspaceCredential.bindings).toHaveLength(8);
    expect(googleWorkspaceCredential.bindings.map((binding) => binding.id)).toEqual([
      "google-gmail",
      "google-calendar",
      "google-drive",
      "google-docs",
      "google-sheets",
      "google-slides",
      "google-people",
      "google-identity",
    ]);
    expect(GOOGLE_WORKSPACE_BROAD_SCOPES).toEqual(
      expect.arrayContaining([
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/presentations",
      ])
    );
  });

  it("admits the live identity endpoint used by onboarding verification", () => {
    expect(googleWorkspaceBindings.identity.audience).toContainEqual({
      url: "https://www.googleapis.com/oauth2/v3/userinfo",
      match: "path-prefix",
    });
  });
});
