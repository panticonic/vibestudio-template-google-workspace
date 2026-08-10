import type { GmailMessage, GmailThread } from "@workspace/gmail";
import type { GmailComposeCardState, GmailContactCandidate } from "@workspace/gmail/card-types";
import type { failureResult } from "../errors.js";
import { failGmailOperation } from "./error-policy.js";
import type { GmailHandlersDeps } from "./handlers.js";
import { appendSignature } from "./sendas-cache.js";
import { METADATA_HEADERS, header, latestMessage, parseAddressList } from "../sync/thread-model.js";
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
    body: string | undefined
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
    args: Record<string, unknown>
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
    args: Record<string, unknown>
  ): Promise<
    | { messageId: string; status: "review" | "drafting"; draftId?: string; note?: string }
    | ReturnType<typeof failureResult>
  > {
    const mode = stringArg(args, "mode") === "reply" ? "reply" : "new";
    const threadId = stringArg(args, "threadId");
    if (mode === "reply" && !threadId) throw new Error("draft mode reply requires threadId");
    const body = stringArg(args, "body");
    let to = stringArg(args, "to");
    let subject = stringArg(args, "subject");

    if (mode === "reply") {
      try {
        const gmail = this.deps.gmailFor(channelId);
        const thread = await gmail.getThread(threadId!, {
          format: "metadata",
          metadataHeaders: METADATA_HEADERS,
        });
        const latest = latestMessage(thread);
        const threadSubject = latest ? (header(latest, "Subject") ?? "") : "";
        subject =
          subject ?? (threadSubject.startsWith("Re:") ? threadSubject : `Re: ${threadSubject}`);
        to = to ?? (latest ? (header(latest, "From") ?? "") : "");
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
    if (existingCardId && this.deps.cards.composeByMessageId(channelId, existingCardId)) {
      await this.deps.cards.updateCompose(channelId, existingCardId, cardState);
      messageId = existingCardId;
    } else {
      const handle = await this.deps.cards.createCompose(channelId, cardState);
      messageId = handle.messageId;
    }

    let draftId: string | undefined;
    if (booleanArg(args, "saveToGmail") && complete) {
      const saved = await this.saveDraft(channelId, { ...args, to, subject, messageId });
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

  async compose(channelId: string, args: Record<string, unknown>): Promise<{ messageId: string }> {
    const extras = await this.composeCardExtras(channelId, stringArg(args, "body"));
    const state: GmailComposeCardState = {
      to: stringArg(args, "to"),
      cc: stringArg(args, "cc"),
      bcc: stringArg(args, "bcc"),
      subject: stringArg(args, "subject"),
      body: stringArg(args, "body"),
      ...extras,
      threadId: stringArg(args, "threadId"),
      sourceThreadId: stringArg(args, "sourceThreadId"),
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
    args: Record<string, unknown>
  ): Promise<{ messageId: string; status: "review" } | ReturnType<typeof failureResult>> {
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
    args: Record<string, unknown>
  ): Promise<{ messageId: string; body: string } | ReturnType<typeof failureResult>> {
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

  private async resolveReplySendArgs(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
  }> {
    const threadId = stringArg(args, "threadId");
    const explicitTo = stringArg(args, "to");
    const explicitSubject = stringArg(args, "subject");
    if (!threadId) {
      if (!explicitTo || !explicitSubject) throw new Error("send requires to and subject");
      return {
        to: explicitTo,
        ...(stringArg(args, "cc") ? { cc: stringArg(args, "cc") } : {}),
        ...(stringArg(args, "bcc") ? { bcc: stringArg(args, "bcc") } : {}),
        subject: explicitSubject,
      };
    }
    const gmail = this.deps.gmailFor(channelId);
    const thread = await gmail.getThread(threadId, {
      format: "metadata",
      metadataHeaders: METADATA_HEADERS,
    });
    const latest = latestMessage(thread);
    const threadSubject = header(latest ?? ({} as GmailMessage), "Subject") ?? "";
    const subject =
      explicitSubject ?? (threadSubject.startsWith("Re:") ? threadSubject : `Re: ${threadSubject}`);
    const to = explicitTo ?? header(latest ?? ({} as GmailMessage), "From") ?? "";
    if (!to || !subject) throw new Error("send could not resolve reply recipient and subject");
    return {
      to,
      ...(stringArg(args, "cc") ? { cc: stringArg(args, "cc") } : {}),
      ...(stringArg(args, "bcc") ? { bcc: stringArg(args, "bcc") } : {}),
      subject,
      threadId,
      inReplyTo: header(latest ?? ({} as GmailMessage), "Message-ID"),
      references:
        header(latest ?? ({} as GmailMessage), "References") ??
        header(latest ?? ({} as GmailMessage), "Message-ID"),
    };
  }

  async send(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<
    { sent: true; id: string; archiveWarning?: string } | ReturnType<typeof failureResult>
  > {
    const messageId = stringArg(args, "messageId");
    await this.deps.cards.updateCompose(channelId, messageId, { status: "sending" });
    try {
      const gmail = this.deps.gmailFor(channelId);
      const replyArgs = await this.resolveReplySendArgs(channelId, args);
      // Explicit From must be a configured send-as alias (Gmail rewrites
      // unknown ones silently — better to fail loudly at review time).
      const from = await this.resolveFrom(channelId, args);
      const sent = await gmail.sendMessage({
        to: replyArgs.to,
        ...(replyArgs.cc ? { cc: replyArgs.cc } : {}),
        ...(replyArgs.bcc ? { bcc: replyArgs.bcc } : {}),
        ...(from ? { from } : {}),
        subject: replyArgs.subject,
        body: stringArg(args, "body") ?? "",
        ...(replyArgs.threadId ? { threadId: replyArgs.threadId } : {}),
        ...(replyArgs.inReplyTo ? { inReplyTo: replyArgs.inReplyTo } : {}),
        ...(replyArgs.references ? { references: replyArgs.references } : {}),
      });
      for (const email of parseAddressList([replyArgs.to, replyArgs.cc ?? "", replyArgs.bcc ?? ""])) {
        this.deps.store.recordRepliedSender(channelId, email, email, "send");
        this.deps.people.markReplied(channelId, email);
      }
      this.deps.people.recordOutgoing(
        channelId,
        parseAddressList([replyArgs.to, replyArgs.cc ?? ""]).map((email) => ({ email })),
        Date.now()
      );
      await this.deps.cards.updateCompose(channelId, messageId, { status: "sent" });
      const sourceThreadId = stringArg(args, "sourceThreadId") ?? stringArg(args, "threadId");
      let archiveWarning: string | undefined;
      if (sourceThreadId) {
        // The reply is sent. The archive (remove INBOX) is a SEPARATE Gmail
        // call that can fail — if it does we must NOT mark the thread archived
        // locally, or local state silently diverges from Gmail (the thread is
        // still in the Gmail inbox and can re-trigger triage). Surface a
        // warning instead and leave the local flags untouched.
        let archived = false;
        try {
          await gmail.modifyLabels({ threadId: sourceThreadId, removeLabelIds: ["INBOX"] });
          archived = true;
        } catch (err) {
          archiveWarning =
            "Reply sent, but archiving the thread in Gmail failed: " +
            (err instanceof Error ? err.message : String(err));
          console.warn(
            `[gmail-agent] post-send archive failed channel=${channelId} thread=${sourceThreadId}:`,
            err
          );
        }
        await this.deps.sync
          .refreshThread(channelId, sourceThreadId, this.deps.getChannelState(channelId).emailAddress)
          .catch(() => undefined);
        // Only mirror the Gmail archive locally when it actually happened.
        if (archived) {
          await this.deps.sync.applyLocalThreadFlags(channelId, sourceThreadId, {
            inInbox: false,
            actionable: false,
            status: "archived",
          });
        }
      }
      return { sent: true, id: sent.id, ...(archiveWarning ? { archiveWarning } : {}) };
    } catch (err) {
      // Recoverable compose error: keep the card editable with an error badge.
      await this.deps.cards.updateCompose(channelId, messageId, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      return await this.failGmail(channelId, "send", err);
    }
  }

  async saveDraft(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<
    | { saved: true; draftId: string }
    | { ok: true; composeId: string; cardCreated: boolean; note: string }
    | ReturnType<typeof failureResult>
  > {
    const messageId = stringArg(args, "messageId");
    // Forgiving compose: a draft without a resolvable recipient is not an
    // error — park it on a compose card in "drafting" so the user (or a
    // later contacts call) can fill the To field.
    if (!stringArg(args, "threadId") && (!stringArg(args, "to") || !stringArg(args, "subject"))) {
      const patch: Partial<GmailComposeCardState> = {
        status: "drafting",
        to: stringArg(args, "to"),
        cc: stringArg(args, "cc"),
        bcc: stringArg(args, "bcc"),
        subject: stringArg(args, "subject"),
        body: stringArg(args, "body"),
        ...(candidatesArg(args) ? { toCandidates: candidatesArg(args) } : {}),
      };
      let composeId = messageId;
      let cardCreated = false;
      if (composeId && this.deps.cards.composeByMessageId(channelId, composeId)) {
        await this.deps.cards.updateCompose(channelId, composeId, patch);
      } else {
        const handle = await this.deps.cards.createCompose(channelId, {
          ...patch,
          status: "drafting",
        });
        composeId = handle.messageId;
        cardCreated = true;
      }
      return {
        ok: true,
        composeId,
        cardCreated,
        note:
          "No recipient yet — resolve with gmail_contacts or let the user fill the To field on the card (it has address autocomplete).",
      };
    }
    try {
      const gmail = this.deps.gmailFor(channelId);
      const replyArgs = await this.resolveReplySendArgs(channelId, args);
      const from = await this.resolveFrom(channelId, args);
      const draftParams = {
        to: replyArgs.to,
        ...(replyArgs.cc ? { cc: replyArgs.cc } : {}),
        ...(replyArgs.bcc ? { bcc: replyArgs.bcc } : {}),
        ...(from ? { from } : {}),
        subject: replyArgs.subject,
        body: stringArg(args, "body") ?? "",
        ...(replyArgs.threadId ? { threadId: replyArgs.threadId } : {}),
        ...(replyArgs.inReplyTo ? { inReplyTo: replyArgs.inReplyTo } : {}),
        ...(replyArgs.references ? { references: replyArgs.references } : {}),
      };
      // Re-saving an existing card's draft updates it instead of duplicating.
      const existingDraftId = stringArg(args, "draftId");
      const draft = existingDraftId
        ? await gmail.updateDraft(existingDraftId, draftParams)
        : await gmail.createDraft(draftParams);
      await this.deps.cards.updateCompose(channelId, messageId, {
        status: "saved",
        draftId: draft.id,
      });
      return { saved: true, draftId: draft.id };
    } catch (err) {
      await this.deps.cards.updateCompose(channelId, messageId, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      return await this.failGmail(channelId, "saveDraft", err);
    }
  }

  async discardCompose(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ discarded: true }> {
    const messageId = stringArg(args, "messageId");
    await this.deps.cards.updateCompose(channelId, messageId, { status: "discarded" });
    return { discarded: true };
  }
}

/** Sanitize an agent-supplied toCandidates array for compose card state. */
export function candidatesArg(args: Record<string, unknown>): GmailContactCandidate[] | undefined {
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
      receivedFrom: typeof item["receivedFrom"] === "number" ? item["receivedFrom"] : 0,
      ...(typeof item["lastInteractionAt"] === "number"
        ? { lastInteractionAt: item["lastInteractionAt"] }
        : {}),
      youReplied: item["youReplied"] === true,
      source: item["source"] === "google-contacts" ? ("google-contacts" as const) : ("history" as const),
      score: typeof item["score"] === "number" ? item["score"] : 0,
    }));
  return candidates.length > 0 ? candidates : undefined;
}
