import { Badge, Button, Flex, Text, TextArea } from "@radix-ui/themes";
import { ChevronDownIcon, ChevronRightIcon, DotsHorizontalIcon } from "@radix-ui/react-icons";
import { useEffect, useState } from "react";
import type {
  GmailThreadState,
  GmailThreadUpdate,
} from "@workspace/gmail/renderers/gmail-thread.reducer";

// Inlined copy of @workspace/gmail's gmail-thread reducer. Sandbox renderers
// must be self-contained at runtime: a value import of a workspace package
// forces a build-service round trip on every card compile (type-only imports
// are erased and free). Keep in sync with
// packages/gmail/src/renderers/gmail-thread.reducer.ts — GMAIL_THREAD_UPDATE_SCHEMA
// validates the update shapes on both sides.
export function reduce(state: GmailThreadState, update: GmailThreadUpdate): GmailThreadState {
  if (!("kind" in update) || typeof update.kind !== "string") {
    return { ...state, ...update };
  }
  switch (update.kind) {
    case "newMessage": {
      const messages = [...(state.messages ?? []), update.message];
      return {
        ...state,
        messages,
        lastSnippet: update.lastSnippet ?? update.message.snippet ?? state.lastSnippet,
        unreadCount: update.unreadCount ?? state.unreadCount + 1,
        status: state.status === "archived" ? "open" : state.status,
      };
    }
    case "labelChange":
      return {
        ...state,
        labelIds: update.labelIds,
        unreadCount: update.unreadCount ?? state.unreadCount,
        category: update.category ?? state.category,
      };
    case "draftSet":
      return {
        ...state,
        hasDraft: Boolean(update.draftBody),
      };
    case "statusChange":
      return {
        ...state,
        status: update.status,
      };
    default:
      return state;
  }
}

interface ThreadAttachment {
  filename: string;
  mimeType?: string;
  attachmentId?: string;
  size?: number;
}

interface ThreadBody {
  messages: Array<{
    id: string;
    from?: string;
    date?: string;
    snippet?: string;
    bodyText?: string;
    attachments?: ThreadAttachment[];
  }>;
}

export function Pill({ state }: { state: GmailThreadState }) {
  return (
    <Flex align="center" gap="1" style={{ minWidth: 0 }}>
      <Text
        size="1"
        weight={state.unreadCount > 0 ? "bold" : "medium"}
        truncate
        style={{ minWidth: 0 }}
      >
        {state.subject}
      </Text>
      {state.unreadCount > 0 ? (
        <Badge size="1" color="blue">
          {state.unreadCount}
        </Badge>
      ) : null}
    </Flex>
  );
}

/**
 * Thread card, mobile-first: auto-loads contents on expand, latest message
 * open, reply box with two primary actions (AI draft / Send with two-tap
 * confirm); Archive / Mark read / Refresh behind one "More" disclosure.
 */
export default function GmailThread({
  state,
  expanded,
  chat,
}: {
  state: GmailThreadState;
  expanded: boolean;
  chat: { callMethodByHandle: (handle: string, method: string, args: unknown) => Promise<unknown> };
}) {
  const [thread, setThread] = useState<ThreadBody | null>(null);
  const [openMessageIds, setOpenMessageIds] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingSend, setConfirmingSend] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadThread(force = false) {
    if ((thread && !force) || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await chat.callMethodByHandle("gmail", "gmail_read", {
        threadId: state.threadId,
        format: "full",
        includeAttachmentList: true,
      });
      if (result && typeof result === "object" && Array.isArray((result as ThreadBody).messages)) {
        const body = result as ThreadBody;
        setThread(body);
        // Latest message opens by default; older ones stay collapsed.
        const latest = body.messages[body.messages.length - 1];
        if (latest) setOpenMessageIds(new Set([latest.id]));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (expanded) void loadThread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  async function call(method: string, args: unknown, label: string) {
    setBusy(label);
    setError(null);
    try {
      await chat.callMethodByHandle("gmail", method, args);
      if (method === "gmail_send") {
        setDraft("");
        setConfirmingSend(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (!expanded) {
    return <Pill state={state} />;
  }

  function toggleMessage(id: string) {
    setOpenMessageIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Flex direction="column" gap="2">
      <Flex align="center" justify="between" gap="2" style={{ minWidth: 0 }}>
        <Text
          size="3"
          weight="bold"
          style={{ minWidth: 0, wordBreak: "break-word" }}
          title={state.subject}
        >
          {state.subject}
        </Text>
        <Badge color={state.status === "archived" ? "gray" : "blue"} style={{ flex: "0 0 auto" }}>
          {state.status}
        </Badge>
      </Flex>
      <Text size="1" color="gray" truncate>
        {state.participants.join(", ")}
      </Text>
      {error ? (
        <Text size="1" color="red">
          {error}
        </Text>
      ) : null}

      {thread ? (
        <Flex direction="column" gap="2">
          {thread.messages.map((message) => {
            const open = openMessageIds.has(message.id);
            return (
              <Flex key={message.id} direction="column" gap="1">
                <Button
                  size="2"
                  variant="ghost"
                  color="gray"
                  style={{ alignSelf: "flex-start", maxWidth: "100%", minHeight: 36 }}
                  aria-expanded={open}
                  onClick={() => toggleMessage(message.id)}
                >
                  {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
                  <Text size="1" truncate style={{ minWidth: 0 }}>
                    {message.from} {message.date}
                  </Text>
                </Button>
                {open ? (
                  <>
                    <Text size="2" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {message.bodyText ?? message.snippet}
                    </Text>
                    {(message.attachments ?? [])
                      .filter((attachment) => attachment.attachmentId)
                      .map((attachment) => (
                        <Flex
                          key={attachment.attachmentId}
                          align="center"
                          gap="2"
                          style={{ minHeight: 36 }}
                        >
                          <Text size="1" color="gray" truncate style={{ minWidth: 0 }}>
                            📎 {attachment.filename}
                            {attachment.size ? ` (${Math.ceil(attachment.size / 1024)} KB)` : ""}
                          </Text>
                          <Button
                            size="1"
                            variant="ghost"
                            disabled={busy !== null}
                            onClick={() =>
                              void call(
                                "gmail_get_attachment",
                                {
                                  messageId: message.id,
                                  attachmentId: attachment.attachmentId,
                                  filename: attachment.filename,
                                  mimeType: attachment.mimeType,
                                  threadId: state.threadId,
                                },
                                `attach:${attachment.attachmentId}`
                              ).then(() => setSavedNote(`Saved ${attachment.filename}`))
                            }
                          >
                            {busy === `attach:${attachment.attachmentId}` ? "Saving…" : "Save"}
                          </Button>
                        </Flex>
                      ))}
                  </>
                ) : null}
              </Flex>
            );
          })}
          {savedNote ? (
            <Text size="1" color="gray">
              {savedNote}
            </Text>
          ) : null}
        </Flex>
      ) : (
        <Text size="2" color="gray">
          {loading ? "Loading thread…" : state.lastSnippet}
        </Text>
      )}

      <TextArea
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setConfirmingSend(false);
        }}
        placeholder="Reply…"
        style={{ minHeight: 88, fontSize: 16 }}
      />
      <Flex gap="2" align="center" wrap="wrap">
        <Button
          size="2"
          disabled={busy !== null}
          onClick={() => void call("draftReply", { threadId: state.threadId }, "draft")}
        >
          {busy === "draft" ? "Drafting…" : "AI draft"}
        </Button>
        <Button
          size="2"
          variant="soft"
          color={confirmingSend ? "red" : undefined}
          disabled={!draft.trim() || busy !== null}
          onClick={() => {
            if (!confirmingSend) {
              setConfirmingSend(true);
              return;
            }
            void call("gmail_send", { threadId: state.threadId, body: draft }, "send");
          }}
        >
          {busy === "send" ? "Sending…" : confirmingSend ? "Confirm send" : "Send"}
        </Button>
        <Button
          size="2"
          variant="ghost"
          color="gray"
          aria-expanded={moreOpen}
          aria-label="More actions"
          onClick={() => setMoreOpen((open) => !open)}
        >
          <DotsHorizontalIcon /> More
        </Button>
      </Flex>
      {moreOpen ? (
        <Flex gap="2" wrap="wrap">
          <Button
            size="2"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void call("markRead", { threadId: state.threadId }, "read")}
          >
            Mark read
          </Button>
          <Button
            size="2"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void call("archiveThread", { threadId: state.threadId }, "archive")}
          >
            Archive
          </Button>
          <Button
            size="2"
            variant="ghost"
            disabled={busy !== null}
            title="Archive now, remind me tomorrow"
            onClick={() => void call("gmail_snooze", { threadId: state.threadId }, "snooze")}
          >
            {busy === "snooze" ? "Snoozing…" : "Snooze 1d"}
          </Button>
          <Button
            size="2"
            variant="ghost"
            disabled={loading || busy !== null}
            onClick={() => void loadThread(true)}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </Flex>
      ) : null}
    </Flex>
  );
}
