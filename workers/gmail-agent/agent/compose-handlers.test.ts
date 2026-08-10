import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeHandlers } from "./compose-handlers.js";
import type { GmailHandlersDeps } from "./handlers.js";

/**
 * Build a ComposeHandlers over a minimal fake deps surface. Only the methods
 * the send/draft paths touch are implemented; everything else is a no-op stub.
 * `gmail` and `sync`/`sendAs` overrides let each test inject failure modes.
 */
function makeHandlers(opts: {
  sendMessage?: () => Promise<{ id: string }>;
  modifyLabels?: () => Promise<unknown>;
  validateFrom?: (from: string) => Promise<string>;
  applyLocalThreadFlags?: ReturnType<typeof vi.fn>;
  refreshThread?: ReturnType<typeof vi.fn>;
  fromAliases?: boolean;
}): { handlers: ComposeHandlers; applyLocalThreadFlags: ReturnType<typeof vi.fn> } {
  const applyLocalThreadFlags = opts.applyLocalThreadFlags ?? vi.fn(async () => undefined);
  const refreshThread = opts.refreshThread ?? vi.fn(async () => ({}));
  const composeStore = new Map<string, Record<string, unknown>>();

  const gmail = {
    sendMessage: opts.sendMessage ?? (async () => ({ id: "sent-1" })),
    modifyLabels: opts.modifyLabels ?? (async () => ({})),
    getThread: async () => ({ id: "thr-1", messages: [] }),
    createDraft: async () => ({ id: "draft-1" }),
    updateDraft: async () => ({ id: "draft-1" }),
  } as never;

  const deps = {
    gmailFor: () => gmail,
    cards: {
      updateCompose: vi.fn(async (_c: string, id: string, patch: Record<string, unknown>) => {
        composeStore.set(id, { ...(composeStore.get(id) ?? {}), ...patch });
      }),
      createCompose: vi.fn(async () => ({ messageId: "cmp-1" })),
      composeByMessageId: () => null,
    },
    sendAs: {
      defaultSignature: async () => "",
      fromOptions: async () => [],
      validateFrom:
        opts.validateFrom ??
        (async (_c: string, from: string) => {
          if (opts.fromAliases) {
            throw new Error(`from address is not a configured send-as alias: ${from}`);
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

  return { handlers: new ComposeHandlers(deps), applyLocalThreadFlags };
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
    const { handlers, applyLocalThreadFlags } = makeHandlers({});
    const result = await handlers.send("ch-1", SEND_ARGS);

    expect(result).toMatchObject({ sent: true, id: "sent-1" });
    expect((result as { archiveWarning?: string }).archiveWarning).toBeUndefined();
    expect(applyLocalThreadFlags).toHaveBeenCalledWith(
      "ch-1",
      "thr-1",
      expect.objectContaining({ inInbox: false, status: "archived" })
    );
  });

  it("does NOT write the local archived flag when the Gmail archive fails, and surfaces a warning", async () => {
    const { handlers, applyLocalThreadFlags } = makeHandlers({
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
    expect((result as { archiveWarning?: string }).archiveWarning).toContain("archive boom");
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
    const { handlers } = makeHandlers({ fromAliases: true });
    await expect(
      handlers.draftMail("ch-1", {
        mode: "new",
        to: "you@example.com",
        subject: "Hi",
        body: "Body",
        from: "spoofed@evil.com",
      })
    ).rejects.toThrow(/not a configured send-as alias/);
  });
});
