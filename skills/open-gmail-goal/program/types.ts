export type ComposeSelection = { id: string; title: string; room: string };
export type RetainedCompose = {
  id: string;
  channelId: string;
  state: "review" | "saving" | "saved" | "sent" | "delivery-unknown";
  draftId: string | null;
  sentId: string | null;
  mimeId: string;
  threadId: string;
  evidence: string[];
};
export type ProviderRecord = {
  id: string;
  messageId: string;
  threadId: string;
  mimeId: string;
  subject: string;
  sender: string;
  recipient: string;
  preview: string;
  sent: boolean;
  digest: string;
};
export type ReadResult =
  | { status: "found"; record: ProviderRecord }
  | { status: "missing" | "unavailable"; record: null };
export type SearchResult = {
  status: "complete" | "unavailable";
  ids: string[];
  next: string | null;
};
export type DraftChoice = { id: string | null; status: "selected" | "ambiguous" | "missing" | "unavailable" };
export type GmailContinuity =
  | "confirmed" | "recovered" | "stale" | "ambiguous" | "missing" | "incomplete"
  | "unavailable" | "delivery-confirmed" | "delivery-unconfirmed";
export type GmailGoalReport = {
  status: GmailContinuity;
  composeId: string | null;
  retainedEvents: string[];
  provider: ProviderRecord | null;
};
