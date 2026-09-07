/**
 * Workerd-native Codex Responses web search.
 *
 * This is the transport seam from pi-codex-search, adapted to Vibestudio's
 * host-mediated credential fetcher. Raw OAuth tokens never enter the agent
 * isolate; the caller supplies a fetcher already bound to the active Codex
 * credential and this module supplies only the public request protocol.
 *
 * Protocol reference: https://github.com/Leechael/pi-codex-search (MIT)
 */

import { readResponseEvents, type CodexSession } from "../codex-responses.js";

export type CodexSearchContextSize = "low" | "medium" | "high";
export type CodexSearchFreshness = "cached" | "indexed" | "live";

export type CodexSearchSession = CodexSession;

export interface CodexCitation {
  title?: string;
  url: string;
  startIndex?: number;
  endIndex?: number;
}

export interface CodexSearchCall {
  id?: string;
  status?: string;
  query?: string;
  url?: string;
  actionType?: string;
}

export interface CodexSearchResult {
  query: string;
  model: string;
  text: string;
  citations: CodexCitation[];
  searchCalls: CodexSearchCall[];
  responseId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

interface ResponseOutputText {
  type?: string;
  text?: string;
  annotations?: Array<{
    type?: string;
    title?: string;
    url?: string;
    start_index?: number;
    end_index?: number;
  }>;
}

interface ResponseOutputItem {
  id?: string;
  type?: string;
  status?: string;
  role?: string;
  action?: { type?: string; query?: string; queries?: string[]; url?: string };
  content?: ResponseOutputText[];
}

interface ResponseEventData {
  response?: {
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
  };
  item?: ResponseOutputItem;
  delta?: string;
  error?: { message?: string; code?: string };
}

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

export async function searchWithCodex(input: {
  query: string;
  session: CodexSearchSession;
  freshness: CodexSearchFreshness;
  searchContextSize: CodexSearchContextSize;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
}): Promise<CodexSearchResult> {
  const { query, session, freshness, searchContextSize, signal, onTextDelta } =
    input;
  const headers = new Headers({
    accept: "text/event-stream",
    "content-type": "application/json",
    "chatgpt-account-id": session.accountId,
    originator: "codex_cli_rs",
  });
  if (session.sessionId) {
    headers.set("session-id", session.sessionId);
    headers.set("thread-id", session.sessionId);
    headers.set("x-client-request-id", session.sessionId);
  }

  const webSearchTool: Record<string, unknown> = {
    type: "web_search",
    external_web_access: freshness !== "cached",
    search_context_size: searchContextSize,
  };
  if (freshness === "indexed") webSearchTool["indexed_web_access"] = true;

  const response = await session.fetcher(CODEX_RESPONSES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: session.model,
      instructions:
        "You are a concise web search assistant. Use web search, answer the query, and preserve source citations from annotations.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: query }],
        },
      ],
      tools: [webSearchTool],
      tool_choice: "required",
      parallel_tool_calls: true,
      store: false,
      stream: true,
      include: [],
    }),
    signal,
  });

  if (!response.ok) {
    const body = (await response.text()).trim();
    throw new Error(
      `Codex web search failed: HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`,
    );
  }
  if (!response.body)
    throw new Error("Codex web search response did not include a body");

  let responseId: string | undefined;
  let usage:
    | { input_tokens?: number; output_tokens?: number; total_tokens?: number }
    | undefined;
  let streamedText = "";
  const messageText: string[] = [];
  const searchCalls = new Map<string, CodexSearchCall>();
  const citations: CodexCitation[] = [];

  for await (const event of readResponseEvents<ResponseEventData>(
    response.body,
  )) {
    const data = event.data;
    if (!data) continue;
    switch (event.type) {
      case "response.created":
        responseId = data.response?.id;
        break;
      case "response.output_text.delta":
        streamedText += data.delta ?? "";
        if (data.delta) onTextDelta?.(data.delta);
        break;
      case "response.output_item.added":
        if (data.item?.type === "web_search_call" && data.item.id) {
          searchCalls.set(data.item.id, {
            id: data.item.id,
            status: data.item.status,
          });
        }
        break;
      case "response.output_item.done":
        collectOutputItem(data.item, searchCalls, messageText, citations);
        break;
      case "response.completed":
        usage = data.response?.usage;
        break;
      case "response.failed":
        throw new Error(
          data.error?.message ?? data.error?.code ?? "Codex web search failed",
        );
    }
  }

  return {
    query,
    model: session.model,
    text: messageText.join("") || streamedText,
    citations,
    searchCalls: [...searchCalls.values()],
    ...(responseId ? { responseId } : {}),
    ...(usage
      ? {
          usage: {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            totalTokens: usage.total_tokens,
          },
        }
      : {}),
  };
}

function collectOutputItem(
  item: ResponseOutputItem | undefined,
  searchCalls: Map<string, CodexSearchCall>,
  messageText: string[],
  citations: CodexCitation[],
): void {
  if (!item) return;
  if (item.type === "web_search_call") {
    const key = item.id ?? `search-${searchCalls.size + 1}`;
    searchCalls.set(key, {
      ...(item.id ? { id: item.id } : {}),
      ...(item.status ? { status: item.status } : {}),
      ...(item.action?.query || item.action?.queries
        ? { query: item.action.query ?? item.action.queries?.join(", ") }
        : {}),
      ...(item.action?.url ? { url: item.action.url } : {}),
      ...(item.action?.type ? { actionType: item.action.type } : {}),
    });
    return;
  }
  if (item.type !== "message" || item.role !== "assistant") return;
  let textOffset = messageText.reduce(
    (length, text) => length + text.length,
    0,
  );
  for (const part of item.content ?? []) {
    if (part.type !== "output_text") continue;
    const partText = part.text ?? "";
    messageText.push(partText);
    for (const annotation of part.annotations ?? []) {
      if (annotation.type !== "url_citation" || !annotation.url) continue;
      citations.push({
        url: annotation.url,
        ...(annotation.title ? { title: annotation.title } : {}),
        ...(annotation.start_index !== undefined
          ? { startIndex: textOffset + annotation.start_index }
          : {}),
        ...(annotation.end_index !== undefined
          ? { endIndex: textOffset + annotation.end_index }
          : {}),
      });
    }
    textOffset += partText.length;
  }
}
