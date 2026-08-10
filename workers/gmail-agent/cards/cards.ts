import type { CardManager, CustomMessageHandle } from "@workspace/agentic-do";
import type { SqlStorage } from "@workspace/runtime/worker";
import type { CustomMessageDisplayMode } from "@workspace/agentic-protocol";
import {
  GMAIL_COMPOSE_STATE_SCHEMA,
  GMAIL_COMPOSE_UPDATE_SCHEMA,
  GMAIL_DIGEST_STATE_SCHEMA,
  GMAIL_SEARCH_STATE_SCHEMA,
  GMAIL_SEARCH_UPDATE_SCHEMA,
  GMAIL_SETUP_STATE_SCHEMA,
  GMAIL_THREAD_STATE_SCHEMA,
  GMAIL_THREAD_UPDATE_SCHEMA,
  type GmailComposeCardState,
  type GmailDigestCardState,
  type GmailSearchCardState,
  type GmailSetupState,
  type GmailThreadCardState,
} from "@workspace/gmail/card-types";
import type { GmailThreadUpdate } from "@workspace/gmail/renderers/gmail-thread.reducer";

export interface GmailMessageTypeSpec {
  typeId: string;
  displayMode: CustomMessageDisplayMode;
  path: string;
  stateSchema: Record<string, unknown>;
  updateSchema?: Record<string, unknown>;
}

export const GMAIL_MESSAGE_TYPES: GmailMessageTypeSpec[] = [
  {
    typeId: "gmail.setup",
    displayMode: "inline",
    path: "packages/gmail/src/renderers/gmail-setup.tsx",
    stateSchema: GMAIL_SETUP_STATE_SCHEMA,
  },
  {
    typeId: "gmail.digest",
    displayMode: "row",
    path: "packages/gmail/src/renderers/gmail-digest.tsx",
    stateSchema: GMAIL_DIGEST_STATE_SCHEMA,
  },
  {
    typeId: "gmail.search",
    displayMode: "row",
    path: "packages/gmail/src/renderers/gmail-search.tsx",
    stateSchema: GMAIL_SEARCH_STATE_SCHEMA,
    updateSchema: GMAIL_SEARCH_UPDATE_SCHEMA,
  },
  {
    typeId: "gmail.thread",
    displayMode: "inline",
    path: "packages/gmail/src/renderers/gmail-thread.tsx",
    stateSchema: GMAIL_THREAD_STATE_SCHEMA,
    updateSchema: GMAIL_THREAD_UPDATE_SCHEMA,
  },
  {
    typeId: "gmail.compose",
    displayMode: "row",
    path: "packages/gmail/src/renderers/gmail-compose.tsx",
    stateSchema: GMAIL_COMPOSE_STATE_SCHEMA,
    updateSchema: GMAIL_COMPOSE_UPDATE_SCHEMA,
  },
];

/** Message types from earlier UI generations, tombstoned on install. */
export const GMAIL_RETIRED_MESSAGE_TYPES = ["gmail.inbox"];

export const SETUP_CARD_KEY = "gmail:setup";

export function threadCardKey(threadId: string): string {
  return `gmail:thread:${threadId}`;
}

export function composeCardKey(composeId: string): string {
  return `gmail:compose:${composeId}`;
}

export interface GmailCardsDeps {
  cards: CardManager;
  sql: SqlStorage;
}

/**
 * Gmail card publishing on top of the platform CardManager. Singleton cards
 * (setup) are keyed by stable natural keys so restarts and retries reuse the
 * same message; digests and searches intentionally mint a new card each time
 * so they scroll away with the conversation.
 */
export class GmailCards {
  constructor(private readonly deps: GmailCardsDeps) {}

  /** Publish (or update) the singleton setup/connection card for a channel. */
  async publishSetup(channelId: string, payload: GmailSetupState): Promise<void> {
    const existing = this.deps.cards.find(channelId, SETUP_CARD_KEY);
    if (existing) {
      await existing.update(payload);
      return;
    }
    await this.deps.cards.getOrCreate(channelId, "gmail.setup", SETUP_CARD_KEY, payload, {
      displayMode: "inline",
    });
  }

  /** A new immutable digest card per wake turn. */
  async publishDigest(
    channelId: string,
    payload: GmailDigestCardState
  ): Promise<CustomMessageHandle> {
    return this.deps.cards.getOrCreate(
      channelId,
      "gmail.digest",
      `gmail:digest:${payload.generatedAt}:${crypto.randomUUID().slice(0, 8)}`,
      payload,
      { displayMode: "row" }
    );
  }

  /** A new search card per query, created in "searching" state. */
  async createSearch(channelId: string, query: string): Promise<CustomMessageHandle> {
    const payload: GmailSearchCardState = {
      query,
      status: "searching",
      results: [],
      searchedAt: Date.now(),
    };
    return this.deps.cards.getOrCreate(
      channelId,
      "gmail.search",
      `gmail:search:${crypto.randomUUID()}`,
      payload,
      { displayMode: "row" }
    );
  }

  async updateSearch(
    channelId: string,
    messageId: string,
    patch: Partial<GmailSearchCardState>
  ): Promise<void> {
    const handle = this.deps.cards.get(channelId, messageId);
    if (handle) await handle.update(patch);
  }

  /** Publish (or focus) a standalone thread card for a Gmail thread. */
  async publishThread(
    channelId: string,
    state: GmailThreadCardState
  ): Promise<CustomMessageHandle> {
    const handle = this.deps.cards.find(channelId, threadCardKey(state.threadId));
    if (handle) {
      await handle.update(state);
      return handle;
    }
    return this.deps.cards.getOrCreate(
      channelId,
      "gmail.thread",
      threadCardKey(state.threadId),
      state,
      { displayMode: "inline" }
    );
  }

  /** Update a thread card if one exists; threads without cards are no-ops. */
  async updateThread(
    channelId: string,
    threadId: string,
    update: GmailThreadUpdate | GmailThreadCardState | Record<string, unknown>
  ): Promise<void> {
    const handle = this.deps.cards.find(channelId, threadCardKey(threadId));
    if (handle) await handle.update(update);
  }

  async createCompose(
    channelId: string,
    state: GmailComposeCardState
  ): Promise<CustomMessageHandle> {
    const composeId = crypto.randomUUID();
    return this.deps.cards.getOrCreate(
      channelId,
      "gmail.compose",
      composeCardKey(composeId),
      state,
      { displayMode: "row" }
    );
  }

  composeByMessageId(channelId: string, messageId: string): CustomMessageHandle | null {
    return this.deps.cards.get(channelId, messageId);
  }

  async updateCompose(
    channelId: string,
    messageId: string | undefined,
    patch: Partial<GmailComposeCardState>
  ): Promise<void> {
    if (!messageId) return;
    const handle = this.deps.cards.get(channelId, messageId);
    if (handle) await handle.update(patch);
  }

  /**
   * Adopt a card that was recovered from channel replay (e.g. after a fork)
   * into the CardManager registry so subsequent updates reuse its identity.
   */
  adoptRecoveredCard(
    channelId: string,
    naturalKey: string,
    typeId: string,
    messageId: string
  ): void {
    this.deps.cards.adoptRecovered(channelId, naturalKey, typeId, messageId);
  }
}
