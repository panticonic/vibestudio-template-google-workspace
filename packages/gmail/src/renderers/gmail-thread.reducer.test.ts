import { describe, expect, it } from "vitest";

import { reduce, type GmailThreadState } from "./gmail-thread.reducer.js";

describe("gmail.thread reducer", () => {
  it("folds message, label, draft, and status updates", () => {
    const initial: GmailThreadState = {
      threadId: "t1",
      subject: "Subject",
      participants: ["a@example.com"],
      lastSnippet: "Old",
      unreadCount: 1,
      hasDraft: false,
      status: "unread",
    };

    const withMessage = reduce(initial, {
      kind: "newMessage",
      message: { id: "m2", snippet: "New" },
    });
    const withLabels = reduce(withMessage, {
      kind: "labelChange",
      labelIds: ["INBOX"],
      unreadCount: 0,
      category: "TODO",
    });
    const withDraft = reduce(withLabels, { kind: "draftSet", draftBody: "Reply" });
    const archived = reduce(withDraft, { kind: "statusChange", status: "archived" });

    expect(archived).toMatchObject({
      lastSnippet: "New",
      unreadCount: 0,
      category: "TODO",
      hasDraft: true,
      status: "archived",
      messages: [{ id: "m2", snippet: "New" }],
    });
  });
});
