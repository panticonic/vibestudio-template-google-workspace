import { describe, expect, it } from "vitest";
import type { GmailMessage, GmailThread } from "@workspace/gmail";
import {
  attentionEventFromThread,
  categoryFromLabels,
  normalizeEmailAddress,
  parseAddressList,
  searchResultCardState,
  threadCardFromRow,
  threadCardState,
} from "./thread-model.js";

function message(
  id: string,
  threadId: string,
  headers: Record<string, string>,
  labelIds = ["INBOX", "UNREAD"],
  snippet = "snippet"
): GmailMessage {
  return {
    id,
    threadId,
    labelIds,
    snippet,
    internalDate: "1750000000000",
    payload: {
      mimeType: "text/plain",
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
    },
  };
}

const baseHeaders = {
  Subject: "Hello",
  From: "Alice <a@example.com>",
  To: "me@example.com",
};

describe("thread-model", () => {
  it("maps Gmail category labels", () => {
    expect(categoryFromLabels(new Set(["CATEGORY_PROMOTIONS"]))).toBe("Promotions");
    expect(categoryFromLabels(new Set(["INBOX"]))).toBeUndefined();
  });

  it("normalizes email addresses and address lists", () => {
    expect(normalizeEmailAddress("Alice <A@Example.com>")).toBe("a@example.com");
    expect(parseAddressList("a@x.com, Bob <B@Y.org>")).toEqual(["a@x.com", "b@y.org"]);
  });

  it("computes actionable thread card state for unread primary mail addressed to the user", () => {
    const thread: GmailThread = {
      id: "thr-1",
      messages: [message("m1", "thr-1", baseHeaders)],
    };
    const card = threadCardState(thread, undefined, "me@example.com");
    expect(card).toMatchObject({
      threadId: "thr-1",
      subject: "Hello",
      unread: true,
      inInbox: true,
      actionable: true,
      status: "unread",
    });
  });

  it("excludes promotional categories and mail not addressed to the user", () => {
    const promo: GmailThread = {
      id: "thr-2",
      messages: [message("m1", "thr-2", baseHeaders, ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"])],
    };
    expect(threadCardState(promo, undefined, "me@example.com").actionable).toBe(false);

    const notMine: GmailThread = {
      id: "thr-3",
      messages: [message("m1", "thr-3", { ...baseHeaders, To: "other@example.com" })],
    };
    expect(threadCardState(notMine, undefined, "me@example.com").actionable).toBe(false);
  });

  it("marks attention-woken threads actionable even outside default heuristics", () => {
    const promo: GmailThread = {
      id: "thr-4",
      messages: [message("m1", "thr-4", baseHeaders, ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"])],
    };
    const card = threadCardState(promo, undefined, "me@example.com", {
      wake: true,
      directiveId: "x",
      directiveName: "X",
    });
    expect(card.actionable).toBe(true);
    expect(card.attention?.directiveId).toBe("x");
  });

  it("builds attention events from threads", () => {
    const thread: GmailThread = {
      id: "thr-5",
      messages: [message("m1", "thr-5", baseHeaders)],
    };
    expect(attentionEventFromThread(thread, "me@example.com")).toMatchObject({
      threadId: "thr-5",
      from: "Alice <a@example.com>",
      subject: "Hello",
      unread: true,
      inInbox: true,
      addressedToUser: true,
      hasAttachment: false,
    });
  });

  it("converts stored rows and search results to card states", () => {
    expect(
      threadCardFromRow({
        channel_id: "ch-1",
        thread_id: "thr-6",
        subject: "S",
        from_addr: "a@example.com",
        snippet: "snip",
        unread: 1,
        in_inbox: 1,
        actionable: 1,
        category: "urgent",
        updated_at: 5,
      })
    ).toMatchObject({ threadId: "thr-6", status: "unread", category: "urgent", actionable: true });

    expect(searchResultCardState(message("m1", "thr-7", baseHeaders, ["INBOX"]))).toMatchObject({
      threadId: "thr-7",
      status: "open",
      actionable: false,
    });
  });
});
