import type {
  GmailAttention,
  GmailCompose,
  GmailRead,
  GmailReview,
  GmailReviewRequest,
  GmailScope,
  GmailSetup,
  GmailSync,
} from "../gmail-workflow-review/types.js";

export type GmailWorkflowWorld = {
  id: string;
  sourceGroup: string;
  request: GmailReviewRequest;
  expected: GmailReview;
};

function world(
  id: string,
  group: string,
  request: GmailReviewRequest,
  status: GmailReview["status"],
  code: string,
  ...evidenceIds: string[]
): GmailWorkflowWorld {
  return {
    id: `gmail-${id}`,
    sourceGroup: `vibestudio:gmail-review:${group}`,
    request,
    expected: { status, findings: [{ code, evidenceIds }] },
  };
}

const scope: GmailScope = {
  target: {
    id: "selected-mailbox",
    channelId: "project-chat",
    accountRef: "work-mailbox",
  },
  observed: {
    id: "scoped-run",
    channelId: "project-chat",
    accountRef: "work-mailbox",
    binding: "channel-readback",
  },
};

const workspace: GmailSetup["workspace"] = {
  id: "workspace-verification",
  audience: "google-workspace",
  verified: true,
  identityPermissions: true,
  gmailModify: true,
  gmailSettings: true,
  gmailApiAvailable: true,
};
const channel: GmailSetup["channel"] = {
  id: "installation-readback",
  workspaceRegistration: true,
  participantSubscribed: true,
  actionBar: true,
  renderers: true,
  configured: true,
};
function setup(goal: string, patch: Partial<GmailSetup> = {}): GmailSetup {
  return { kind: "setup", goal, scope, workspace, channel, ...patch };
}
function read(
  goal: string,
  readback: GmailRead["readback"],
  readScope: GmailScope = readback.kind === "search"
    ? { ...scope, observed: { ...scope.observed, binding: "native-original" } }
    : scope,
): GmailRead {
  return { kind: "read", goal, scope: readScope, readback };
}
const searchPage: Extract<GmailRead["readback"], { kind: "search" }> = {
  kind: "search",
  id: "search-page",
  requestedQueryRef: "open-project-threads",
  observedQueryRef: "open-project-threads",
  requestedPage: "page-two",
  observedPage: "page-two",
  returnedThreads: 18,
  limit: 20,
  nextPage: true,
  mirrorRequested: false,
  cardPublished: false,
};
const scopedWorlds = [
  world(
    "different-channel",
    "scope",
    setup(
      "Gmail appears installed, but the action bar receipt comes from another channel. Can it verify this setup?",
      {
        scope: {
          ...scope,
          observed: { ...scope.observed, channelId: "finance-chat" },
        },
      },
    ),
    "blocked",
    "gmail-channel-mismatch",
    "selected-mailbox",
    "scoped-run",
  ),
  world(
    "different-mailbox",
    "scope",
    read(
      "The search reused the selected channel after an account change. Can the new mailbox prove the old mailbox search?",
      searchPage,
      {
        ...scope,
        observed: { ...scope.observed, accountRef: "newly-selected-mailbox" },
      },
    ),
    "blocked",
    "gmail-account-mismatch",
    "selected-mailbox",
    "scoped-run",
  ),
  world(
    "original-native-offer-missing",
    "scope",
    read(
      "The receipt names the expected mailbox but the tool offer no longer carries its original binding. Check attribution.",
      searchPage,
      {
        ...scope,
        observed: { ...scope.observed, binding: "native-mismatch" },
      },
    ),
    "blocked",
    "gmail-offer-mismatch",
    "selected-mailbox",
    "scoped-run",
  ),
];
const setupWorlds = [
  world(
    "gmail-settings-not-verified",
    "setup",
    setup(
      "Workspace verification passed for lookup and mail access, but there is no Gmail settings permission. Can the worker setup be marked ready?",
      {
        workspace: { ...workspace, gmailSettings: false },
      },
    ),
    "waiting",
    "gmail-permissions-incomplete",
    "workspace-verification",
  ),
  world(
    "registration-without-membership",
    "setup",
    setup(
      "The owning panel lists Gmail among installed agents. Can we conclude the intended channel already has a participant?",
      {
        channel: { ...channel, participantSubscribed: false },
      },
    ),
    "waiting",
    "gmail-channel-unsubscribed",
    "installation-readback",
  ),
  world(
    "installed-needs-attention-onboarding",
    "setup",
    setup(
      "The channel renders Gmail controls and cards but has never completed its first-run attention setup. What remains?",
      {
        channel: { ...channel, configured: false },
      },
    ),
    "waiting",
    "gmail-attention-onboarding",
    "installation-readback",
  ),
];
const readWorlds = [
  world(
    "search-thread-page",
    "search",
    read(
      "Review a nonmirrored second page of Gmail thread search and check whether another page remains.",
      searchPage,
    ),
    "ready",
    "search-has-next-page",
    "search-page",
  ),
  world(
    "participant-cache-first-silent",
    "search",
    read(
      "A participant searched silently but used the API even though the same channel had local matches. Does that match this participant method?",
      {
        kind: "participant-query",
        id: "participant-lookup",
        cachedMatchCount: 4,
        source: "api",
        cardPublished: false,
        returnedThreads: 4,
      },
    ),
    "attention",
    "participant-query-contract",
    "participant-lookup",
  ),
  world(
    "metadata-body-leak",
    "message-read",
    read(
      "A metadata request expected headers and snippets. Can this result be accepted if it contains the complete body?",
      {
        kind: "message",
        id: "metadata-readback",
        requestedObject: "selected-thread",
        observedObject: "selected-thread",
        format: "metadata",
        bodyIncluded: true,
        bodySanitized: true,
        transient: true,
      },
    ),
    "blocked",
    "read-privacy-mismatch",
    "metadata-readback",
  ),
  world(
    "offline-contact-candidates",
    "contacts",
    read(
      "Check that compose address typeahead stayed on its offline suggest path.",
      {
        kind: "contacts",
        id: "typeahead-readback",
        mode: "suggest",
        localCandidates: 2,
        source: "history",
      },
    ),
    "ready",
    "offline-contact-suggestions",
    "typeahead-readback",
  ),
];

function attention(
  goal: string,
  readback: GmailAttention["readback"],
): GmailAttention {
  return { kind: "attention", goal, scope, readback };
}
const candidate: Extract<GmailAttention["readback"], { kind: "candidate" }> = {
  kind: "candidate",
  id: "inbox-readback",
  unread: true,
  inInbox: true,
  priorReply: false,
  shortcutEnabled: true,
  configuredOrSaved: true,
  candidatesInBatch: 12,
  runsThisHour: 3,
  model: "working",
};
const preference: Extract<GmailAttention["readback"], { kind: "preferences" }> =
  {
    kind: "preferences",
    id: "preference-readback",
    caller: "gmail-agent",
    intent: "write",
    saved: true,
    dryRunScope: "recent-hits",
  };
const attentionWorlds = [
  world(
    "known-sender-before-onboarding",
    "triage-candidate",
    attention(
      "An unread Inbox message came from a person the user replied to. Can it wake the default channel before model triage is configured?",
      {
        ...candidate,
        priorReply: true,
        configuredOrSaved: false,
        model: "not-run",
      },
    ),
    "ready",
    "known-sender-wake",
    "inbox-readback",
  ),
  world(
    "quiet-model-fallback",
    "triage-candidate",
    attention(
      "Automatic triage used all retries for an unread Inbox sender with no reply history. Did the fallback have to discard or wake the thread?",
      {
        ...candidate,
        model: "exhausted",
      },
    ),
    "ready",
    "fallback-surface-quiet",
    "inbox-readback",
  ),
  world(
    "hourly-triage-exhausted",
    "triage-cap",
    attention(
      "Twelve batched model calls have already been counted this hour. Determine the state of this unfamiliar sender while its candidate is still queued.",
      {
        ...candidate,
        runsThisHour: 12,
        model: "not-run",
      },
    ),
    "waiting",
    "triage-hourly-cap",
    "inbox-readback",
  ),
  world(
    "other-agent-preference-write",
    "preferences",
    attention(
      "A peer worker claims to have changed the Gmail user's attention text. Review the caller and confirmation.",
      {
        ...preference,
        caller: "other-worker",
        saved: false,
        dryRunScope: "none",
      },
    ),
    "blocked",
    "preference-write-denied",
    "preference-readback",
  ),
  world(
    "dry-run-only-recent-hits",
    "preferences",
    attention(
      "A saved preference receipt claims its dry run predicts changes for previously ignored mail across the entire mailbox. Is that claim supported?",
      {
        ...preference,
        dryRunScope: "entire-mailbox",
      },
    ),
    "attention",
    "dry-run-scope-overclaim",
    "preference-readback",
  ),
  world(
    "wake-budget-keeps-hits",
    "wake-digest",
    attention(
      "The digest window has elapsed, but the channel already ran four wake turns in the preceding hour. What happens to the queued hits?",
      {
        kind: "wake",
        id: "wake-window",
        oldestQueuedAgeMs: 93_000,
        queuedHitCount: 7,
        wakeTurnsThisHour: 4,
        chatMessages: 0,
        digestCards: 0,
        digestRows: 0,
        moreCount: 0,
      },
    ),
    "waiting",
    "wake-cap-keeps-queue",
    "wake-window",
  ),
];

const card: GmailCompose["card"] = {
  id: "owned-compose",
  messageId: "compose-one",
  requestedMessageId: "compose-one",
  ownedByChannel: true,
  state: "review",
  hasRecipient: true,
  alias: "configured",
};
function compose(
  goal: string,
  readback: GmailCompose["readback"],
  observedCard = card,
): GmailCompose {
  return { kind: "compose", goal, scope, readback, card: observedCard };
}
const composeWorlds = [
  world(
    "participant-drafts-in-review",
    "compose-scope",
    compose(
      "A project agent requested a Gmail draft using the participant method. Check the resulting card's stage.",
      {
        kind: "draft",
        id: "draft-request",
        origin: "participant",
        beforeDraft: null,
        afterDraft: null,
      },
    ),
    "ready",
    "participant-draft-review",
    "owned-compose",
  ),
  world(
    "saved-draft-update",
    "compose-lineage",
    compose(
      "After reopening a saved draft, the user saved it again. Verify whether this was an update to the same Gmail draft.",
      {
        kind: "draft",
        id: "save-readback",
        origin: "gmail-agent",
        beforeDraft: "draft-original",
        afterDraft: "draft-original",
      },
      { ...card, state: "saved" },
    ),
    "ready",
    "saved-draft-updated",
    "save-readback",
  ),
  world(
    "peer-cannot-send",
    "send-authority",
    compose(
      "A peer automation claims an explicit instruction covers its requested send. Verify whether the caller has authority for an existing review card.",
      {
        kind: "authorization",
        id: "send-request",
        actor: "participant",
        authority: "explicit-user-instruction",
      },
    ),
    "blocked",
    "send-authority-missing",
    "send-request",
  ),
  world(
    "alias-must-be-configured",
    "send-authority",
    compose(
      "The user clicked Send, but the From identity did not appear in the mailbox's configured alias list. Check the compose.",
      {
        kind: "authorization",
        id: "user-click",
        actor: "user",
        authority: "user-send-click",
      },
      { ...card, alias: "unknown" },
    ),
    "blocked",
    "unknown-send-as-alias",
    "owned-compose",
  ),
  world(
    "network-result-remains-unproven",
    "send-reconciliation",
    compose(
      "A send lost its transport response. The retained message identity currently has no matching Sent receipt. Explain the canonical outcome.",
      {
        kind: "reconcile",
        id: "sent-lookup",
        providerProof: "no-match",
      },
      { ...card, state: "delivery-unknown" },
    ),
    "waiting",
    "delivery-unproven",
    "sent-lookup",
  ),
];

function sync(goal: string, readback: GmailSync["readback"]): GmailSync {
  return { kind: "sync", goal, scope, readback };
}
const syncWorlds = [
  world(
    "polling-without-push-topic",
    "sync-watch",
    sync(
      "There is a working history poll and no configured watch topic. Determine what the channel currently has available.",
      {
        kind: "watch",
        id: "sync-config",
        topicConfigured: false,
        ingressConfigured: false,
        watchActive: false,
        pollMinutes: 5,
      },
    ),
    "ready",
    "history-polling-only",
    "sync-config",
  ),
  world(
    "push-router-identity",
    "sync-push",
    sync(
      "An inbound notification has the matching mailbox but its recorded caller is not the Gmail push router. Can it establish channel sync?",
      {
        kind: "push",
        id: "push-readback",
        canonicalRouter: false,
        mailboxMatched: true,
        stillSubscribed: true,
        reconnectRequired: false,
      },
    ),
    "blocked",
    "push-caller-mismatch",
    "push-readback",
  ),
  world(
    "initial-cursor-only",
    "sync-history",
    sync(
      "Gmail supplied the first history cursor after channel setup. Was the prior inbox refreshed by that operation?",
      {
        kind: "history",
        id: "history-readback",
        phase: "baseline",
        cursorAdvanced: true,
        threadsUpdated: 0,
        rateLimited: false,
        retryBackoff: false,
      },
    ),
    "ready",
    "history-baseline-established",
    "history-readback",
  ),
  world(
    "batch-rate-limit-backoff",
    "sync-history",
    sync(
      "A history refresh hit Gmail's rate limit, and scheduler readback confirms a delayed retry. Determine the observed state.",
      {
        kind: "history",
        id: "backoff-readback",
        phase: "incremental",
        cursorAdvanced: false,
        threadsUpdated: 0,
        rateLimited: true,
        retryBackoff: true,
      },
    ),
    "waiting",
    "gmail-rate-backoff",
    "backoff-readback",
  ),
];

export const gmailWorkflowWorlds: GmailWorkflowWorld[] = [
  ...scopedWorlds,
  ...setupWorlds,
  ...readWorlds,
  ...attentionWorlds,
  ...composeWorlds,
  ...syncWorlds,
];
