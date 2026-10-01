import {
  isGmailApiError,
  type GmailMessage,
  type GmailThread,
  type SendMessageParams,
} from "@workspace/gmail";
import type {
  GmailComposeCardState,
  GmailContactCandidate,
} from "@workspace/gmail/card-types";
import type { failureResult } from "../errors.js";
import { failGmailOperation } from "./error-policy.js";
import type { GmailHandlersDeps } from "./handlers.js";
import { appendSignature } from "./sendas-cache.js";
import {
  METADATA_HEADERS,
  header,
  latestMessage,
  parseAddressList,
} from "../sync/thread-model.js";
import { booleanArg, record, stringArg } from "../types.js";

/**
 * Compose / draft / send operations on top of compose cards. Split from
 * GmailHandlers purely for size; both share the deps object and the
 * failGmailOperation error policy.
 */
export class ComposeHandlers {
  constructor(private readonly deps: GmailHandlersDeps) {}

  private failGmail(channelId: string, operation: string, err: unknown) {
    return failGmailOperation(this.deps, channelId, operation, err);
  }

  /**
   * Send-as extras for a new compose card: the default signature is appended
   * to the body NOW (visible during review — never silently at send time),
   * and the alias list becomes a From picker when there is more than one.
   */
  private async composeCardExtras(
    channelId: string,
    body: string | undefined,
  ): Promise<{ body?: string; fromOptions?: string[] }> {
    const [signature, fromOptions] = await Promise.all([
      this.deps.sendAs.defaultSignature(channelId).catch(() => ""),
      this.deps.sendAs.fromOptions(channelId).catch(() => [] as string[]),
    ]);
    return {
      ...(body ? { body: appendSignature(body, signature) } : {}),
      ...(fromOptions.length > 1 ? { fromOptions } : {}),
    };
  }

  /** Validate an explicit From against the alias list (throws on unknown). */
  private async resolveFrom(
    channelId: string,
    args: Record<string, unknown>,
  ): Promise<string | undefined> {
    const from = stringArg(args, "from");
    if (!from) return undefined;
    return this.deps.sendAs.validateFrom(channelId, from);
  }

  /**
   * Unified draft entry point. mode "reply" pre-resolves recipient/subject
   * from the thread; mode "new" composes fresh. Always lands on a compose
   * card: "review" when the body is present, "drafting" when incomplete.
   * saveToGmail additionally persists a Gmail draft (updating, not
   * duplicating, on re-save).
   */
  async draftMail(
    channelId: string,
    args: Record<string, unknown>,
  ): Promise<
    | {
        messageId: string;
        status: "review" | "drafting";
        draftId?: string;
        note?: string;
      }
    | ReturnType<typeof failureResult>
  > {
    const mode = stringArg(args, "mode") === "reply" ? "reply" : "new";
    const threadId = stringArg(args, "threadId");
    if (mode === "reply" && !threadId)
      throw new Error("draft mode reply requires threadId");
    const body = stringArg(args, "body");
    let to = stringArg(args, "to");
    let subject = stringArg(args, "subject");

    if (mode === "reply") {
      try {
        const reply = await this.replyContext(channelId, threadId!);
        subject ??= reply.subject;
        to ??= reply.to;
      } catch (err) {
        return await this.failGmail(channelId, "draft", err);
      }
    }

    const complete = Boolean(to && subject && body);
    const extras = await this.composeCardExtras(channelId, body);
    // Validate an explicit From against the alias list. An invalid alias is a
    // hard error — never silently fall back to the default sender (the send
    // path does not swallow this either; keep the two consistent).
    let from: string | undefined;
    try {
      from = await this.resolveFrom(channelId, args);
    } catch (err) {
      return await this.failGmail(channelId, "draft", err);
    }
    const cardState: GmailComposeCardState = {
      ...(to ? { to } : {}),
      cc: stringArg(args, "cc"),
      bcc: stringArg(args, "bcc"),
      ...(from ? { from } : {}),
      ...(subject ? { subject } : {}),
      ...(body ? { body } : {}),
      ...extras,
      ...(threadId ? { threadId, sourceThreadId: threadId } : {}),
      // Agent-generated drafts always land in review; the user's Send click
      // on the compose card is the authorization to send.
      status: complete ? "review" : "drafting",
      ...(candidatesArg(args) ? { toCandidates: candidatesArg(args) } : {}),
    };
    const existingCardId = stringArg(args, "composeCardId");
    let messageId: string;
    if (
      existingCardId &&
      this.deps.cards.composeByMessageId(channelId, existingCardId)
    ) {
      await this.deps.cards.withCompose(channelId, existingCardId, async () => {
        this.assertEditable(
          this.deps.cards.composeState(channelId, existingCardId),
        );
        await this.deps.cards.updateCompose(
          channelId,
          existingCardId,
          cardState,
        );
      });
      messageId = existingCardId;
    } else {
      const handle = await this.deps.cards.createCompose(channelId, cardState);
      messageId = handle.messageId;
    }

    let draftId: string | undefined;
    if (booleanArg(args, "saveToGmail")) {
      const saved = await this.saveDraft(channelId, { messageId });
      if ("error" in saved) return saved;
      if ("draftId" in saved) draftId = saved.draftId;
    }
    return {
      messageId,
      status: complete ? "review" : "drafting",
      ...(draftId ? { draftId } : {}),
      ...(complete
        ? {}
        : {
            note: "Draft is incomplete — the compose card is in drafting state with recipient autocomplete; resolve contacts with gmail_contacts if needed.",
          }),
    };
  }

  async compose(
    channelId: string,
    args: Record<string, unknown>,
  ): Promise<{ messageId: string }> {
    const extras = await this.composeCardExtras(
      channelId,
      stringArg(args, "body"),
    );
    const threadId = stringArg(args, "threadId");
    const reply = threadId
      ? await this.replyContext(channelId, threadId)
      : undefined;
    const from = await this.resolveFrom(channelId, args);
    const state: GmailComposeCardState = {
      to: stringArg(args, "to") ?? reply?.to,
      cc: stringArg(args, "cc"),
      bcc: stringArg(args, "bcc"),
      subject: stringArg(args, "subject") ?? reply?.subject,
      body: stringArg(args, "body"),
      ...extras,
      threadId,
      sourceThreadId: stringArg(args, "sourceThreadId"),
      ...(from ? { from } : {}),
      status: "drafting",
      ...(candidatesArg(args) ? { toCandidates: candidatesArg(args) } : {}),
    };
    const handle = await this.deps.cards.createCompose(channelId, state);
    return { messageId: handle.messageId };
  }

  /**
   * Multi-agent draft request: produce a compose card in "review" without
   * sending. Only the user's Send click (or an explicit user instruction to
   * this agent) ever sends mail.
   */
  async requestDraft(
    channelId: string,
    args: Record<string, unknown>,
  ): Promise<
    { messageId: string; status: "review" } | ReturnType<typeof failureResult>
  > {
    const threadId = stringArg(args, "threadId");
    if (threadId) {
      const result = await this.draftReply(channelId, { threadId });
      if ("error" in result) return result;
      return { messageId: result.messageId, status: "review" };
    }
    const intent = stringArg(args, "intent");
    if (!intent) throw new Error("requestDraft requires threadId or intent");
    const handle = await this.deps.cards.createCompose(channelId, {
      to: stringArg(args, "to"),
      subject: stringArg(args, "subject"),
      body: intent,
      status: "review",
    });
    return { messageId: handle.messageId, status: "review" };
  }

  /**
   * No-model-turn reply drafting (thread card / action bar button): one-shot
   * LLM writes the body. The agent's own turns use gmail_draft and write the
   * body themselves.
   */
  async draftReply(
    channelId: string,
    args: Record<string, unknown>,
  ): Promise<
    { messageId: string; body: string } | ReturnType<typeof failureResult>
  > {
    const threadId = stringArg(args, "threadId");
    if (!threadId) throw new Error("draftReply requires threadId");
    let thread: GmailThread;
    try {
      const gmail = this.deps.gmailFor(channelId);
      thread = await gmail.getThread(threadId, { format: "full" });
    } catch (err) {
      return await this.failGmail(channelId, "draftReply", err);
    }
    const latest = latestMessage(thread);
    const subject = header(latest ?? ({} as GmailMessage), "Subject") ?? "";
    const to = header(latest ?? ({} as GmailMessage), "From") ?? "";
    const generated = await this.deps.generateDraftReplyBody(channelId, thread);
    const extras = await this.composeCardExtras(channelId, generated);
    const body = extras.body ?? generated;
    const handle = await this.deps.cards.createCompose(channelId, {
      to,
      subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
      body,
      ...(extras.fromOptions ? { fromOptions: extras.fromOptions } : {}),
      threadId,
      sourceThreadId: threadId,
      status: "review",
      ...(candidatesArg(args) ? { toCandidates: candidatesArg(args) } : {}),
    });
    return { messageId: handle.messageId, body };
  }

  private async replyContext(channelId: string, threadId: string) {
    const thread = await this.deps.gmailFor(channelId).getThread(threadId, {
      format: "metadata",
      metadataHeaders: METADATA_HEADERS,
    });
    const latest = latestMessage(thread);
    const subject = header(latest ?? ({} as GmailMessage), "Subject") ?? "";
    return {
      to: header(latest ?? ({} as GmailMessage), "From") ?? "",
      subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
      inReplyTo: header(latest ?? ({} as GmailMessage), "Message-ID"),
      references:
        header(latest ?? ({} as GmailMessage), "References") ??
        header(latest ?? ({} as GmailMessage), "Message-ID"),
    };
  }

  private composeId(args: Record<string, unknown>): string {
    const id = stringArg(args, "messageId");
    if (!id)
      throw new Error(
        "messageId is required. Create a compose with gmail_draft first.",
      );
    return id;
  }

  private assertEditable(state: GmailComposeCardState): void {
    if (
      [
        "sending",
        "delivery-unknown",
        "saving",
        "discarding",
        "sent",
        "discarded",
      ].includes(state.status)
    ) {
      throw new Error(
        `Compose is ${state.status}. Check its result before changing it.`,
      );
    }
  }

  private editedState(
    state: GmailComposeCardState,
    args: Record<string, unknown>,
  ): GmailComposeCardState {
    const next = { ...state };
    for (const key of ["to", "cc", "bcc", "from", "subject", "body"] as const) {
      if (typeof args[key] === "string") next[key] = args[key];
    }
    return next;
  }

  private async messageParams(
    channelId: string,
    state: GmailComposeCardState,
    sending: boolean,
  ): Promise<SendMessageParams> {
    const context = state.threadId
      ? await this.replyContext(channelId, state.threadId)
      : undefined;
    const reply = {
      to: state.to ?? "",
      subject: state.subject ?? "",
      cc: state.cc,
      bcc: state.bcc,
      ...(state.threadId
        ? {
            threadId: state.threadId,
            inReplyTo: context?.inReplyTo,
            references: context?.references,
          }
        : {}),
    };
    if (
      sending &&
      (!reply.to.trim() || !reply.subject.trim() || !state.body?.trim())
    ) {
      throw new Error(
        "Recipient, subject, and body are required before sending.",
      );
    }
    const from = await this.resolveFrom(channelId, { ...state });
    return {
      ...reply,
      ...(from ? { from } : {}),
      body: state.body ?? "",
      headers: { "Message-ID": state.rfcMessageId! },
    };
  }

  /** A projection failure never changes the committed external outcome. */
  private async projectResult(
    channelId: string,
    messageId: string,
  ): Promise<string | undefined> {
    try {
      await this.deps.cards.publishCompose(channelId, messageId);
    } catch (error) {
      return `Card update failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return undefined;
  }

  async send(channelId: string, args: Record<string, unknown>) {
    const messageId = this.composeId(args);
    return this.deps.cards.withCompose(channelId, messageId, async () => {
      const current = this.deps.cards.composeState(channelId, messageId);
      if (current.status === "sent" && current.sentMessageId) {
        const warning = await this.projectResult(channelId, messageId);
        return {
          sent: true as const,
          id: current.sentMessageId,
          ...(warning ? { warning } : {}),
        };
      }
      this.assertEditable(current);
      const edited = this.editedState(current, args);
      // Validate before claiming an external operation. No request has happened yet.
      const params = await this.messageParams(channelId, edited, true);
      this.deps.cards.recordCompose(channelId, messageId, {
        ...edited,
        status: "sending",
        error: "",
      });
      await this.projectResult(channelId, messageId);
      const gmail = this.deps.gmailFor(channelId);
      let sent: GmailMessage;
      try {
        sent = current.draftId
          ? await gmail.sendDraft(current.draftId, params)
          : await gmail.sendMessage(params);
        if (!sent || typeof sent.id !== "string" || !sent.id.trim())
          throw new Error(
            "Gmail accepted the request without a readable delivery receipt. Check Sent before sending again.",
          );
      } catch (error) {
        // Only a definite rejection makes sending editable again. Transport,
        // server, and unreadable successful responses do not prove rejection.
        const rejected =
          isGmailApiError(error) && !["network", "server"].includes(error.code);
        this.deps.cards.recordCompose(channelId, messageId, {
          status: rejected ? "error" : "delivery-unknown",
          error: error instanceof Error ? error.message : String(error),
        });
        await this.projectResult(channelId, messageId);
        return this.failGmail(channelId, "send", error);
      }
      // Commit the receipt before projecting cards or updating local indexes.
      // If storage itself fails, the already committed sending state still
      // fences retries and retains the MIME identity for reconciliation.
      this.deps.cards.recordCompose(channelId, messageId, {
        status: "sent",
        sentMessageId: sent.id,
        draftId: undefined,
        error: "",
      });
      const warnings: string[] = [];
      const projectionWarning = await this.projectResult(channelId, messageId);
      if (projectionWarning) warnings.push(projectionWarning);
      try {
        const recipients = parseAddressList([
          String(params.to),
          String(params.cc ?? ""),
          String(params.bcc ?? ""),
        ]);
        for (const email of recipients) {
          this.deps.store.recordRepliedSender(channelId, email, email, "send");
          this.deps.people.markReplied(channelId, email);
        }
        this.deps.people.recordOutgoing(
          channelId,
          parseAddressList([String(params.to), String(params.cc ?? "")]).map(
            (email) => ({ email }),
          ),
          this.deps.now(),
        );
      } catch (error) {
        warnings.push(
          `Sent, but contact history could not be updated: ${String(error)}`,
        );
      }
      const sourceThreadId = current.sourceThreadId ?? current.threadId;
      let archiveWarning: string | undefined;
      if (sourceThreadId) {
        try {
          await gmail.modifyLabels({
            threadId: sourceThreadId,
            removeLabelIds: ["INBOX"],
          });
          await this.deps.sync.applyLocalThreadFlags(
            channelId,
            sourceThreadId,
            {
              inInbox: false,
              actionable: false,
              status: "archived",
            },
          );
        } catch (error) {
          archiveWarning = `Reply sent, but archiving the thread failed: ${error instanceof Error ? error.message : String(error)}`;
          console.warn("[gmail-agent] post-send archive failed", error);
        }
        try {
          await this.deps.sync.refreshThread(
            channelId,
            sourceThreadId,
            this.deps.getChannelState(channelId).emailAddress,
          );
        } catch (error) {
          warnings.push(
            `Sent, but refreshing the conversation failed: ${String(error)}`,
          );
        }
      }
      return {
        sent: true as const,
        id: sent.id,
        ...(archiveWarning ? { archiveWarning } : {}),
        ...(warnings.length ? { warning: warnings.join("\n") } : {}),
      };
    });
  }

  async saveDraft(channelId: string, args: Record<string, unknown>) {
    const messageId = this.composeId(args);
    return this.deps.cards.withCompose(channelId, messageId, async () => {
      const current = this.deps.cards.composeState(channelId, messageId);
      this.assertEditable(current);
      // A saved revision needs its own MIME identity: finding an older draft
      // after a lost update response does not prove that the new edits arrived.
      const edited = {
        ...this.editedState(current, args),
        rfcMessageId: `<${crypto.randomUUID()}@vibestudio.local>`,
      };
      const params = await this.messageParams(channelId, edited, false);
      this.deps.cards.recordCompose(channelId, messageId, {
        ...edited,
        status: "saving",
        error: "",
      });
      await this.projectResult(channelId, messageId);
      let draft;
      try {
        const gmail = this.deps.gmailFor(channelId);
        draft = current.draftId
          ? await gmail.updateDraft(current.draftId, params)
          : await gmail.createDraft(params);
        if (!draft || typeof draft.id !== "string" || !draft.id.trim())
          throw new Error(
            "Gmail accepted the request without a readable draft receipt. Check Drafts before saving again.",
          );
      } catch (error) {
        // An unknown create result cannot be retried without duplicating a draft.
        const rejected =
          isGmailApiError(error) && !["network", "server"].includes(error.code);
        this.deps.cards.recordCompose(channelId, messageId, {
          status: rejected ? "error" : "saving",
          error: String(error),
        });
        await this.projectResult(channelId, messageId);
        return this.failGmail(channelId, "saveDraft", error);
      }
      this.deps.cards.recordCompose(channelId, messageId, {
        status: "saved",
        draftId: draft.id,
        error: "",
      });
      const warning = await this.projectResult(channelId, messageId);
      return {
        saved: true as const,
        draftId: draft.id,
        ...(warning ? { warning } : {}),
      };
    });
  }

  async checkCompose(channelId: string, args: Record<string, unknown>) {
    const messageId = this.composeId(args);
    return this.deps.cards.withCompose(channelId, messageId, async () => {
      const state = this.deps.cards.composeState(channelId, messageId);
      const gmail = this.deps.gmailFor(channelId);
      if (state.status === "sending" || state.status === "delivery-unknown") {
        if (!state.rfcMessageId)
          throw new Error(
            "Delivery is unresolved and has no retained message identity. Inspect Gmail Sent before composing another message.",
          );
        const found = await gmail.search(
          `in:sent rfc822msgid:${state.rfcMessageId}`,
          { maxResults: 1 },
        );
        if (found.messages[0])
          this.deps.cards.recordCompose(channelId, messageId, {
            status: "sent",
            sentMessageId: found.messages[0].id,
            draftId: undefined,
            error: "",
          });
        else
          this.deps.cards.recordCompose(channelId, messageId, {
            status: "delivery-unknown",
            error:
              "Gmail has not confirmed delivery. Check Sent and check again before composing another message.",
          });
      } else if (state.status === "saving") {
        const found = await gmail.listDrafts({
          q: `rfc822msgid:${state.rfcMessageId}`,
          maxResults: 2,
        });
        if (found.drafts.length === 1)
          this.deps.cards.recordCompose(channelId, messageId, {
            status: "saved",
            draftId: found.drafts[0]!.id,
            error: "",
          });
        else
          this.deps.cards.recordCompose(channelId, messageId, {
            error:
              "Gmail has not confirmed this draft. Check Drafts and check again before creating another draft.",
          });
      }
      await this.deps.cards.publishCompose(channelId, messageId);
      return this.deps.cards.composeState(channelId, messageId);
    });
  }

  async discardCompose(channelId: string, args: Record<string, unknown>) {
    const messageId = this.composeId(args);
    return this.deps.cards.withCompose(channelId, messageId, async () => {
      const state = this.deps.cards.composeState(channelId, messageId);
      if (state.status === "discarded") return { discarded: true as const };
      if (state.status !== "discarding") this.assertEditable(state);
      this.deps.cards.recordCompose(channelId, messageId, {
        status: "discarding",
        error: "",
      });
      await this.projectResult(channelId, messageId);
      if (state.draftId) {
        try {
          await this.deps.gmailFor(channelId).deleteDraft(state.draftId);
        } catch (error) {
          if (!isGmailApiError(error, "not-found")) {
            this.deps.cards.recordCompose(channelId, messageId, {
              error: String(error),
            });
            await this.projectResult(channelId, messageId);
            throw error;
          }
        }
      }
      this.deps.cards.recordCompose(channelId, messageId, {
        status: "discarded",
        draftId: undefined,
        error: "",
      });
      const warning = await this.projectResult(channelId, messageId);
      return { discarded: true as const, ...(warning ? { warning } : {}) };
    });
  }
}

/** Sanitize an agent-supplied toCandidates array for compose card state. */
export function candidatesArg(
  args: Record<string, unknown>,
): GmailContactCandidate[] | undefined {
  const raw = args["toCandidates"];
  if (!Array.isArray(raw)) return undefined;
  const candidates = raw
    .map((item) => record(item))
    .filter((item) => typeof item["email"] === "string" && item["email"])
    .map((item) => ({
      email: String(item["email"]).toLowerCase(),
      ...(typeof item["displayName"] === "string" && item["displayName"]
        ? { displayName: item["displayName"] }
        : {}),
      sentTo: typeof item["sentTo"] === "number" ? item["sentTo"] : 0,
      receivedFrom:
        typeof item["receivedFrom"] === "number" ? item["receivedFrom"] : 0,
      ...(typeof item["lastInteractionAt"] === "number"
        ? { lastInteractionAt: item["lastInteractionAt"] }
        : {}),
      youReplied: item["youReplied"] === true,
      source:
        item["source"] === "google-contacts"
          ? ("google-contacts" as const)
          : ("history" as const),
      score: typeof item["score"] === "number" ? item["score"] : 0,
    }));
  return candidates.length > 0 ? candidates : undefined;
}
