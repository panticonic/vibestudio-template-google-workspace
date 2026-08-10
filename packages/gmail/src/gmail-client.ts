import type { CredentialClient, UrlCredentialHandle } from "@workspace/runtime/credentials";
import { bindingAudience, googleWorkspaceCredential } from "@workspace/google-workspace/providers";

import { BatchHttpError, executeBatch, type BatchPart, type BatchPartResult } from "./batch.js";

const GMAIL_API_PATH_PREFIX = "/gmail/v1/users/me";
const GMAIL_API_BASE = `https://gmail.googleapis.com${GMAIL_API_PATH_PREFIX}`;
const PEOPLE_API_BASE = "https://people.googleapis.com/v1";

export type GmailApiErrorCode =
  | "auth-expired"
  | "credential-missing"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "invalid-request"
  | "network"
  | "server";

export type GmailResourceKind = "thread" | "message" | "draft" | "history" | "label" | "profile";

/**
 * Typed Gmail API failure. Every Gmail call failure surfaces as one of these
 * so callers branch on `code` (pause polling on auth-expired, back off on
 * rate-limited, reconcile caches on not-found) instead of regex-matching
 * error strings.
 */
export class GmailApiError extends Error {
  constructor(
    message: string,
    public readonly code: GmailApiErrorCode,
    public readonly opts: {
      status?: number;
      retryAfterMs?: number;
      resource?: GmailResourceKind;
    } = {}
  ) {
    super(message);
    this.name = "GmailApiError";
  }

  get status(): number | undefined {
    return this.opts.status;
  }
  get retryAfterMs(): number | undefined {
    return this.opts.retryAfterMs;
  }
  get resource(): GmailResourceKind | undefined {
    return this.opts.resource;
  }
}

export function isGmailApiError(err: unknown, code?: GmailApiErrorCode): err is GmailApiError {
  return err instanceof GmailApiError && (code === undefined || err.code === code);
}

function resourceFromPath(path: string): GmailResourceKind | undefined {
  if (path.startsWith("/threads")) return "thread";
  if (path.startsWith("/messages")) return "message";
  if (path.startsWith("/drafts")) return "draft";
  if (path.startsWith("/history")) return "history";
  if (path.startsWith("/labels")) return "label";
  if (path.startsWith("/profile")) return "profile";
  return undefined;
}

function classifyHttpFailure(
  status: number,
  bodyText: string
): { code: GmailApiErrorCode; retryAfterMs?: number } {
  if (status === 401) return { code: "auth-expired" };
  if (status === 403) {
    // Gmail reports quota problems as 403 with a rateLimitExceeded reason.
    return /rateLimitExceeded|userRateLimitExceeded|quota/i.test(bodyText)
      ? { code: "rate-limited" }
      : { code: "forbidden" };
  }
  if (status === 404) return { code: "not-found" };
  if (status === 429) return { code: "rate-limited" };
  if (status >= 500) return { code: "server" };
  return { code: "invalid-request" };
}

function httpFailureToError(
  status: number,
  statusText: string,
  bodyText: string,
  opts: { retryAfterHeader: string | null; resource?: GmailResourceKind }
): GmailApiError {
  const { code } = classifyHttpFailure(status, bodyText);
  const retryAfterMs =
    code === "rate-limited" &&
    opts.retryAfterHeader &&
    Number.isFinite(Number(opts.retryAfterHeader))
      ? Number(opts.retryAfterHeader) * 1000
      : undefined;
  return new GmailApiError(
    `Gmail API request failed: ${status} ${statusText}${bodyText ? ` - ${bodyText.slice(0, 500)}` : ""}`,
    code,
    {
      status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(opts.resource ? { resource: opts.resource } : {}),
    }
  );
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessageBody {
  size?: number;
  data?: string;
  attachmentId?: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailMessageBody;
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  raw?: string;
  payload?: GmailMessagePart;
  [key: string]: unknown;
}

export interface GmailThread {
  id: string;
  historyId?: string;
  messages?: GmailMessage[];
  [key: string]: unknown;
}

export interface GmailDraft {
  id: string;
  message: GmailMessage;
  [key: string]: unknown;
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
  messageListVisibility?: string;
  labelListVisibility?: string;
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
  color?: {
    textColor?: string;
    backgroundColor?: string;
  };
  [key: string]: unknown;
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
  [key: string]: unknown;
}

/** Send-as alias from GET /settings/sendAs. `signature` is HTML. */
export interface GmailSendAsAlias {
  sendAsEmail: string;
  displayName?: string;
  signature?: string;
  isDefault?: boolean;
  isPrimary?: boolean;
  [key: string]: unknown;
}

export interface GmailHistoryMessageRef {
  id: string;
  threadId: string;
}

export interface GmailHistoryEntry {
  id: string;
  messages?: GmailHistoryMessageRef[];
  messagesAdded?: Array<{ message: GmailMessage }>;
  messagesDeleted?: Array<{ message: GmailHistoryMessageRef }>;
  labelsAdded?: Array<{ message: GmailHistoryMessageRef; labelIds?: string[] }>;
  labelsRemoved?: Array<{ message: GmailHistoryMessageRef; labelIds?: string[] }>;
}

export interface GmailHistoryResponse {
  history?: GmailHistoryEntry[];
  historyId: string;
  nextPageToken?: string;
  [key: string]: unknown;
}

export type GmailHistoryType = "messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved";

export interface ListHistoryOptions {
  startHistoryId: string;
  maxResults?: number;
  labelId?: string;
  historyTypes?: GmailHistoryType[];
}

export interface WatchParams {
  /** Cloud Pub/Sub topic, e.g. "projects/my-proj/topics/gmail-push". */
  topicName: string;
  labelIds?: string[];
  labelFilterBehavior?: "include" | "exclude";
}

export interface WatchResult {
  historyId: string;
  /** Epoch ms (the API returns a string). */
  expiration: number;
}

export interface ListMessagesOptions {
  maxResults?: number;
  labelIds?: string[];
  q?: string;
  pageToken?: string;
  format?: "full" | "metadata" | "minimal" | "raw";
  metadataHeaders?: string[];
}

export interface GetMessageOptions {
  format?: "full" | "metadata" | "minimal" | "raw";
  metadataHeaders?: string[];
}

export interface GetThreadOptions extends GetMessageOptions {}

export interface ListMessagesResult {
  messages: GmailMessage[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface ListThreadsOptions {
  q?: string;
  labelIds?: string[];
  maxResults?: number;
  pageToken?: string;
}

export interface GmailThreadRef {
  id: string;
  snippet?: string;
  historyId?: string;
}

export interface ListThreadsResult {
  threads: GmailThreadRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface SendMessageParams {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string | string[];
  bcc?: string | string[];
  from?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string | string[];
  headers?: Record<string, string>;
  threadId?: string;
}

export interface CreateDraftParams extends SendMessageParams {}

export interface ModifyLabelsParams {
  messageId?: string;
  threadId?: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

export interface BatchModifyParams {
  /** Message ids (max 1000 per Gmail API call). */
  messageIds: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

export interface CreateLabelParams {
  name: string;
  labelListVisibility?: "labelShow" | "labelShowIfUnread" | "labelHide";
  messageListVisibility?: "show" | "hide";
  color?: { textColor?: string; backgroundColor?: string };
}

export interface GmailAttachmentBody {
  size: number;
  /** base64url-encoded bytes. */
  data: string;
  [key: string]: unknown;
}

export interface ListDraftsResult {
  drafts: GmailDraft[];
  nextPageToken?: string;
}

/** Per-item result of a batched fetch: exactly one of value/error is set. */
export interface GmailBatchItem<T> {
  id: string;
  value?: T;
  error?: GmailApiError;
}

export interface GmailThreadDiff {
  threadId: string;
  messagesAdded: GmailMessage[];
  messagesDeleted: GmailHistoryMessageRef[];
  labelsAdded: Array<{ message: GmailHistoryMessageRef; labelIds: string[] }>;
  labelsRemoved: Array<{ message: GmailHistoryMessageRef; labelIds: string[] }>;
}

export interface GmailSyncDiff {
  historyId: string;
  rawHistory: GmailHistoryResponse;
  threads: GmailThreadDiff[];
}

/** Normalized People API search result (person flattened per email address). */
export interface GoogleContact {
  email: string;
  displayName?: string;
}

export interface SearchContactsOptions {
  pageSize?: number;
}

interface PeopleSearchResponse {
  results?: Array<{
    person?: {
      names?: Array<{ displayName?: string }>;
      emailAddresses?: Array<{ value?: string }>;
    };
  }>;
}

function normalizeContactResults(data: PeopleSearchResponse): GoogleContact[] {
  const seen = new Map<string, GoogleContact>();
  for (const result of data.results ?? []) {
    const person = result.person ?? {};
    const displayName = person.names?.find((name) => name.displayName)?.displayName;
    for (const address of person.emailAddresses ?? []) {
      if (!address.value) continue;
      const email = address.value.toLowerCase();
      if (!seen.has(email)) seen.set(email, { email, ...(displayName ? { displayName } : {}) });
    }
  }
  return [...seen.values()];
}

export interface GmailClient {
  handle(): Promise<UrlCredentialHandle>;
  getProfile(): Promise<GmailProfile>;
  listSendAs(): Promise<GmailSendAsAlias[]>;
  listLabels(): Promise<GmailLabel[]>;
  createLabel(params: CreateLabelParams): Promise<GmailLabel>;
  updateLabel(labelId: string, params: Partial<CreateLabelParams>): Promise<GmailLabel>;
  deleteLabel(labelId: string): Promise<void>;
  listMessages(opts?: ListMessagesOptions): Promise<ListMessagesResult>;
  /** True thread-level listing (GET /threads) — refs only, no hydration. */
  listThreads(opts?: ListThreadsOptions): Promise<ListThreadsResult>;
  search(q: string, opts?: Omit<ListMessagesOptions, "q">): Promise<ListMessagesResult>;
  listHistory(opts: ListHistoryOptions): Promise<GmailHistoryResponse>;
  syncSince(historyId: string): Promise<GmailSyncDiff>;
  /** Start (or renew) push notifications to a Cloud Pub/Sub topic. */
  watch(params: WatchParams): Promise<WatchResult>;
  /** Stop push notifications for this mailbox. */
  stopWatch(): Promise<void>;
  getMessage(messageId: string, opts?: GetMessageOptions): Promise<GmailMessage>;
  getThread(threadId: string, opts?: GetThreadOptions): Promise<GmailThread>;
  /** Batched GET /messages/{id} via the multipart batch endpoint. */
  batchGetMessages(
    messageIds: string[],
    opts?: GetMessageOptions
  ): Promise<Array<GmailBatchItem<GmailMessage>>>;
  /** Batched GET /threads/{id} via the multipart batch endpoint. */
  batchGetThreads(
    threadIds: string[],
    opts?: GetThreadOptions
  ): Promise<Array<GmailBatchItem<GmailThread>>>;
  /** Native POST /messages/batchModify (≤1000 ids, returns no body). */
  batchModify(params: BatchModifyParams): Promise<void>;
  getAttachment(messageId: string, attachmentId: string): Promise<GmailAttachmentBody>;
  sendMessage(params: SendMessageParams): Promise<GmailMessage>;
  createDraft(params: CreateDraftParams): Promise<GmailDraft>;
  listDrafts(opts?: {
    maxResults?: number;
    pageToken?: string;
    q?: string;
  }): Promise<ListDraftsResult>;
  getDraft(draftId: string): Promise<GmailDraft>;
  updateDraft(draftId: string, params: CreateDraftParams): Promise<GmailDraft>;
  deleteDraft(draftId: string): Promise<void>;
  sendDraft(draftId: string): Promise<GmailMessage>;
  modifyLabels(params: ModifyLabelsParams): Promise<GmailMessage | GmailThread>;
  searchContacts(query: string, opts?: SearchContactsOptions): Promise<GoogleContact[]>;
  searchOtherContacts(query: string, opts?: SearchContactsOptions): Promise<GoogleContact[]>;
}

function toQueryParams(params?: Record<string, string | number | string[] | undefined>): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "undefined") continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item);
    } else {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

function sanitizeHeaderValue(field: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Gmail sendMessage: ${field} value contains CR/LF - header injection rejected`);
  }
  return value;
}

function sanitizeHeaderName(name: string): string {
  if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) {
    throw new Error(`Gmail sendMessage: invalid header name "${name}"`);
  }
  return name;
}

function joinAddressList(value?: string | string[]): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function buildRawMessage(params: SendMessageParams): string {
  const f = (field: string, value: string): string => sanitizeHeaderValue(field, value);
  const rawLines = [
    params.from ? `From: ${f("From", params.from)}` : undefined,
    `To: ${f("To", joinAddressList(params.to) ?? "")}`,
    params.cc ? `Cc: ${f("Cc", joinAddressList(params.cc) ?? "")}` : undefined,
    params.bcc ? `Bcc: ${f("Bcc", joinAddressList(params.bcc) ?? "")}` : undefined,
    params.replyTo ? `Reply-To: ${f("Reply-To", params.replyTo)}` : undefined,
    params.inReplyTo ? `In-Reply-To: ${f("In-Reply-To", params.inReplyTo)}` : undefined,
    params.references
      ? `References: ${f("References", joinAddressList(params.references) ?? "")}`
      : undefined,
    `Subject: ${f("Subject", params.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    ...Object.entries(params.headers ?? {}).map(([key, value]) => {
      const safeKey = sanitizeHeaderName(key);
      return `${safeKey}: ${f(safeKey, value)}`;
    }),
    "",
    params.body,
  ].filter((line): line is string => typeof line === "string");
  return encodeBase64Url(rawLines.join("\r\n"));
}

function appendThread<T extends { raw: string }>(
  payload: T,
  threadId?: string
): T & { threadId?: string } {
  return threadId ? { ...payload, threadId } : payload;
}

function emptyThreadDiff(threadId: string): GmailThreadDiff {
  return {
    threadId,
    messagesAdded: [],
    messagesDeleted: [],
    labelsAdded: [],
    labelsRemoved: [],
  };
}

function aggregateHistoryByThread(history: GmailHistoryResponse): GmailThreadDiff[] {
  const byThread = new Map<string, GmailThreadDiff>();
  const get = (threadId: string): GmailThreadDiff => {
    let diff = byThread.get(threadId);
    if (!diff) {
      diff = emptyThreadDiff(threadId);
      byThread.set(threadId, diff);
    }
    return diff;
  };

  for (const entry of history.history ?? []) {
    for (const added of entry.messagesAdded ?? []) {
      if (added.message?.threadId) get(added.message.threadId).messagesAdded.push(added.message);
    }
    for (const deleted of entry.messagesDeleted ?? []) {
      if (deleted.message?.threadId)
        get(deleted.message.threadId).messagesDeleted.push(deleted.message);
    }
    for (const added of entry.labelsAdded ?? []) {
      if (added.message?.threadId) {
        get(added.message.threadId).labelsAdded.push({
          message: added.message,
          labelIds: added.labelIds ?? [],
        });
      }
    }
    for (const removed of entry.labelsRemoved ?? []) {
      if (removed.message?.threadId) {
        get(removed.message.threadId).labelsRemoved.push({
          message: removed.message,
          labelIds: removed.labelIds ?? [],
        });
      }
    }
  }

  return [...byThread.values()];
}

export function createGmailClient(
  credentials: CredentialClient,
  opts: { credentialId?: string } = {}
): GmailClient {
  let handlePromise: Promise<UrlCredentialHandle> | null = null;
  const handle = (): Promise<UrlCredentialHandle> => {
    if (!handlePromise) {
      const p = credentials.forAudience({
        ...bindingAudience(googleWorkspaceCredential, "google-gmail", opts),
        ...(opts.credentialId ? { credentialId: opts.credentialId } : {}),
      });
      p.catch(() => {
        if (handlePromise === p) handlePromise = null;
      });
      handlePromise = p;
    }
    return handlePromise;
  };

  // Absolute-URL fetch shared by the Gmail and People API surfaces. Returns
  // the ok Response; non-2xx and transport failures throw GmailApiError.
  const fetchRaw = async (
    url: string,
    init?: RequestInit,
    resource?: GmailResourceKind
  ): Promise<Response> => {
    let auth: UrlCredentialHandle;
    try {
      auth = await handle();
    } catch (err) {
      throw new GmailApiError(
        `Gmail credential unavailable: ${err instanceof Error ? err.message : String(err)}`,
        "credential-missing",
        { ...(resource ? { resource } : {}) }
      );
    }
    const headers = new Headers(init?.headers);
    headers.set("Accept", "application/json");
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    let response: Response;
    try {
      response = await auth.fetch(url, { ...init, headers });
    } catch (err) {
      throw new GmailApiError(
        `Gmail API request failed: ${err instanceof Error ? err.message : String(err)}`,
        "network",
        { ...(resource ? { resource } : {}) }
      );
    }
    if (!response.ok) {
      const bodyText = await response.text();
      throw httpFailureToError(response.status, response.statusText, bodyText, {
        retryAfterHeader: response.headers.get("Retry-After"),
        ...(resource ? { resource } : {}),
      });
    }
    return response;
  };

  const fetchJson = async <T>(
    url: string,
    init?: RequestInit,
    resource?: GmailResourceKind
  ): Promise<T> => {
    const response = await fetchRaw(url, init, resource);
    return (await response.json()) as T;
  };

  const apiFetch = <T>(path: string, init?: RequestInit): Promise<T> =>
    fetchJson<T>(`${GMAIL_API_BASE}${path}`, init, resourceFromPath(path));

  /** Like apiFetch for endpoints that return 204/empty bodies. */
  const apiFetchVoid = async (path: string, init?: RequestInit): Promise<void> => {
    await fetchRaw(`${GMAIL_API_BASE}${path}`, init, resourceFromPath(path));
  };

  // ── batch ──────────────────────────────────────────────────────────────────

  const runBatch = async (parts: BatchPart[]): Promise<Map<string, BatchPartResult>> => {
    try {
      return await executeBatch((url, init) => fetchRaw(url, init), parts);
    } catch (err) {
      // fetchRaw already classifies whole-batch HTTP failures into
      // GmailApiError; BatchHttpError only escapes for malformed responses.
      if (err instanceof BatchHttpError) {
        throw httpFailureToError(err.status, err.message, err.bodyText, {
          retryAfterHeader: null,
        });
      }
      throw err;
    }
  };

  const batchPartError = (part: BatchPartResult, resource: GmailResourceKind): GmailApiError => {
    const { code } = classifyHttpFailure(part.status, part.bodyText);
    return new GmailApiError(
      `Gmail batch item failed: ${part.status}${part.bodyText ? ` - ${part.bodyText.slice(0, 300)}` : ""}`,
      code,
      { status: part.status, resource }
    );
  };

  const batchGet = async <T>(
    collection: "messages" | "threads",
    ids: string[],
    opts?: GetMessageOptions
  ): Promise<Array<GmailBatchItem<T>>> => {
    if (ids.length === 0) return [];
    const query = toQueryParams({
      format: opts?.format,
      metadataHeaders: opts?.metadataHeaders,
    });
    const parts: BatchPart[] = ids.map((id, index) => ({
      id: `item-${index}`,
      method: "GET",
      path: `${GMAIL_API_PATH_PREFIX}/${collection}/${encodeURIComponent(id)}${query}`,
    }));
    const results = await runBatch(parts);
    const resource: GmailResourceKind = collection === "messages" ? "message" : "thread";
    return ids.map((id, index) => {
      const part = results.get(`item-${index}`);
      if (!part) {
        return {
          id,
          error: new GmailApiError(`Gmail batch item missing from response: ${id}`, "server", {
            resource,
          }),
        };
      }
      if (!part.ok) return { id, error: batchPartError(part, resource) };
      return { id, value: part.json as T };
    });
  };

  // The People search endpoints need a warmup request (empty query) to prime
  // the search cache per Google docs; fire it once per client, best-effort.
  let peopleWarmupPromise: Promise<void> | null = null;
  const warmupPeopleSearch = (): Promise<void> => {
    if (!peopleWarmupPromise) {
      peopleWarmupPromise = Promise.allSettled([
        fetchJson(
          `${PEOPLE_API_BASE}/people:searchContacts${toQueryParams({ query: "", readMask: "names,emailAddresses" })}`
        ),
        fetchJson(
          `${PEOPLE_API_BASE}/otherContacts:search${toQueryParams({ query: "", readMask: "names,emailAddresses" })}`
        ),
      ]).then(() => undefined);
    }
    return peopleWarmupPromise;
  };

  const searchPeople = async (
    endpoint: "people:searchContacts" | "otherContacts:search",
    query: string,
    opts?: SearchContactsOptions
  ): Promise<GoogleContact[]> => {
    await warmupPeopleSearch();
    const data = await fetchJson<PeopleSearchResponse>(
      `${PEOPLE_API_BASE}/${endpoint}${toQueryParams({
        query,
        readMask: "names,emailAddresses",
        pageSize: opts?.pageSize ?? 10,
      })}`
    );
    return normalizeContactResults(data);
  };

  const listHistory = async (opts: ListHistoryOptions): Promise<GmailHistoryResponse> => {
    let pageToken: string | undefined;
    const combined: GmailHistoryResponse = { historyId: opts.startHistoryId };
    do {
      const page = await apiFetch<GmailHistoryResponse>(
        `/history${toQueryParams({
          startHistoryId: opts.startHistoryId,
          maxResults: opts.maxResults,
          labelId: opts.labelId,
          historyTypes: opts.historyTypes,
          pageToken,
        })}`
      );
      combined.historyId = page.historyId;
      combined.history = [...(combined.history ?? []), ...(page.history ?? [])];
      pageToken = page.nextPageToken;
    } while (pageToken);
    return combined;
  };

  const getMessage = async (messageId: string, opts?: GetMessageOptions): Promise<GmailMessage> => {
    const query = toQueryParams({
      format: opts?.format,
      metadataHeaders: opts?.metadataHeaders,
    });
    return apiFetch<GmailMessage>(`/messages/${encodeURIComponent(messageId)}${query}`);
  };

  const getThread = async (threadId: string, opts?: GetThreadOptions): Promise<GmailThread> => {
    const query = toQueryParams({
      format: opts?.format,
      metadataHeaders: opts?.metadataHeaders,
    });
    return apiFetch<GmailThread>(`/threads/${encodeURIComponent(threadId)}${query}`);
  };

  const listMessages = async (opts?: ListMessagesOptions): Promise<ListMessagesResult> => {
    const { format = "full", metadataHeaders, ...query } = opts ?? {};
    const data = await apiFetch<{
      messages?: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>(`/messages${toQueryParams(query)}`);

    if (!data.messages?.length) {
      return {
        messages: [],
        nextPageToken: data.nextPageToken,
        resultSizeEstimate: data.resultSizeEstimate,
      };
    }

    // One multipart batch call instead of N sequential GETs. Preserve the old
    // all-or-nothing contract: any per-item failure fails the whole list.
    const items = await batchGet<GmailMessage>(
      "messages",
      data.messages.map((message) => message.id),
      { format, metadataHeaders }
    );
    const messages: GmailMessage[] = [];
    for (const item of items) {
      if (item.error) throw item.error;
      messages.push(item.value!);
    }
    return {
      messages,
      nextPageToken: data.nextPageToken,
      resultSizeEstimate: data.resultSizeEstimate,
    };
  };

  const sendMessage = async (params: SendMessageParams): Promise<GmailMessage> =>
    apiFetch<GmailMessage>("/messages/send", {
      method: "POST",
      body: JSON.stringify(appendThread({ raw: buildRawMessage(params) }, params.threadId)),
    });

  return {
    handle,
    getProfile: () => apiFetch<GmailProfile>("/profile"),
    listSendAs: async () => {
      const data = await apiFetch<{ sendAs?: GmailSendAsAlias[] }>("/settings/sendAs");
      return data.sendAs ?? [];
    },
    listLabels: async () => {
      const data = await apiFetch<{ labels?: GmailLabel[] }>("/labels");
      return data.labels ?? [];
    },
    createLabel: (params) =>
      apiFetch<GmailLabel>("/labels", { method: "POST", body: JSON.stringify(params) }),
    updateLabel: (labelId, params) =>
      apiFetch<GmailLabel>(`/labels/${encodeURIComponent(labelId)}`, {
        method: "PUT",
        body: JSON.stringify(params),
      }),
    deleteLabel: (labelId) =>
      apiFetchVoid(`/labels/${encodeURIComponent(labelId)}`, { method: "DELETE" }),
    listMessages,
    listThreads: async (opts) => {
      const data = await apiFetch<{
        threads?: GmailThreadRef[];
        nextPageToken?: string;
        resultSizeEstimate?: number;
      }>(
        `/threads${toQueryParams({
          q: opts?.q,
          labelIds: opts?.labelIds,
          maxResults: opts?.maxResults,
          pageToken: opts?.pageToken,
        })}`
      );
      return {
        threads: data.threads ?? [],
        nextPageToken: data.nextPageToken,
        resultSizeEstimate: data.resultSizeEstimate,
      };
    },
    search: (q, opts) => listMessages({ ...opts, q }),
    listHistory,
    syncSince: async (historyId) => {
      const rawHistory = await listHistory({
        startHistoryId: historyId,
        historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
      });
      return {
        historyId: rawHistory.historyId,
        rawHistory,
        threads: aggregateHistoryByThread(rawHistory),
      };
    },
    watch: async (params) => {
      const data = await apiFetch<{ historyId: string; expiration: string }>("/watch", {
        method: "POST",
        body: JSON.stringify({
          topicName: params.topicName,
          ...(params.labelIds ? { labelIds: params.labelIds } : {}),
          ...(params.labelFilterBehavior
            ? { labelFilterBehavior: params.labelFilterBehavior.toUpperCase() }
            : {}),
        }),
      });
      return { historyId: data.historyId, expiration: Number(data.expiration) };
    },
    stopWatch: () => apiFetchVoid("/stop", { method: "POST" }),
    getMessage,
    getThread,
    batchGetMessages: (messageIds, opts) => batchGet<GmailMessage>("messages", messageIds, opts),
    batchGetThreads: (threadIds, opts) => batchGet<GmailThread>("threads", threadIds, opts),
    batchModify: async (params) => {
      if (params.messageIds.length === 0) return;
      if (params.messageIds.length > 1000) {
        throw new Error("Gmail batchModify accepts at most 1000 message ids per call");
      }
      await apiFetchVoid("/messages/batchModify", {
        method: "POST",
        body: JSON.stringify({
          ids: params.messageIds,
          addLabelIds: params.addLabelIds ?? [],
          removeLabelIds: params.removeLabelIds ?? [],
        }),
      });
    },
    getAttachment: (messageId, attachmentId) =>
      apiFetch<GmailAttachmentBody>(
        `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
      ),
    sendMessage,
    createDraft: (params) =>
      apiFetch<GmailDraft>("/drafts", {
        method: "POST",
        body: JSON.stringify({
          message: appendThread({ raw: buildRawMessage(params) }, params.threadId),
        }),
      }),
    listDrafts: async (opts) => {
      const data = await apiFetch<{ drafts?: GmailDraft[]; nextPageToken?: string }>(
        `/drafts${toQueryParams({ maxResults: opts?.maxResults, pageToken: opts?.pageToken, q: opts?.q })}`
      );
      return { drafts: data.drafts ?? [], nextPageToken: data.nextPageToken };
    },
    getDraft: (draftId) => apiFetch<GmailDraft>(`/drafts/${encodeURIComponent(draftId)}`),
    updateDraft: (draftId, params) =>
      apiFetch<GmailDraft>(`/drafts/${encodeURIComponent(draftId)}`, {
        method: "PUT",
        body: JSON.stringify({
          message: appendThread({ raw: buildRawMessage(params) }, params.threadId),
        }),
      }),
    deleteDraft: (draftId) =>
      apiFetchVoid(`/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" }),
    sendDraft: async (draftId) => {
      return apiFetch<GmailMessage>("/drafts/send", {
        method: "POST",
        body: JSON.stringify({ id: draftId }),
      });
    },
    modifyLabels: (params) => {
      if (params.messageId && params.threadId) {
        throw new Error("modifyLabels accepts messageId or threadId, not both");
      }
      const id = params.messageId ?? params.threadId;
      if (!id) throw new Error("modifyLabels requires messageId or threadId");
      const collection = params.threadId ? "threads" : "messages";
      return apiFetch<GmailMessage | GmailThread>(
        `/${collection}/${encodeURIComponent(id)}/modify`,
        {
          method: "POST",
          body: JSON.stringify({
            addLabelIds: params.addLabelIds ?? [],
            removeLabelIds: params.removeLabelIds ?? [],
          }),
        }
      );
    },
    searchContacts: (query, opts) => searchPeople("people:searchContacts", query, opts),
    searchOtherContacts: (query, opts) => searchPeople("otherContacts:search", query, opts),
  };
}
