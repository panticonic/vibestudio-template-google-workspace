import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Box,
  Button,
  Callout,
  Card,
  Flex,
  IconButton,
  Spinner,
  Text,
  TextArea,
} from "@radix-ui/themes";
import { Cross2Icon } from "@radix-ui/react-icons";
import {
  isAgentParticipantType,
  type AgentSubscriptionConfig,
  type ModelCatalogEntry,
} from "@workspace/agentic-core";
import { isModelUsable } from "@workspace/model-catalog/catalog";
import { useIsMobile, useTouchDevice, useViewportHeight } from "@workspace/react/responsive";
import { useChatComposerRuntime } from "../context/ChatContext";
import { getMentionsFromInput, useChatInputContext } from "../context/ChatInputContext";
import { ImageInput, getAttachmentInputsFromPendingImages } from "./ImageInput";
import { MentionAutocomplete } from "./MentionAutocomplete";
import { ModelCommandMenu } from "./ModelCommandMenu";
import { SendButton } from "./SendButton";
import { useMentionAutocomplete, type MentionCandidate } from "../hooks/useMentionAutocomplete";
import { useAccountProfiles, type AccountRpc } from "../hooks/useAccountProfiles";
import {
  getImagesFromClipboard,
  createPendingImage,
  validateImageFiles,
  type PendingImage,
} from "../utils/imageUtils";

/** Matches a whole-input `/model [query]` composer command (item 7). */
const MODEL_COMMAND_RE = /^\/model(?:\s+(.*))?$/;
const MODEL_MENU_LIMIT = 8;

const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const RESPOND_POLICIES = new Set([
  "all",
  "mentioned",
  "mentioned-strict",
  "mentioned-or-followup",
  "from-participants",
]);

function modelSwitchConfigFromSettings(
  settings: unknown,
  model: string,
  handle?: string
): AgentSubscriptionConfig {
  const source =
    settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  const config: AgentSubscriptionConfig = {
    model,
    ...(handle ? { handle } : {}),
  };
  const thinkingLevel = source["thinkingLevel"];
  if (typeof thinkingLevel === "string" && THINKING_LEVELS.has(thinkingLevel)) {
    config.thinkingLevel = thinkingLevel as AgentSubscriptionConfig["thinkingLevel"];
  }
  if (typeof source["fastMode"] === "boolean") {
    config.fastMode = source["fastMode"];
  }
  const approvalLevel = source["approvalLevel"];
  if (approvalLevel === 0 || approvalLevel === 1 || approvalLevel === 2) {
    config.approvalLevel = approvalLevel;
  }
  const respondPolicy = source["respondPolicy"];
  if (typeof respondPolicy === "string" && RESPOND_POLICIES.has(respondPolicy)) {
    config.respondPolicy = respondPolicy as AgentSubscriptionConfig["respondPolicy"];
  }
  const respondFrom = source["respondFrom"];
  if (Array.isArray(respondFrom) && respondFrom.every((value) => typeof value === "string")) {
    config.respondFrom = respondFrom;
  }
  return config;
}

const MAX_IMAGE_COUNT = 10;

export interface ChatInputProps {
  /** Product-specific prompt shown when the composer is empty. */
  placeholder?: string;
  /** Recipients used when the message contains no explicit @mention. */
  defaultMentions?: readonly string[];
  /** Product-owned readiness gate in addition to channel connectivity. */
  disabled?: boolean;
}

/**
 * Chat input area with text input, image attachment, and send button.
 * Reads from ChatContext.
 */
export function ChatInput({ placeholder, defaultMentions, disabled = false }: ChatInputProps = {}) {
  const {
    connected,
    allParticipants,
    selfId,
    agentBusy,
    hasOpenTurn,
    primaryActionIntent,
    flushOutboxAndInterrupt,
    flushNarration,
    undoableAction,
    undoLastAction,
    pendingSendCount,
    participants,
    modelCatalog,
    onReplaceAgent,
    onCallMethodResult,
    chat,
  } = useChatComposerRuntime();
  const {
    input,
    pendingImages,
    onInputChange,
    onSendMessage,
    onImagesChange,
    replyTo,
    replyToMessage,
    setReplyTo,
  } = useChatInputContext();
  const isMobile = useIsMobile();
  const isTouch = useTouchDevice();
  const viewportHeight = useViewportHeight();
  const sendButtonSize: "2" | "3" = isMobile ? "2" : isTouch ? "3" : "2";

  // Light haptic tick on send (touch devices). Settings-gated; default-on tick.
  const hapticTick = useCallback(() => {
    if (isTouch && typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      try {
        navigator.vibrate(8);
      } catch {
        /* best-effort */
      }
    }
  }, [isTouch]);

  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showImageInput, setShowImageInput] = useState(false);
  const [selectedMentionIds, setSelectedMentionIds] = useState<Record<string, string>>({});
  const accountProfiles = useAccountProfiles(
    (chat as { rpc?: AccountRpc } | undefined)?.rpc,
    Object.keys(allParticipants)
  );
  const mentions = useMentionAutocomplete(allParticipants, selfId, accountProfiles);

  // --- `/model` composer quick-switcher (item 7) -------------------------
  const [modelMenuIndex, setModelMenuIndex] = useState(0);
  const [modelMenuPos, setModelMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [modelSwitchNotice, setModelSwitchNotice] = useState<string | null>(null);

  const modelQuery = useMemo(() => {
    const match = MODEL_COMMAND_RE.exec(input);
    return match ? (match[1] ?? "") : null;
  }, [input]);

  const modelCandidates = useMemo(() => {
    if (modelQuery === null || !onReplaceAgent) return [];
    const q = modelQuery.trim().toLowerCase();
    const usable = (modelCatalog?.models ?? []).filter(isModelUsable);
    const matched = q
      ? usable.filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            m.ref.toLowerCase().includes(q) ||
            m.provider.toLowerCase().includes(q)
        )
      : usable;
    return matched.slice(0, MODEL_MENU_LIMIT);
  }, [modelQuery, modelCatalog, onReplaceAgent]);

  const modelMenuOpen = modelQuery !== null && !!onReplaceAgent && modelCandidates.length > 0;

  // Anchor the menu to the composer and keep the highlighted row in range as
  // the candidate list narrows while typing.
  useEffect(() => {
    if (modelQuery === null) {
      setModelMenuIndex(0);
      return;
    }
    const rect = textAreaRef.current?.getBoundingClientRect();
    if (rect) setModelMenuPos({ left: rect.left, top: rect.top });
    setModelMenuIndex((i) => Math.min(i, Math.max(0, modelCandidates.length - 1)));
  }, [modelQuery, modelCandidates.length]);

  // Auto-dismiss the "switched to X" confirmation.
  useEffect(() => {
    if (!modelSwitchNotice) return;
    const timer = window.setTimeout(() => setModelSwitchNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [modelSwitchNotice]);

  const switchModel = useCallback(
    async (model: ModelCatalogEntry) => {
      const agents = Object.values(participants).filter(
        (p) => p.id !== selfId && isAgentParticipantType(p.metadata?.type as string | undefined)
      );
      if (agents.length === 0) {
        setSendError("No agent in this conversation yet — add one first.");
        return;
      }
      if (agents.length > 1) {
        setSendError("Multiple agents here — use the model picker to choose which to switch.");
        return;
      }
      if (!onReplaceAgent) {
        setSendError("Model switching is not available in this host.");
        return;
      }
      const agent = agents[0]!;
      try {
        const handle =
          typeof agent.metadata?.handle === "string" ? agent.metadata.handle : undefined;
        const settings = await onCallMethodResult(agent.id, "getAgentSettings", {});
        await onReplaceAgent(
          agent.id,
          undefined,
          modelSwitchConfigFromSettings(settings, model.ref, handle)
        );
        onInputChange("");
        setModelMenuPos(null);
        setModelSwitchNotice(model.name);
        if (textAreaRef.current) textAreaRef.current.style.height = "auto";
      } catch (error) {
        setSendError(error instanceof Error ? error.message : String(error));
      }
    },
    [participants, selfId, onReplaceAgent, onCallMethodResult, onInputChange]
  );

  // Auto-resize textarea: rAF-coalesced onInput handler.
  const resizeRafRef = useRef(0);
  const handleTextAreaInput = useCallback(() => {
    const textArea = textAreaRef.current;
    if (!textArea) return;
    cancelAnimationFrame(resizeRafRef.current);
    resizeRafRef.current = requestAnimationFrame(() => {
      textArea.style.height = "auto";
      textArea.style.height = `${textArea.scrollHeight}px`;
    });
  }, []);
  useEffect(() => {
    return () => cancelAnimationFrame(resizeRafRef.current);
  }, []);

  useEffect(() => {
    if (replyTo) textAreaRef.current?.focus();
  }, [replyTo]);

  // Handle paste for images
  useEffect(() => {
    if (!connected) return;

    const handlePaste = async (event: ClipboardEvent) => {
      try {
        const files = getImagesFromClipboard(event);
        if (files.length === 0) return;

        event.preventDefault();

        if (pendingImages.length + files.length > MAX_IMAGE_COUNT) {
          setSendError(`Maximum ${MAX_IMAGE_COUNT} images allowed`);
          return;
        }

        const validation = validateImageFiles(files);
        if (!validation.valid) {
          setSendError(validation.error ?? "Invalid image");
          return;
        }

        const newImages: PendingImage[] = [];
        for (const file of files) {
          try {
            const pending = await createPendingImage(file);
            newImages.push(pending);
          } catch (err) {
            console.error("[ChatInput] Failed to process pasted image:", err);
          }
        }

        if (newImages.length > 0) {
          onImagesChange([...pendingImages, ...newImages]);
        }
      } catch (err) {
        console.error("[ChatInput] Image paste handler error:", err);
      }
    };

    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [connected, pendingImages, onImagesChange]);

  const handleSendMessage = useCallback(
    async (mode: "default" | "after-turn" = "default") => {
      try {
        setSendError(null);
        if (disabled) return;
        // A `/model …` line is a command, never a chat message. If it resolves
        // to models, switch to the top match; otherwise coach instead of
        // sending the literal text to the agent.
        if (modelQuery !== null) {
          if (!onReplaceAgent) {
            setSendError("Model switching is not available in this host.");
            return;
          }
          const top = modelCandidates[modelMenuIndex] ?? modelCandidates[0];
          if (top) await switchModel(top);
          else setSendError("No available model matches — keep typing or use the model picker.");
          return;
        }
        const attachments =
          pendingImages.length > 0
            ? getAttachmentInputsFromPendingImages(pendingImages)
            : undefined;
        const effectiveMode = mode === "after-turn" && hasOpenTurn ? "after-turn" : "default";
        const explicitMentions = getMentionsFromInput(
          input,
          allParticipants,
          selectedMentionIds,
          accountProfiles
        );
        await onSendMessage(attachments, {
          mentions:
            explicitMentions.length > 0 ? explicitMentions : [...new Set(defaultMentions ?? [])],
          replyTo: replyTo ?? undefined,
          // After-turn delivery is a message intent in payload.metadata.
          ...(effectiveMode === "after-turn" ? { metadata: { deliverAfterTurn: true } } : {}),
        });
        hapticTick();
        onImagesChange([]);
        setShowImageInput(false);
        setSelectedMentionIds({});
        mentions.close();
        if (textAreaRef.current) {
          textAreaRef.current.style.height = "auto";
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setSendError(message);
        console.error("Failed to send message:", error);
      }
    },
    [
      onSendMessage,
      pendingImages,
      onImagesChange,
      input,
      allParticipants,
      selectedMentionIds,
      accountProfiles,
      defaultMentions,
      replyTo,
      mentions,
      hapticTick,
      hasOpenTurn,
      modelQuery,
      onReplaceAgent,
      modelCandidates,
      modelMenuIndex,
      switchModel,
      disabled,
    ]
  );

  const handleInputChange = useCallback(
    (value: string) => {
      if (sendError) setSendError(null);
      onInputChange(value);
      const textArea = textAreaRef.current;
      if (textArea) mentions.updateFromTextArea(textArea, value);
    },
    [onInputChange, sendError, mentions]
  );

  const insertMention = useCallback(
    (candidate: MentionCandidate) => {
      const textArea = textAreaRef.current;
      if (!textArea) return;
      const caret = textArea.selectionStart ?? input.length;
      const start = mentions.triggerStart >= 0 ? mentions.triggerStart : caret;
      const before = input.slice(0, start);
      const after = input.slice(caret);
      const spacer = after.startsWith(" ") ? "" : " ";
      const next = `${before}@${candidate.handle}${spacer}${after}`;
      const nextCaret = before.length + candidate.handle.length + 1 + spacer.length;
      onInputChange(next);
      setSelectedMentionIds((current) => ({
        ...current,
        [candidate.handle.toLowerCase()]: candidate.participantId,
      }));
      mentions.close();
      requestAnimationFrame(() => {
        textArea.focus();
        textArea.setSelectionRange(nextCaret, nextCaret);
        handleTextAreaInput();
      });
    },
    [input, mentions, onInputChange, handleTextAreaInput]
  );

  const handleImagesChange = useCallback(
    (images: PendingImage[]) => {
      if (sendError) setSendError(null);
      onImagesChange(images);
    },
    [onImagesChange, sendError]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (modelMenuOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setModelMenuIndex((i) => Math.min(modelCandidates.length - 1, i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setModelMenuIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onInputChange("");
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const model = modelCandidates[modelMenuIndex];
          if (model) void switchModel(model);
          return;
        }
      }
      if (mentions.open) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          mentions.setSelectedIndex(mentions.selectedIndex + 1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          mentions.setSelectedIndex(Math.max(0, mentions.selectedIndex - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          mentions.close();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const candidate = mentions.candidates[mentions.selectedIndex];
          if (candidate) insertMention(candidate);
          return;
        }
      }
      const mod = e.metaKey || e.ctrlKey;
      // Escape = flush (advance the pipeline one step) + interrupt, gated on the
      // mention popover being closed AND the composer empty (flush is
      // incremental, so a stray Escape should not dump the queue).
      if (e.key === "Escape" && !mentions.open && input.trim().length === 0 && agentBusy) {
        e.preventDefault();
        void flushOutboxAndInterrupt();
        return;
      }
      if (e.key === "Enter") {
        if (e.shiftKey && !mod) {
          // Shift+Enter = newline (default behavior).
          return;
        }
        e.preventDefault();
        if (mod && e.shiftKey) {
          // Cmd/Ctrl+Shift+Enter = send after turn.
          void handleSendMessage("after-turn");
        } else {
          // Enter (or Cmd/Ctrl+Enter) = send default (steers if mid-turn).
          void handleSendMessage("default");
        }
      }
    },
    [
      handleSendMessage,
      mentions,
      insertMention,
      input,
      agentBusy,
      flushOutboxAndInterrupt,
      modelMenuOpen,
      modelCandidates,
      modelMenuIndex,
      switchModel,
      onInputChange,
    ]
  );

  const toggleImageInput = useCallback(() => {
    if (sendError) setSendError(null);
    setShowImageInput((prev) => !prev);
  }, [sendError]);

  const handleSendClick = useCallback(() => {
    void handleSendMessage("default");
  }, [handleSendMessage]);
  const handleSendAfterTurn = useCallback(() => {
    void handleSendMessage("after-turn");
  }, [handleSendMessage]);

  const inputDisabled = disabled || !connected;
  const canSend = !inputDisabled && (input.trim().length > 0 || pendingImages.length > 0);

  return (
    <>
      {/* Error display */}
      {sendError && (
        <Box flexShrink="0">
          <Callout.Root color="red" size="1">
            <Callout.Text>Failed to send: {sendError}</Callout.Text>
          </Callout.Root>
        </Box>
      )}

      {/* Image input - shown when toggled or when images are pending */}
      {(showImageInput || pendingImages.length > 0) && (
        <Card
          className="chat-surface-card chat-attachment-card"
          size="1"
          variant="surface"
          style={{ flexShrink: 0 }}
        >
          <ImageInput
            images={pendingImages}
            onImagesChange={handleImagesChange}
            onError={(error) => setSendError(error)}
            disabled={inputDisabled}
          />
        </Card>
      )}

      {/* Input */}
      <Card
        className="chat-surface-card chat-input-card"
        data-part="chat-composer"
        size="1"
        variant="surface"
        style={{ flexShrink: 0 }}
      >
        {replyTo && (
          <Flex align="center" justify="between" gap="2" mb="2">
            <Text size="1" color="gray" truncate>
              Replying to{" "}
              {replyToMessage?.senderMetadata?.name ?? replyToMessage?.senderId ?? "message"}
              {replyToMessage?.content ? `: ${replyToMessage.content.slice(0, 80)}` : ""}
            </Text>
            <IconButton
              size="1"
              variant="ghost"
              color="gray"
              onClick={() => setReplyTo(null)}
              title="Cancel reply"
            >
              <Cross2Icon />
            </IconButton>
          </Flex>
        )}
        {/* The send control is docked in the input's lower-right corner (inside
            the field, not beside it). It stays put as the textarea grows; the
            textarea reserves right-padding so text never runs under it. */}
        <Box style={{ position: "relative" }}>
          {mentions.open && (
            <MentionAutocomplete
              candidates={mentions.candidates}
              selectedIndex={mentions.selectedIndex}
              position={mentions.caretPosition}
              onHighlight={mentions.setSelectedIndex}
              onSelect={insertMention}
            />
          )}
          {modelMenuOpen && (
            <ModelCommandMenu
              candidates={modelCandidates}
              selectedIndex={modelMenuIndex}
              position={modelMenuPos}
              onHighlight={setModelMenuIndex}
              onSelect={switchModel}
            />
          )}
          <TextArea
            ref={textAreaRef}
            size="2"
            variant="surface"
            className="chat-input-textarea"
            style={{
              width: "100%",
              // Match the dock's default band so the send button sits centered in
              // the default two-line composer (see .chat-input-send-dock).
              minHeight: "var(--composer-min-h, 3.5rem)",
              maxHeight: isMobile ? Math.min(120, viewportHeight * 0.22) : 180,
              resize: "none",
            }}
            placeholder={
              placeholder ??
              (isMobile ? "Type a message…" : "Type a message…  (⏎ send · ⇧⏎ newline)")
            }
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onInput={handleTextAreaInput}
            onKeyDown={handleKeyDown}
            disabled={inputDisabled}
          />
          <Box className="chat-input-send-dock">
            <SendButton
              intent={primaryActionIntent}
              agentBusy={agentBusy}
              canSendAfterTurn={hasOpenTurn}
              disabled={!canSend}
              optionsDisabled={inputDisabled}
              size={sendButtonSize}
              onSend={handleSendClick}
              onSendAfterTurn={handleSendAfterTurn}
              onAttach={inputDisabled ? undefined : toggleImageInput}
              attachmentCount={pendingImages.length}
            />
          </Box>
        </Box>
        {/* Transient "Sending…" ghost — the only sub-row, shown only in flight. */}
        {pendingSendCount > 0 && (
          <Flex
            align="center"
            justify="end"
            gap="1"
            mt="1"
            className="chat-sending-ghost"
            aria-live="polite"
          >
            <Spinner size="1" />
            <Text size="1" color="gray">
              Sending…
            </Text>
          </Flex>
        )}
      </Card>

      {/* Transient "/model" switch confirmation (item 7). */}
      {modelSwitchNotice && (
        <Box flexShrink="0" mt="1" className="chat-narration-pill-wrap" aria-live="polite">
          <Box className="chat-narration-pill">
            <Text size="1">Switched this agent to {modelSwitchNotice}</Text>
          </Box>
        </Box>
      )}

      {/* Transient flush self-narration pill. */}
      {flushNarration && (
        <Box flexShrink="0" mt="1" className="chat-narration-pill-wrap" aria-live="polite">
          <Box className="chat-narration-pill">
            <Text size="1">{flushNarration.text}</Text>
          </Box>
        </Box>
      )}

      {/* Reversible-until-committed undo snackbar (~5s). */}
      {undoableAction && (
        <Box flexShrink="0" mt="1" className="chat-undo-snackbar-wrap" aria-live="polite">
          <Flex align="center" justify="between" gap="3" className="chat-undo-snackbar">
            <Text size="1">
              {undoableAction.messageIds.length > 1
                ? `${undoableAction.messageIds.length} messages canceled`
                : "Message canceled"}
              {undoableAction.textOnlyRestore
                ? " — Undo restores text only, without attachments or delivery options."
                : ""}
            </Text>
            <Button size="1" variant="soft" onClick={() => undoLastAction?.()}>
              Undo
            </Button>
          </Flex>
        </Box>
      )}
    </>
  );
}
