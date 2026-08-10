export type GmailThreadStatus = "unread" | "open" | "archived";

export interface GmailThreadMessageSummary {
  id: string;
  from?: string;
  date?: string;
  snippet?: string;
}

export interface GmailThreadState {
  threadId: string;
  subject: string;
  participants: string[];
  lastSnippet: string;
  unreadCount: number;
  labelIds?: string[];
  category?: string;
  hasDraft: boolean;
  status: GmailThreadStatus;
  messages?: GmailThreadMessageSummary[];
}

export type GmailThreadUpdate =
  | { kind: "newMessage"; message: GmailThreadMessageSummary; unreadCount?: number; lastSnippet?: string }
  | { kind: "labelChange"; labelIds: string[]; unreadCount?: number; category?: string }
  | { kind: "draftSet"; draftBody?: string | null }
  | { kind: "statusChange"; status: GmailThreadStatus }
  | Partial<GmailThreadState>;

export function reduce(
  state: GmailThreadState,
  update: GmailThreadUpdate
): GmailThreadState {
  if (!("kind" in update) || typeof update.kind !== "string") {
    return { ...state, ...update };
  }

  switch (update.kind) {
    case "newMessage": {
      const messages = [...(state.messages ?? []), update.message];
      return {
        ...state,
        messages,
        lastSnippet: update.lastSnippet ?? update.message.snippet ?? state.lastSnippet,
        unreadCount: update.unreadCount ?? state.unreadCount + 1,
        status: state.status === "archived" ? "open" : state.status,
      };
    }
    case "labelChange":
      return {
        ...state,
        labelIds: update.labelIds,
        unreadCount: update.unreadCount ?? state.unreadCount,
        category: update.category ?? state.category,
      };
    case "draftSet":
      return {
        ...state,
        hasDraft: Boolean(update.draftBody),
      };
    case "statusChange":
      return {
        ...state,
        status: update.status,
      };
    default:
      return state;
  }
}
