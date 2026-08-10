/**
 * Test factory for GmailClient fakes. Every method is a vi.fn with a benign
 * default so tests only override what they assert on — adding a method to
 * GmailClient should touch this file, not every consumer's test harness.
 *
 * Exported via the package's "./test-utils" entry; never import from
 * production code (it depends on vitest).
 */
import { vi } from "vitest";

import type {
  GmailBatchItem,
  GmailClient,
  GmailDraft,
  GmailMessage,
  GmailProfile,
  GmailThread,
} from "./gmail-client.js";

export interface FakeGmailClientOptions {
  /** Served by getThread and (per id) by batchGetThreads. */
  thread?: () => GmailThread;
  overrides?: Partial<GmailClient>;
}

const DEFAULT_PROFILE: GmailProfile = {
  emailAddress: "me@example.com",
  messagesTotal: 0,
  threadsTotal: 0,
  historyId: "h1",
};

const DEFAULT_DRAFT: GmailDraft = { id: "draft-1", message: { id: "m", threadId: "t" } };

export function fakeGmailClient(options: FakeGmailClientOptions = {}): GmailClient {
  const thread = options.thread ?? (() => ({ id: "thr-1", messages: [] }) as GmailThread);
  const client: GmailClient = {
    handle: vi.fn(async () => ({ credentialId: "cred-1", fetch: vi.fn() }) as never),
    getProfile: vi.fn(async () => DEFAULT_PROFILE),
    listSendAs: vi.fn(async () => [
      { sendAsEmail: "me@example.com", isDefault: true, isPrimary: true },
    ]),
    listLabels: vi.fn(async () => []),
    createLabel: vi.fn(async () => ({ id: "Label_1", name: "Created" })),
    updateLabel: vi.fn(async () => ({ id: "Label_1", name: "Updated" })),
    deleteLabel: vi.fn(async () => undefined),
    listMessages: vi.fn(async () => ({ messages: [] as GmailMessage[] })),
    listThreads: vi.fn(async () => ({ threads: [] })),
    search: vi.fn(async () => ({ messages: [] as GmailMessage[] })),
    listHistory: vi.fn(async () => ({ historyId: "h1" })),
    syncSince: vi.fn(async () => ({
      historyId: "h1",
      rawHistory: { historyId: "h1", history: [] },
      threads: [],
    })),
    watch: vi.fn(async () => ({ historyId: "h1", expiration: Date.now() + 7 * 24 * 3600 * 1000 })),
    stopWatch: vi.fn(async () => undefined),
    getMessage: vi.fn(async () => ({ id: "m1", threadId: "thr-1" }) as GmailMessage),
    getThread: vi.fn(async () => thread()),
    batchGetMessages: vi.fn(
      async (ids: string[]): Promise<Array<GmailBatchItem<GmailMessage>>> =>
        ids.map((id) => ({ id, value: { id, threadId: "thr-1" } as GmailMessage }))
    ),
    batchGetThreads: vi.fn(
      async (ids: string[]): Promise<Array<GmailBatchItem<GmailThread>>> =>
        ids.map((id) => ({ id, value: thread() }))
    ),
    batchModify: vi.fn(async () => undefined),
    getAttachment: vi.fn(async () => ({ size: 0, data: "" })),
    sendMessage: vi.fn(async () => ({ id: "sent-1", threadId: "thr-1" }) as GmailMessage),
    createDraft: vi.fn(async () => DEFAULT_DRAFT),
    listDrafts: vi.fn(async () => ({ drafts: [] })),
    getDraft: vi.fn(async () => DEFAULT_DRAFT),
    updateDraft: vi.fn(async () => DEFAULT_DRAFT),
    deleteDraft: vi.fn(async () => undefined),
    sendDraft: vi.fn(async () => ({ id: "sent-draft", threadId: "thr-1" }) as GmailMessage),
    modifyLabels: vi.fn(async () => ({}) as GmailMessage),
    searchContacts: vi.fn(async () => []),
    searchOtherContacts: vi.fn(async () => []),
  };
  return { ...client, ...options.overrides };
}
