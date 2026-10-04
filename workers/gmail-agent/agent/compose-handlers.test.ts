import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardManager } from "@workspace/agentic-do";
import { createInMemorySql } from "@workspace/runtime/worker/test-utils";
import type { SqlStorage } from "@workspace/runtime/worker";
import { fakeGmailClient } from "@workspace/gmail/test-utils";
import { GmailApiError } from "@workspace/gmail";
import { GmailCards, GMAIL_MESSAGE_TYPES } from "../cards/cards.js";
import { ComposeHandlers } from "./compose-handlers.js";
import type { GmailHandlersDeps } from "./handlers.js";

/**
 * Build a ComposeHandlers over a minimal fake deps surface. Only the methods
 * the send/draft paths touch are implemented; everything else is a no-op stub.
 * `gmail` and `sync`/`sendAs` overrides let each test inject failure modes.
 */
async function makeHandlers(opts: {
  sendMessage?: () => Promise<{ id: string }>;
  modifyLabels?: () => Promise<unknown>;
  validateFrom?: (from: string) => Promise<string>;
  applyLocalThreadFlags?: ReturnType<typeof vi.fn>;
  refreshThread?: ReturnType<typeof vi.fn>;
  fromAliases?: boolean;
}) {
  const applyLocalThreadFlags =
    opts.applyLocalThreadFlags ?? vi.fn(async () => undefined);
  const refreshThread = opts.refreshThread ?? vi.fn(async () => ({}));
  const sql = (await createInMemorySql()) as unknown as SqlStorage;
  sql.exec("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  CardManager.createTables(sql);
  const publish = vi.fn(async () => ({ id: 1 }));
  const manager = new CardManager({
    sql,
    createChannelClient: () =>
      ({
        getMessageType: async (typeId: string) =>
          GMAIL_MESSAGE_TYPES.find((type) => type.typeId === typeId),
        publishAgenticEvent: publish,
      }) as never,
    getParticipantId: () => "gmail",
    getActor: () => ({ kind: "agent", id: "gmail", displayName: "Gmail" }),
    getAgentId: () => "gmail",
  });
  const cards = new GmailCards({ sql, cards: manager });
  cards.recoverCompose("ch-1", "cmp-1", { ...SEND_ARGS, status: "review" });
  const gmail = fakeGmailClient({
    overrides: {
      ...(opts.sendMessage ? { sendMessage: opts.sendMessage as never } : {}),
      ...(opts.modifyLabels
        ? { modifyLabels: opts.modifyLabels as never }
        : {}),
    },
  });

  const deps = {
    gmailFor: () => gmail,
    cards,
    sql,
    now: () => 42,
    sendAs: {
      defaultSignature: async () => "",
      fromOptions: async () => [],
      validateFrom:
        opts.validateFrom ??
        (async (_c: string, from: string) => {
          if (opts.fromAliases) {
            throw new Error(
              `from address is not a configured send-as alias: ${from}`,
            );
          }
          return from;
        }),
    },
    sync: {
      refreshThread,
      applyLocalThreadFlags,
    },
    store: {
      recordRepliedSender: () => undefined,
    },
    people: {
      markReplied: () => undefined,
      recordOutgoing: () => undefined,
    },
    getChannelState: () => ({ emailAddress: "me@example.com" }),
    saveChannelState: () => undefined,
    publishSetup: async () => undefined,
  } as unknown as GmailHandlersDeps;

  return {
    handlers: new ComposeHandlers(deps),
    deps,
    cards,
    manager,
    gmail,
    publish,
    applyLocalThreadFlags,
  };
}

const SEND_ARGS = {
  messageId: "cmp-1",
  to: "you@example.com",
  subject: "Re: Hi",
  body: "Hello back",
  threadId: "thr-1",
  sourceThreadId: "thr-1",
};

describe("ComposeHandlers.send post-send divergence (Finding 1)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("archives locally and returns no warning when the Gmail archive succeeds", async () => {
    const { handlers, applyLocalThreadFlags } = await makeHandlers({});
    const result = await handlers.send("ch-1", SEND_ARGS);

    expect(result).toMatchObject({ sent: true, id: "sent-1" });
    expect(
      (result as { archiveWarning?: string }).archiveWarning,
    ).toBeUndefined();
    expect(applyLocalThreadFlags).toHaveBeenCalledWith(
      "ch-1",
      "thr-1",
      expect.objectContaining({ inInbox: false, status: "archived" }),
    );
  });

  it("does NOT write the local archived flag when the Gmail archive fails, and surfaces a warning", async () => {
    const { handlers, applyLocalThreadFlags } = await makeHandlers({
      modifyLabels: async () => {
        throw new Error("archive boom");
      },
    });
    const result = await handlers.send("ch-1", SEND_ARGS);

    // The reply still sent.
    expect(result).toMatchObject({ sent: true, id: "sent-1" });
    // No silent divergence: local archived flag NOT written.
    expect(applyLocalThreadFlags).not.toHaveBeenCalled();
    // The failure is surfaced to the caller.
    expect((result as { archiveWarning?: string }).archiveWarning).toContain(
      "archive boom",
    );
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("ComposeHandlers.draftMail resolveFrom consistency (Finding 2)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces an invalid send-as alias instead of silently falling back to the default sender", async () => {
    // validateFrom for a non-Gmail Error → failGmailOperation rethrows it.
    const { handlers } = await makeHandlers({ fromAliases: true });
    await expect(
      handlers.draftMail("ch-1", {
        mode: "new",
        to: "you@example.com",
        subject: "Hi",
        body: "Body",
        from: "spoofed@evil.com",
      }),
    ).rejects.toThrow(/not a configured send-as alias/);
  });
});

describe("durable compose ownership", () => {
  it("retains an accepted send when bookkeeping or card publication fails, including after restart", async () => {
    const { handlers, deps, cards, manager, gmail, publish } =
      await makeHandlers({
        applyLocalThreadFlags: vi.fn(async () => {
          throw new Error("local index unavailable");
        }),
      });
    publish.mockRejectedValue(new Error("channel unavailable"));
    deps.store.recordRepliedSender = () => {
      throw new Error("contacts unavailable");
    };
    const first = await handlers.send("ch-1", SEND_ARGS);
    expect(first).toMatchObject({
      sent: true,
      id: "sent-1",
      warning: expect.stringContaining("contacts unavailable"),
    });
    expect(cards.composeState("ch-1", "cmp-1")).toMatchObject({
      status: "sent",
      sentMessageId: "sent-1",
    });
    const restarted = new ComposeHandlers({
      ...deps,
      cards: new GmailCards({ sql: deps.sql, cards: manager }),
    });
    await expect(restarted.send("ch-1", SEND_ARGS)).resolves.toMatchObject({
      sent: true,
      id: "sent-1",
    });
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("serializes simultaneous sends of one compose", async () => {
    let complete!: (value: { id: string; threadId: string }) => void;
    const send = vi.fn(
      () =>
        new Promise<{ id: string; threadId: string }>((resolve) => {
          complete = resolve;
        }),
    );
    const { handlers } = await makeHandlers({ sendMessage: send });
    const first = handlers.send("ch-1", SEND_ARGS);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const second = handlers.send("ch-1", SEND_ARGS);
    complete({ id: "accepted", threadId: "thr-1" });
    await expect(first).resolves.toMatchObject({ sent: true, id: "accepted" });
    await expect(second).resolves.toMatchObject({ sent: true, id: "accepted" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("persists saved edits, updates the owned draft, and consumes it atomically on send", async () => {
    const { handlers, cards, gmail } = await makeHandlers({});
    await handlers.saveDraft("ch-1", {
      messageId: "cmp-1",
      body: "Edited body",
      subject: "Edited subject",
    });
    expect(cards.composeState("ch-1", "cmp-1")).toMatchObject({
      body: "Edited body",
      subject: "Edited subject",
      status: "saved",
      draftId: "draft-1",
    });
    await handlers.saveDraft("ch-1", {
      messageId: "cmp-1",
      body: "Second edit",
      draftId: "unowned-draft",
    });
    expect(gmail.createDraft).toHaveBeenCalledTimes(1);
    expect(gmail.updateDraft).toHaveBeenCalledWith(
      "draft-1",
      expect.objectContaining({ body: "Second edit" }),
    );
    await handlers.send("ch-1", { messageId: "cmp-1", body: "Final edit" });
    expect(gmail.sendDraft).toHaveBeenCalledWith(
      "draft-1",
      expect.objectContaining({
        body: "Final edit",
        subject: "Edited subject",
      }),
    );
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(cards.composeState("ch-1", "cmp-1").draftId).toBeUndefined();
  });

  it("deletes a saved remote draft before completing discard and can resume a failed delete", async () => {
    const { handlers, cards, gmail } = await makeHandlers({});
    await handlers.saveDraft("ch-1", { messageId: "cmp-1" });
    vi.mocked(gmail.deleteDraft).mockRejectedValueOnce(new Error("offline"));
    await expect(
      handlers.discardCompose("ch-1", { messageId: "cmp-1" }),
    ).rejects.toThrow("offline");
    expect(cards.composeState("ch-1", "cmp-1")).toMatchObject({
      status: "discarding",
      draftId: "draft-1",
    });
    await handlers.discardCompose("ch-1", { messageId: "cmp-1" });
    expect(gmail.deleteDraft).toHaveBeenNthCalledWith(2, "draft-1");
    expect(cards.composeState("ch-1", "cmp-1")).toMatchObject({
      status: "discarded",
    });
  });

  it("keeps an ambiguous send fenced until Gmail confirms its retained MIME identity", async () => {
    const send = vi.fn(async () => {
      throw new GmailApiError("response lost", "network");
    });
    const { handlers, cards, gmail } = await makeHandlers({
      sendMessage: send,
    });
    await expect(handlers.send("ch-1", SEND_ARGS)).rejects.toThrow(
      "response lost",
    );
    expect(cards.composeState("ch-1", "cmp-1").status).toBe("delivery-unknown");
    await handlers.checkCompose("ch-1", { messageId: "cmp-1" });
    await expect(handlers.send("ch-1", SEND_ARGS)).rejects.toThrow(
      "delivery-unknown",
    );
    vi.mocked(gmail.search).mockResolvedValue({
      messages: [{ id: "accepted", threadId: "thr-1" }],
    });
    await handlers.checkCompose("ch-1", { messageId: "cmp-1" });
    await expect(handlers.send("ch-1", SEND_ARGS)).resolves.toMatchObject({
      sent: true,
      id: "accepted",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(gmail.search).toHaveBeenCalledWith(
      "in:sent rfc822msgid:<cmp-1@vibestudio.local>",
      { maxResults: 1 },
    );
  });

  it("fences an unreadable delivery receipt and reconciles using the retained MIME identity", async () => {
    const send = vi.fn(async () => ({}) as { id: string });
    const { handlers, cards, gmail } = await makeHandlers({
      sendMessage: send,
    });
    await expect(handlers.send("ch-1", SEND_ARGS)).rejects.toThrow(/receipt/);
    expect(cards.composeState("ch-1", "cmp-1").status).toBe("delivery-unknown");
    await expect(handlers.send("ch-1", SEND_ARGS)).rejects.toThrow(
      /delivery-unknown/,
    );
    expect(send).toHaveBeenCalledOnce();
    vi.mocked(gmail.search).mockResolvedValue({
      messages: [{ id: "accepted", threadId: "thr-1" }],
    });
    await handlers.checkCompose("ch-1", { messageId: "cmp-1" });
    expect(cards.composeState("ch-1", "cmp-1")).toMatchObject({
      status: "sent",
      sentMessageId: "accepted",
    });
  });

  it("retains sending ownership if persisting the accepted receipt fails", async () => {
    const send = vi.fn(async () => ({ id: "accepted" }));
    const { handlers, cards, gmail } = await makeHandlers({
      sendMessage: send,
    });
    const record = cards.recordCompose.bind(cards);
    const failing = vi
      .spyOn(cards, "recordCompose")
      .mockImplementation((channel, id, patch) => {
        if (patch.status === "sent") throw new Error("storage write failed");
        return record(channel, id, patch);
      });
    await expect(handlers.send("ch-1", SEND_ARGS)).rejects.toThrow(
      "storage write failed",
    );
    expect(cards.composeState("ch-1", "cmp-1").status).toBe("sending");
    await expect(handlers.send("ch-1", SEND_ARGS)).rejects.toThrow(/sending/);
    expect(send).toHaveBeenCalledOnce();
    failing.mockRestore();
    vi.mocked(gmail.search).mockResolvedValue({
      messages: [{ id: "accepted", threadId: "thr-1" }],
    });
    await handlers.checkCompose("ch-1", { messageId: "cmp-1" });
    await expect(handlers.send("ch-1", SEND_ARGS)).resolves.toMatchObject({
      sent: true,
      id: "accepted",
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("saves an incomplete compose in Gmail without requiring a recipient", async () => {
    const { handlers, cards, gmail } = await makeHandlers({});
    const compose = await handlers.compose("ch-1", {
      body: "Ideas to finish later",
    });
    await handlers.saveDraft("ch-1", { messageId: compose.messageId });
    expect(gmail.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "",
        subject: "",
        body: "Ideas to finish later",
      }),
    );
    expect(cards.composeState("ch-1", compose.messageId).status).toBe("saved");
  });
  it("preserves cleared reply fields in incomplete saved drafts and refuses to send them", async () => {
    const { handlers, cards, gmail } = await makeHandlers({});
    await handlers.saveDraft("ch-1", {
      messageId: "cmp-1",
      to: "",
      subject: "",
      body: "",
    });
    expect(gmail.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "",
        subject: "",
        body: "",
        threadId: "thr-1",
      }),
    );
    await expect(handlers.send("ch-1", { messageId: "cmp-1" })).rejects.toThrow(
      "required before sending",
    );
    expect(gmail.sendDraft).not.toHaveBeenCalled();
    expect(cards.composeState("ch-1", "cmp-1").status).toBe("saved");
  });

  it("does not confirm a newer saved revision from an older draft's MIME identity", async () => {
    const { handlers, cards, gmail } = await makeHandlers({});
    await handlers.saveDraft("ch-1", { messageId: "cmp-1" });
    const previous = cards.composeState("ch-1", "cmp-1").rfcMessageId;
    vi.mocked(gmail.updateDraft).mockRejectedValueOnce(
      new Error("Response lost"),
    );
    await expect(
      handlers.saveDraft("ch-1", { messageId: "cmp-1", body: "New revision" }),
    ).rejects.toThrow("Response lost");
    const identity = cards.composeState("ch-1", "cmp-1").rfcMessageId;
    expect(identity).not.toBe(previous);
    vi.mocked(gmail.listDrafts).mockResolvedValue({ drafts: [] });
    await handlers.checkCompose("ch-1", { messageId: "cmp-1" });
    expect(gmail.listDrafts).toHaveBeenCalledWith({
      q: `rfc822msgid:${identity}`,
      maxResults: 2,
    });
    expect(cards.composeState("ch-1", "cmp-1").status).toBe("saving");
    await expect(
      handlers.saveDraft("ch-1", { messageId: "cmp-1" }),
    ).rejects.toThrow("saving");
  });

  it("honors saveToGmail for an incomplete prepared draft", async () => {
    const { handlers, gmail } = await makeHandlers({});
    const draft = await handlers.draftMail("ch-1", {
      body: "Finish later",
      saveToGmail: true,
    });
    expect(draft).toMatchObject({ draftId: "draft-1" });
    expect(gmail.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ to: "", subject: "", body: "Finish later" }),
    );
  });
});
