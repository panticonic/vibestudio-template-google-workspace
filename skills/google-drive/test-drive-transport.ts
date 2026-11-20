import { createDriveClient } from "@workspace/google-workspace";
import {
  createGoogleWorkspaceRead,
  type GoogleWorkspaceAssignment,
} from "./drive-workflow-binding.js";

export function bindTestDriveTransport(
  assignment: GoogleWorkspaceAssignment,
  receive: (url: URL) => Promise<Response>,
) {
  const fixtureCredential = "owned-drive-test-transport";
  const drive = createDriveClient(
    {
      async forAudience({ credentialId }) {
        if (credentialId !== fixtureCredential)
          throw new Error(
            "Credential outside the assigned Drive test transport",
          );
        return {
          credentialId,
          async fetch(input, init) {
            const url = new URL(input);
            if (
              url.origin !== "https://www.googleapis.com" ||
              (init?.method && init.method !== "GET") ||
              init?.body ||
              new Headers(init?.headers).get("accept") !== "application/json"
            )
              throw new Error(
                "Only assigned Drive metadata reads reach this test transport",
              );
            return receive(url);
          },
        };
      },
    },
    { credentialId: fixtureCredential },
  );
  return createGoogleWorkspaceRead(assignment, {
    async inspect() {
      return {
        stage: "ready",
        connected: true,
        verified: true,
        credentialId: fixtureCredential,
        googleWorkspace: {
          stage: "verified",
          connected: true,
          configured: true,
          readyToConnect: true,
          credentials: [],
          nextActions: [],
          warnings: [],
        },
        credentials: [],
        nextActions: [],
        warnings: [],
      };
    },
    drive: () => drive,
  });
}
