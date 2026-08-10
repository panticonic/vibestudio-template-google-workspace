import { panel, rpc } from "@workspace/runtime";
import { addAgentToChannel } from "@workspace-skills/agents";
import { getGoogleOnboardingStatus } from "@workspace-skills/google-workspace";

const GMAIL_AGENT_SOURCE = "workers/gmail-agent";
const GMAIL_AGENT_CLASS = "GmailAgentWorker";
const GMAIL_AGENT_HANDLE = "gmail";

export interface GmailAgentSetupStatus {
  stage: "needs-google-workspace" | "needs-channel-setup" | "ready" | "error";
  message: string;
  google?: unknown;
}

interface InstalledAgentRecord {
  agentId: string;
  handle: string;
  key: string;
  source: string;
  className: string;
  config?: Record<string, unknown>;
}

interface GmailAgentSetupArgs {
  channelId?: string | null;
  contextId?: string | null;
  googlePubSubTopicName?: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export async function getGmailAgentSetupStatus(): Promise<GmailAgentSetupStatus> {
  try {
    const status = await getGoogleOnboardingStatus({ verify: true });
    if (status.stage === "needs-setup") {
      return {
        stage: "needs-google-workspace",
        message: "Google Workspace OAuth setup is required before Gmail can connect.",
        google: status,
      };
    }
    if (status.stage === "ready-to-connect") {
      return {
        stage: "needs-google-workspace",
        message: "Google Workspace is configured; connect the Gmail credential.",
        google: status,
      };
    }
    if (status.stage === "connected") {
      return {
        stage: "needs-google-workspace",
        message: "Google Workspace credential exists; verify it before Gmail setup.",
        google: status,
      };
    }
    if (status.stage === "verified") {
      const installedAgents = (panel.stateArgs.get() as Record<string, unknown>)["installedAgents"];
      const hasGmailAgent =
        Array.isArray(installedAgents) &&
        installedAgents.some((agent) => {
          const entry = record(agent);
          return (
            entry["handle"] === GMAIL_AGENT_HANDLE ||
            entry["source"] === GMAIL_AGENT_SOURCE ||
            entry["className"] === GMAIL_AGENT_CLASS
          );
        });
      return {
        stage: hasGmailAgent ? "ready" : "needs-channel-setup",
        message: hasGmailAgent
          ? "Gmail agent is registered for this workspace."
          : "Google Workspace is verified. Run Gmail agent setup in a channel.",
        google: status,
      };
    }
    return {
      stage: "error",
      message: "Google Workspace status is not ready for Gmail.",
      google: status,
    };
  } catch (error) {
    return {
      stage: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function gmailAgentObjectKey(channelId: string): string {
  return `gmail-${channelId}`;
}

export async function resolveGmailAgentWorker(channelId: string): Promise<{ targetId: string }> {
  const normalized = channelId.trim();
  if (!normalized) throw new Error("resolveGmailAgentWorker requires channelId");
  return rpc.call<{ targetId: string }>("main", "workers.resolveDurableObject", [
    GMAIL_AGENT_SOURCE,
    GMAIL_AGENT_CLASS,
    gmailAgentObjectKey(normalized),
  ]);
}

/** Call any public Gmail agent DO method (attention rules, reads, etc.). */
export async function callGmailAgent<T = unknown>(
  channelId: string,
  method: string,
  args: unknown = {}
): Promise<T> {
  const target = await resolveGmailAgentWorker(channelId);
  return rpc.call<T>(target.targetId, method, [channelId, args]);
}

function updateInstalledAgents(
  existing: unknown,
  next: InstalledAgentRecord
): InstalledAgentRecord[] {
  const current = Array.isArray(existing) ? (existing as InstalledAgentRecord[]) : [];
  return [...current.filter((agent) => agent.handle !== next.handle), next];
}

export async function setupGmailAgent(args: GmailAgentSetupArgs = {}): Promise<{
  ok: boolean;
  channelId?: string;
  contextId?: string;
  targetId?: string;
  participantId?: string;
}> {
  const channelId = args.channelId?.trim();
  if (!channelId) {
    throw new Error("setupGmailAgent requires channelId");
  }
  const googleStatus = await getGoogleOnboardingStatus({ verify: true });
  const googleCredentialId = googleStatus.credentialId;
  if (googleStatus.stage !== "verified" || !googleCredentialId) {
    throw new Error("setupGmailAgent requires a verified Google Workspace credential");
  }

  // Channel-membership mechanics are the general helper's job (per-channel key
  // `gmail-${channelId}` === gmailAgentObjectKey); we only add the Google-credential
  // prerequisite. `googleCredentialId` is NOT a behavior setting, so it survives
  // toSubscriptionConfig and the worker still reads it from the subscription config;
  // `approvalLevel` correctly moves to stateArgs.agentConfig.
  const behavior = {
    approvalLevel: 2,
    googleCredentialId,
    ...(args.googlePubSubTopicName?.trim()
      ? { googlePubSubTopicName: args.googlePubSubTopicName.trim() }
      : {}),
  };
  const result = await addAgentToChannel({
    source: GMAIL_AGENT_SOURCE,
    className: GMAIL_AGENT_CLASS,
    handle: GMAIL_AGENT_HANDLE,
    name: "Gmail",
    channelId,
    contextId: args.contextId,
    config: behavior,
  });

  const stateArgs = panel.stateArgs.get() as Record<string, unknown>;
  await panel.stateArgs.set({
    installedAgents: updateInstalledAgents(stateArgs["installedAgents"], {
      agentId: GMAIL_AGENT_CLASS,
      handle: GMAIL_AGENT_HANDLE,
      key: result.key,
      source: GMAIL_AGENT_SOURCE,
      className: GMAIL_AGENT_CLASS,
      config: { handle: GMAIL_AGENT_HANDLE, name: "Gmail", ...behavior },
    }),
  });

  return {
    ok: result.ok,
    channelId: result.channelId,
    contextId: result.contextId,
    targetId: result.targetId,
    participantId: result.participantId,
  };
}
