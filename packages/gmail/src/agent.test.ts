import { beforeEach, expect, it, vi } from "vitest";
import {
  GOOGLE_DRIVE_SCOPES,
  GOOGLE_GMAIL_SCOPES,
} from "@workspace/google-workspace/providers";
const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  addAgent: vi.fn(),
  getState: vi.fn(async () => ({ installedAgents: [] })),
  setState: vi.fn(),
  call: vi.fn(),
}));
vi.mock("@workspace/runtime", () => ({
  getParent: () => ({
    stateArgs: { get: mocks.getState, patch: mocks.setState },
  }),
  rpc: { call: mocks.call },
}));
vi.mock("@workspace-skills/google-workspace", () => ({
  getGoogleOnboardingStatus: mocks.status,
}));
vi.mock("@workspace-skills/agents", () => ({
  addAgentToChannel: mocks.addAgent,
}));
import {
  getGmailAgentSetupStatus,
  setupGmailAgent,
  gmailChatStateArgs,
  gmailAgentObjectKey,
} from "./agent";
beforeEach(() => vi.clearAllMocks());
it("requires Gmail permissions even when the Google identity and Drive access are verified", async () => {
  mocks.status.mockResolvedValue({
    stage: "verified",
    credentialId: "google",
    verification: { scopes: GOOGLE_DRIVE_SCOPES },
  });
  expect(await getGmailAgentSetupStatus()).toMatchObject({
    stage: "needs-google-workspace",
  });
  await expect(setupGmailAgent({ channelId: "mail" })).rejects.toThrow(
    "Gmail permissions",
  );
  expect(mocks.addAgent).not.toHaveBeenCalled();
});
it("offers channel setup after verifying Gmail permissions", async () => {
  mocks.status.mockResolvedValue({
    stage: "verified",
    credentialId: "google",
    verification: { scopes: GOOGLE_GMAIL_SCOPES },
  });
  expect(await getGmailAgentSetupStatus()).toMatchObject({
    stage: "needs-channel-setup",
  });
});
it("opens chat through the same owned identity used by Gmail tool resolution", () => {
  const state = gmailChatStateArgs("mail", "google");
  expect(state.installedAgents).toEqual([
    {
      agentId: "GmailAgentWorker",
      handle: "gmail",
      key: gmailAgentObjectKey(state.channelName),
      source: "workers/gmail-agent",
      className: "GmailAgentWorker",
      config: { handle: "gmail", name: "Gmail", googleCredentialId: "google" },
    },
  ]);
  expect(state.agentConfig).toEqual({ approvalLevel: 2 });
  expect(() => gmailChatStateArgs("", "google")).toThrow();
});
