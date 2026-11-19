export type GmailReview = {
  status: "ready" | "waiting" | "attention" | "blocked";
  findings: { code: string; evidenceIds: string[] }[];
};

export type GmailScope = {
  target: { id: string; channelId: string; accountRef: string };
  observed: {
    id: string;
    channelId: string;
    accountRef: string;
    binding: "native-original" | "native-mismatch" | "channel-readback";
  };
};

type GmailTask = { goal: string; scope: GmailScope };

export type GmailSetup = GmailTask & {
  kind: "setup";
  workspace: {
    id: string;
    audience: string;
    verified: boolean;
    identityPermissions: boolean;
    gmailModify: boolean;
    gmailSettings: boolean;
    gmailApiAvailable: boolean;
  };
  channel: {
    id: string;
    workspaceRegistration: boolean;
    participantSubscribed: boolean;
    actionBar: boolean;
    renderers: boolean;
    configured: boolean;
  };
};

export type GmailRead = GmailTask & {
  kind: "read";
  readback:
    | {
        kind: "search";
        id: string;
        requestedQueryRef: string;
        observedQueryRef: string;
        requestedPage: string | null;
        observedPage: string | null;
        returnedThreads: number;
        limit: number;
        nextPage: boolean;
        mirrorRequested: boolean;
        cardPublished: boolean;
      }
    | {
        kind: "participant-query";
        id: string;
        cachedMatchCount: number;
        source: "cache" | "api";
        cardPublished: boolean;
        returnedThreads: number;
      }
    | {
        kind: "message";
        id: string;
        requestedObject: string;
        observedObject: string;
        format: "metadata" | "full";
        bodyIncluded: boolean;
        bodySanitized: boolean;
        transient: boolean;
      }
    | {
        kind: "contacts";
        id: string;
        mode: "suggest" | "resolve";
        localCandidates: number;
        source: "history" | "google" | "none";
      };
};

export type GmailAttention = GmailTask & {
  kind: "attention";
  readback:
    | {
        kind: "candidate";
        id: string;
        unread: boolean;
        inInbox: boolean;
        priorReply: boolean;
        shortcutEnabled: boolean;
        configuredOrSaved: boolean;
        candidatesInBatch: number;
        runsThisHour: number;
        model: "not-run" | "working" | "retriable" | "exhausted";
      }
    | {
        kind: "preferences";
        id: string;
        caller: "panel" | "gmail-agent" | "other-worker";
        intent: "read" | "write";
        saved: boolean;
        dryRunScope: "recent-hits" | "entire-mailbox" | "none";
      }
    | {
        kind: "wake";
        id: string;
        oldestQueuedAgeMs: number;
        queuedHitCount: number;
        wakeTurnsThisHour: number;
        chatMessages: number;
        digestCards: number;
        digestRows: number;
        moreCount: number;
      };
};

export type GmailCompose = GmailTask & {
  kind: "compose";
  card: {
    id: string;
    messageId: string;
    requestedMessageId: string;
    ownedByChannel: boolean;
    state:
      | "drafting"
      | "review"
      | "saved"
      | "sending"
      | "delivery-unknown"
      | "sent";
    hasRecipient: boolean;
    alias: "default" | "configured" | "unknown";
  };
  readback:
    | {
        kind: "draft";
        id: string;
        origin: "gmail-agent" | "participant";
        beforeDraft: string | null;
        afterDraft: string | null;
      }
    | {
        kind: "authorization";
        id: string;
        actor: "gmail-agent" | "user" | "participant";
        authority: "explicit-user-instruction" | "user-send-click" | "none";
      }
    | {
        kind: "reconcile";
        id: string;
        providerProof: "sent-matched" | "no-match" | "not-checked";
      };
};

export type GmailSync = GmailTask & {
  kind: "sync";
  readback:
    | {
        kind: "watch";
        id: string;
        topicConfigured: boolean;
        ingressConfigured: boolean;
        watchActive: boolean;
        pollMinutes: number;
      }
    | {
        kind: "push";
        id: string;
        canonicalRouter: boolean;
        mailboxMatched: boolean;
        stillSubscribed: boolean;
        reconnectRequired: boolean;
      }
    | {
        kind: "history";
        id: string;
        phase: "baseline" | "incremental";
        cursorAdvanced: boolean;
        threadsUpdated: number;
        rateLimited: boolean;
        retryBackoff: boolean;
      };
};

export type GmailReviewRequest =
  | GmailSetup
  | GmailRead
  | GmailAttention
  | GmailCompose
  | GmailSync;

export type ComposeHistoryRequest = { goal: string; operationId: string };

export type ComposeHistoryState = {
  status: "drafting" | "review" | "saving" | "saved" | "sending" | "delivery-unknown" | "sent" | "discarding" | "discarded" | "error";
  recipientPresent: boolean;
  alias: "default" | "configured" | "unknown";
  draftId: string | null;
  mimeIdentity: boolean;
  sentIdentity: boolean;
};

export type ComposeHistoryReceipt = {
  channelId: string;
  messageId: string;
  events: {
    id: string;
    seq: number;
    state: ComposeHistoryState;
    event: "start" | "update" | "failed-update";
  }[];
};

export type ComposeHistoryDecision = {
  action: "resolve-recipient" | "review-draft" | "draft-recorded" | "wait" |
    "reconcile-delivery" | "delivery-recorded" | "discarded" | "hold";
  reason: string;
};

export type ComposeHistoryReport = {
  receipt: ComposeHistoryReceipt;
  decision: ComposeHistoryDecision;
  evidenceIds: string[];
};
