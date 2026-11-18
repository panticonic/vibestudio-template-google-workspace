import type { DriveClient } from "@workspace/google-workspace";
import type { GoogleDriveOnboardingStatus } from "./index.js";
import { bindGoogleWorkspaceRead } from "./drive-workflow-read.js";
import type { GoogleWorkflowWorld } from "./drive-workflow-worlds.js";

export function createGoogleWorkflowFixture(world: GoogleWorkflowWorld) {
  const stages = {
    "needs-setup": "needs-setup",
    "needs-consent": "ready-to-connect",
    "needs-verification": "connected",
    "needs-drive-scope": "verified",
    "verification-failed": "verified",
    ready: "verified",
  } as const;
  const state = world.state;
  const verified = state === "ready";
  const fixtureStatus: GoogleDriveOnboardingStatus = {
    stage: verified
      ? "ready"
      : state === "verification-failed"
        ? "error"
        : "needs-google-workspace",
    connected: verified || state === "verification-failed",
    verified,
    credentialId: "caller-owned",
    googleWorkspace: {
      stage: stages[state],
      connected: state !== "needs-setup" && state !== "needs-consent",
      configured: state !== "needs-setup",
      readyToConnect: state !== "needs-setup",
      credentials: [],
      nextActions: [],
      warnings: [],
    },
    credentials: [],
    nextActions: [],
    warnings: [],
  };
  let calls = 0;
  async function page() {
    const body = world.pages[calls++];
    if (!body) throw new Error("Fixture page unavailable");
    return structuredClone(body);
  }
  const readinessReads: { verify?: boolean }[] = [];
  const credentialReads: (string | undefined)[] = [];
  const client = {
    listFiles: page as unknown as DriveClient["listFiles"],
    listPermissions: page as unknown as DriveClient["listPermissions"],
    listChanges: page as unknown as DriveClient["listChanges"],
  };
  const binding = bindGoogleWorkspaceRead(world.assignment, {
    async inspect(options) {
      readinessReads.push({ verify: options?.verify === true });
      return structuredClone(fixtureStatus);
    },
    drive(options) {
      credentialReads.push(options?.credentialId);
      return client as DriveClient;
    },
  });
  return { binding, readinessReads, credentialReads, calls: () => calls };
}
