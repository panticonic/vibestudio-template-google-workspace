export const GMAIL_AGENT_SOURCE = "workers/gmail-agent";
export const GMAIL_AGENT_CLASS = "GmailAgentWorker";
export const GMAIL_AGENT_HANDLE = "gmail";

export function gmailAgentObjectKey(channelId: string): string {
  return `gmail-${channelId}`;
}

/** Seed the ordinary chat subscription owner with Gmail's canonical identity. */
export function gmailChatStateArgs(
  channelId: string,
  googleCredentialId: string,
) {
  const channelName = channelId.trim();
  if (!channelName || !googleCredentialId.trim())
    throw new Error("Gmail requires a channel and verified credential");
  return {
    channelName,
    agentConfig: { approvalLevel: 2 },
    installedAgents: [
      {
        agentId: GMAIL_AGENT_CLASS,
        handle: GMAIL_AGENT_HANDLE,
        key: gmailAgentObjectKey(channelName),
        source: GMAIL_AGENT_SOURCE,
        className: GMAIL_AGENT_CLASS,
        config: {
          handle: GMAIL_AGENT_HANDLE,
          name: "Gmail",
          googleCredentialId,
        },
      },
    ],
    actionBarFile: "packages/gmail/src/action-bar.tsx",
  };
}
