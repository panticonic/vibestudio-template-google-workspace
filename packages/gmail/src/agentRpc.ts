import { createReceiverRpcMethods } from "@vibestudio/shared/rpcMethods";
import type { GmailAttentionPrefs } from "./card-types.js";
/** Canonical Gmail agent protocol, implemented by the durable receiver. */
export interface GmailAgentProtocol {
  getAttentionPrefs(channelId: string): Promise<GmailAttentionPrefs>;
  setAttentionPrefs(channelId: string, args: unknown): Promise<{ saved: true; preferences: GmailAttentionPrefs }>;
  registerPushTarget(input: { emailAddress: string; source: string; className: string; objectKey: string }): { registered: true };
  onGmailPushNotification(payload: { emailAddress: string; historyId: string }): Promise<{ synced: string[] }>;
}
export const gmailAgentRpcMethods = createReceiverRpcMethods<GmailAgentProtocol>(["getAttentionPrefs", "setAttentionPrefs", "registerPushTarget", "onGmailPushNotification"]);
