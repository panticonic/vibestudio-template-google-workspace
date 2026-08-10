/**
 * The thread renderer inlines a copy of the package reducer (sandbox
 * renderers must be self-contained at runtime). This test makes the
 * "keep in sync" comment enforceable: both copies must produce identical
 * states over a representative update sequence.
 */
import { describe, expect, it } from "vitest";
import {
  reduce as packageReduce,
  type GmailThreadState,
  type GmailThreadUpdate,
} from "@workspace/gmail/renderers/gmail-thread.reducer";
import { reduce as rendererReduce } from "./gmail-thread";

const INITIAL: GmailThreadState = {
  threadId: "thr-1",
  subject: "Question",
  participants: ["a@example.com"],
  lastSnippet: "first",
  unreadCount: 1,
  hasDraft: false,
  status: "unread",
};

const UPDATES: GmailThreadUpdate[] = [
  {
    kind: "newMessage",
    message: { id: "m2", from: "b@example.com", snippet: "second" },
    lastSnippet: "second",
    unreadCount: 2,
  },
  { kind: "newMessage", message: { id: "m3", snippet: "third" } },
  { kind: "labelChange", labelIds: ["INBOX"], unreadCount: 0, category: "Primary" },
  { kind: "draftSet", draftBody: "draft text" },
  { kind: "statusChange", status: "archived" },
  // Archived threads reopen on new mail.
  { kind: "newMessage", message: { id: "m4", snippet: "fourth" } },
  { kind: "draftSet", draftBody: "" },
  // Plain merge patches (no kind) are last-write-wins.
  { subject: "Question (edited)", unreadCount: 5 } as unknown as GmailThreadUpdate,
  { kind: "statusChange", status: "open" },
];

describe("gmail-thread reducer parity", () => {
  it("the inlined renderer reducer matches the package reducer step by step", () => {
    let packageState = INITIAL;
    let rendererState = INITIAL;
    UPDATES.forEach((update, index) => {
      packageState = packageReduce(packageState, update);
      rendererState = rendererReduce(rendererState, update);
      expect(rendererState, `diverged after update #${index} (${JSON.stringify(update)})`).toEqual(
        packageState
      );
    });
  });
});
