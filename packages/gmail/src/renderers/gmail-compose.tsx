import { Badge, Button, Callout, Flex, Select, Text, TextArea } from "@radix-ui/themes";
import {
  Cross2Icon,
  ExclamationTriangleIcon,
  PaperPlaneIcon,
  PersonIcon,
} from "@radix-ui/react-icons";
import { useEffect, useRef, useState } from "react";
import type { GmailComposeCardState, GmailContactCandidate } from "@workspace/gmail/card-types";
import { useContainerWidth } from "./use-container-width";

type GmailComposeState = Partial<GmailComposeCardState>;

interface GmailChat {
  callMethodByHandle: (handle: string, method: string, args: unknown) => Promise<unknown>;
}

const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

function splitRecipients(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function reduce(
  state: GmailComposeState,
  update: Partial<GmailComposeState>
): GmailComposeState {
  return { ...state, ...update };
}

export function Pill({ state }: { state: GmailComposeState }) {
  return (
    <Flex align="center" gap="1">
      <Text size="1" weight="medium">
        Compose
      </Text>
      <Text size="1" color="gray">
        {state.subject || "(no subject)"}
      </Text>
      {state.status ? <StatusBadge status={state.status} /> : null}
    </Flex>
  );
}

/** Chip-style recipient input with derived-address-book typeahead. */
function RecipientField({
  label,
  chips,
  setChips,
  disabled,
  chat,
}: {
  label: string;
  chips: string[];
  setChips: (next: string[]) => void;
  disabled: boolean;
  chat: GmailChat;
}) {
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [suggestions, setSuggestions] = useState<GmailContactCandidate[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);

  function addChip(raw: string): boolean {
    const value = raw.trim().replace(/,$/, "");
    if (!value) return true;
    if (!EMAIL_RE.test(value)) {
      setInvalid(true);
      return false;
    }
    if (!chips.includes(value.toLowerCase())) setChips([...chips, value.toLowerCase()]);
    return true;
  }

  function commit(raw: string) {
    if (addChip(raw)) {
      setText("");
      setSuggestions([]);
    }
  }

  function onTextChange(value: string) {
    setText(value);
    setInvalid(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const prefix = value.trim();
    if (prefix.length < 2) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      const seq = ++requestSeq.current;
      chat
        .callMethodByHandle("gmail", "contactSuggest", { prefix })
        .then((result) => {
          if (seq !== requestSeq.current) return;
          const candidates = (result as { candidates?: GmailContactCandidate[] })?.candidates ?? [];
          setSuggestions(candidates.filter((candidate) => !chips.includes(candidate.email)));
        })
        .catch(() => setSuggestions([]));
    }, 200);
  }

  return (
    <Flex direction="column" gap="1" style={{ position: "relative" }}>
      <Flex
        align="center"
        gap="1"
        wrap="wrap"
        style={{
          border: `1px solid var(${invalid ? "--red-a8" : "--gray-a7"})`,
          borderRadius: 6,
          padding: "4px 8px",
          minHeight: 32,
          background: "var(--color-surface)",
        }}
      >
        <Text size="1" color="gray" style={{ minWidth: 24 }}>
          {label}
        </Text>
        {chips.map((chip) => (
          <Badge key={chip} size="1" variant="soft">
            {chip}
            {disabled ? null : (
              <Cross2Icon
                width={10}
                height={10}
                style={{ cursor: "pointer", marginLeft: 2 }}
                onClick={() => setChips(chips.filter((existing) => existing !== chip))}
              />
            )}
          </Badge>
        ))}
        <input
          value={text}
          disabled={disabled}
          placeholder={chips.length === 0 ? "name or address" : ""}
          onChange={(event) => onTextChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              commit(text);
            } else if (event.key === "Backspace" && !text && chips.length > 0) {
              setChips(chips.slice(0, -1));
            }
          }}
          onBlur={() => {
            // Delay so suggestion clicks land before the dropdown closes.
            setTimeout(() => setSuggestions([]), 200);
            if (text.trim() && EMAIL_RE.test(text.trim())) commit(text);
          }}
          style={{
            flex: "1 1 120px",
            minWidth: 80,
            border: "none",
            outline: "none",
            background: "transparent",
            font: "inherit",
            // ≥16px keeps iOS from zooming the page on focus.
            fontSize: 16,
            color: "var(--gray-12)",
          }}
        />
      </Flex>
      {invalid ? (
        <Text size="1" color="red">
          Enter a bare email address (name@example.com)
        </Text>
      ) : null}
      {suggestions.length > 0 ? (
        <Flex
          direction="column"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 10,
            background: "var(--color-panel-solid)",
            border: "1px solid var(--gray-a7)",
            borderRadius: 6,
            boxShadow: "var(--shadow-3)",
            overflow: "hidden",
            maxWidth: "100%",
          }}
        >
          {suggestions.slice(0, 6).map((candidate) => (
            <Flex
              key={candidate.email}
              align="center"
              justify="between"
              gap="2"
              style={{ padding: "6px 10px", cursor: "pointer", minHeight: 44 }}
              onMouseDown={(event) => {
                event.preventDefault();
                setChips([...chips, candidate.email]);
                setText("");
                setSuggestions([]);
              }}
              onTouchEnd={(event) => {
                event.preventDefault();
                setChips([...chips, candidate.email]);
                setText("");
                setSuggestions([]);
              }}
            >
              <Flex align="center" gap="2" style={{ minWidth: 0 }}>
                <PersonIcon />
                <Text size="1" weight="medium">
                  {candidate.displayName ?? candidate.email}
                </Text>
                {candidate.displayName ? (
                  <Text size="1" color="gray" truncate>
                    {candidate.email}
                  </Text>
                ) : null}
              </Flex>
              <Text size="1" color="gray">
                {candidate.sentTo > 0
                  ? `${candidate.sentTo} sent`
                  : candidate.receivedFrom > 0
                    ? `${candidate.receivedFrom} received`
                    : ""}
              </Text>
            </Flex>
          ))}
        </Flex>
      ) : null}
    </Flex>
  );
}

export default function GmailCompose({
  state,
  expanded,
  messageId,
  chat,
}: {
  state: GmailComposeState;
  expanded: boolean;
  messageId: string;
  chat: GmailChat;
}) {
  const [to, setTo] = useState<string[]>(splitRecipients(state.to));
  const [cc, setCc] = useState<string[]>(splitRecipients(state.cc));
  const [bcc, setBcc] = useState<string[]>(splitRecipients(state.bcc));
  const [from, setFrom] = useState(state.from ?? state.fromOptions?.[0] ?? "");
  const [subject, setSubject] = useState(state.subject ?? "");
  const [body, setBody] = useState(state.body ?? "");
  const [reviewingSend, setReviewingSend] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  // Cc/Bcc stay hidden until used — visible when they already have values.
  const [showCcBcc, setShowCcBcc] = useState(false);
  const { ref, compact } = useContainerWidth();

  useEffect(() => {
    setTo(splitRecipients(state.to));
    setCc(splitRecipients(state.cc));
    setBcc(splitRecipients(state.bcc));
    setSubject(state.subject ?? "");
    setBody(state.body ?? "");
  }, [state.to, state.cc, state.bcc, state.subject, state.body]);

  if (!expanded) return <Pill state={{ ...state, subject }} />;

  const disabled =
    busy !== null ||
    state.status === "sending" ||
    state.status === "sent" ||
    state.status === "discarded";

  // The compose contract carries recipients as comma-joined strings.
  // draftId lets a re-save update the existing Gmail draft instead of
  // creating a duplicate.
  const payload = {
    messageId,
    to: to.join(", "),
    cc: cc.join(", "),
    bcc: bcc.join(", "),
    // Only send an explicit From when the user has aliases to pick between.
    ...(state.fromOptions && state.fromOptions.length > 1 && from ? { from } : {}),
    subject,
    body,
    threadId: state.threadId,
    sourceThreadId: state.sourceThreadId,
    draftId: state.draftId,
  };

  async function call(method: string, args: unknown, label: string) {
    setBusy(label);
    setLocalError(null);
    try {
      await chat.callMethodByHandle("gmail", method, args);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const candidates = (state.toCandidates ?? []).filter(
    (candidate) => candidate.email && !to.includes(candidate.email)
  );
  const hasTo = to.length > 0;
  const ccBccVisible = showCcBcc || cc.length > 0 || bcc.length > 0;
  const actionButtonSize = compact ? "2" : "1";
  const actionButtonStyle = compact ? { width: "100%" } : undefined;

  return (
    <Flex ref={ref} direction="column" gap="2">
      <Flex align="center" justify="between" gap="2">
        <Text size="3" weight="bold">
          {state.threadId ? "Reply" : "Compose"}
        </Text>
        {state.status ? <StatusBadge status={state.status} /> : null}
      </Flex>
      {state.status === "review" ? (
        <Callout.Root color="amber" size="1">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>
            Agent-drafted mail — review the recipient, subject, and body before sending. Nothing is
            sent until you click Send.
          </Callout.Text>
        </Callout.Root>
      ) : null}
      {state.error || localError ? (
        <Callout.Root color="red" size="1">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>{state.error ?? localError}</Callout.Text>
        </Callout.Root>
      ) : null}
      {state.fromOptions && state.fromOptions.length > 1 ? (
        <Flex align="center" gap="2">
          <Text size="1" color="gray">
            From
          </Text>
          <Select.Root size="2" value={from} onValueChange={setFrom} disabled={disabled}>
            <Select.Trigger style={{ flex: 1, minWidth: 0 }} />
            <Select.Content>
              {state.fromOptions.map((option) => (
                <Select.Item key={option} value={option}>
                  {option}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </Flex>
      ) : null}
      <RecipientField label="To" chips={to} setChips={setTo} disabled={disabled} chat={chat} />
      {!hasTo && candidates.length > 0 ? (
        <Flex gap="1" wrap="wrap" align="center">
          <Text size="1" color="gray">
            Suggested:
          </Text>
          {candidates.slice(0, 5).map((candidate) => (
            <Button
              key={candidate.email}
              size="1"
              variant="soft"
              disabled={disabled}
              onClick={() => setTo([...to, candidate.email])}
            >
              <PersonIcon />
              {candidate.displayName
                ? `${candidate.displayName} <${candidate.email}>`
                : candidate.email}
              {candidate.sentTo > 0 ? ` · ${candidate.sentTo} sent` : ""}
            </Button>
          ))}
        </Flex>
      ) : null}
      {ccBccVisible ? (
        <Flex gap="2" wrap="wrap" direction={compact ? "column" : "row"}>
          <div style={compact ? undefined : { flex: "1 1 180px" }}>
            <RecipientField
              label="Cc"
              chips={cc}
              setChips={setCc}
              disabled={disabled}
              chat={chat}
            />
          </div>
          <div style={compact ? undefined : { flex: "1 1 180px" }}>
            <RecipientField
              label="Bcc"
              chips={bcc}
              setChips={setBcc}
              disabled={disabled}
              chat={chat}
            />
          </div>
        </Flex>
      ) : (
        <Button
          size="1"
          variant="ghost"
          color="gray"
          disabled={disabled}
          style={{ alignSelf: "flex-start" }}
          onClick={() => setShowCcBcc(true)}
        >
          + Cc/Bcc
        </Button>
      )}
      <input
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
        placeholder="Subject"
        disabled={disabled}
        style={{
          border: "1px solid var(--gray-a7)",
          borderRadius: 6,
          padding: "8px 10px",
          font: "inherit",
          // ≥16px keeps iOS from zooming the page on focus.
          fontSize: 16,
          background: "var(--color-surface)",
          color: "var(--gray-12)",
        }}
      />
      <TextArea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Body"
        disabled={disabled}
        style={{ minHeight: 160, fontSize: 16 }}
      />
      <Flex gap="2" wrap="wrap" direction={compact ? "column" : "row"}>
        {reviewingSend ? (
          <Callout.Root color="amber" size="1" style={{ width: "100%" }}>
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>
              Sending to {payload.to || "(missing recipient)"} with subject{" "}
              {subject || "(no subject)"}.
            </Callout.Text>
          </Callout.Root>
        ) : null}
        <Button
          size={actionButtonSize}
          style={actionButtonStyle}
          disabled={disabled || !hasTo || !subject.trim() || !body.trim()}
          title="Send"
          onClick={() => {
            // A review-state card is already the review step; Send is the
            // user's authorization. Manual composes keep the two-click confirm.
            if (state.status !== "review" && !reviewingSend) {
              setReviewingSend(true);
              return;
            }
            void call("gmail_send", payload, "send");
          }}
        >
          <PaperPlaneIcon />{" "}
          {busy === "send" || state.status === "sending"
            ? "Sending"
            : state.status === "review"
              ? "Send"
              : reviewingSend
                ? "Confirm send"
                : "Review send"}
        </Button>
        <Button
          size={actionButtonSize}
          style={actionButtonStyle}
          variant="soft"
          disabled={disabled || !body.trim()}
          onClick={() => void call("saveDraft", payload, "draft")}
        >
          {busy === "draft" ? "Saving" : state.status === "saved" ? "Saved" : "Save draft"}
        </Button>
        <Button
          size={actionButtonSize}
          style={actionButtonStyle}
          variant="ghost"
          color="red"
          disabled={disabled}
          onClick={() => void call("discardCompose", { messageId }, "discard")}
        >
          Discard
        </Button>
      </Flex>
    </Flex>
  );
}

function StatusBadge({ status }: { status: NonNullable<GmailComposeState["status"]> }) {
  const color =
    status === "sent" || status === "saved"
      ? "green"
      : status === "error"
        ? "red"
        : status === "discarded"
          ? "gray"
          : "gray";
  return <Badge color={color}>{status}</Badge>;
}
