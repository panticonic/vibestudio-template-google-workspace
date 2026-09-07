import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  DropdownMenu,
  Flex,
  HoverCard,
  IconButton,
  Text,
  TextArea,
} from "@radix-ui/themes";
import {
  CopyIcon,
  CheckIcon,
  ChatBubbleIcon,
  ReloadIcon,
  Cross2Icon,
  DotsHorizontalIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
} from "@radix-ui/react-icons";
import {
  CONTENT_TYPE_INLINE_UI,
  isClientParticipantType,
} from "@workspace/pubsub";
import { LOCAL_FALLBACK_MODEL_REF } from "@workspace/model-catalog/catalog";
import type { AgentSubscriptionConfig } from "@workspace/agentic-core";
import type { Participant } from "@workspace/pubsub";
import { useOptionalChatMessageActions } from "../context/ChatContext";
import { useOptionalChatInputActions } from "../context/ChatInputContext";
import { TypingIndicator } from "./TypingIndicator";
import { MessageContent } from "./MessageContent";
import { ImageGallery } from "./ImageGallery";
import { InlineUiMessage, parseInlineUiData } from "./InlineUiMessage";
import { AgentDisconnectedMessage } from "./AgentDisconnectedMessage";
import { CustomMessageCard } from "./CustomMessage";
import { AckBadge } from "./AckBadge";
import { useForeignEnvelope } from "../hooks/useForeignEnvelope";
import { SubagentTranscriptContent } from "./SubagentTranscript";
import ModelCredentialRequiredCard from "./ModelCredentialRequiredCard";
import {
  AutomationActivity,
  createAutomationUiClient,
} from "./AutomationActivity";
import type {
  BrowserHandoffCaller,
  ChannelParticipantId,
  ChatMessage,
  ChatParticipantMetadata,
  InlineUiComponentEntry,
  MessageTypeComponentEntry,
} from "../types";
import type { SenderInfo } from "./MessageList";
import type { MdxActionHandlers } from "./markdownComponents";

interface MessageCardProps {
  msg: ChatMessage;
  index: number;
  selfId: ChannelParticipantId | null;
  senderType: string;
  senderInfo: SenderInfo;
  /** Roster used to resolve receipt participant keys → display name/type. */
  participants?: Record<string, Participant<ChatParticipantMetadata>>;
  mentionLabels: string[];
  replyContext?: { id: string; senderName: string; snippet: string };
  isStreaming: boolean;
  /** Whether this specific message was just copied (shows checkmark icon) */
  isCopied: boolean;
  inlineUiComponents?: Map<string, InlineUiComponentEntry>;
  messageTypeComponents?: Map<string, MessageTypeComponentEntry>;
  chat?: Record<string, unknown>;
  browserHandoffCaller?: BrowserHandoffCaller;
  onInterrupt: (msgId: string, senderId: string) => void;
  onCopy: (msgId: string, content: string) => void;
  onClearCopied: (msgId: string) => void;
  onReply?: (msgId: string) => void;
  onFocusPanel?: (panelId: string) => void;
  onReloadPanel?: (panelId: string) => void;
  mdxActions?: MdxActionHandlers;
}

function classNames(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(" ");
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

type ChatCallMethod = (
  participantId: string,
  method: string,
  args: unknown,
  options?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<unknown>;

const PROVIDER_LEVEL_FAILURE_CODES = new Set([
  "usage_limit_terminal",
  "quota_exhausted_terminal",
  "rate_limited_retryable",
  "provider_overloaded_retryable",
  "auth_or_credentials",
  "circuit_breaker_open_retryable",
]);

function chatCallMethod(chat: Record<string, unknown>): ChatCallMethod | null {
  return typeof chat["callMethod"] === "function"
    ? (chat["callMethod"] as ChatCallMethod)
    : null;
}

function chatSend(
  chat: Record<string, unknown>,
): ((content: string, opts?: unknown) => Promise<unknown>) | null {
  return typeof chat["send"] === "function"
    ? (chat["send"] as (content: string, opts?: unknown) => Promise<unknown>)
    : null;
}

function settingValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const maybeWrapped = value as { value?: unknown };
  return "value" in maybeWrapped ? maybeWrapped.value : value;
}

function modelRefFromSettings(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const model = settingValue((value as { model?: unknown }).model);
  if (typeof model === "string") return model;
  return null;
}

export function agentConfigFromSettings(
  value: unknown,
  fallbackModel: string | null | undefined,
): AgentSubscriptionConfig {
  const config: AgentSubscriptionConfig = {};
  const model = modelRefFromSettings(value) ?? fallbackModel;
  if (model) config.model = model;
  if (!value || typeof value !== "object") return config;
  const record = value as Record<string, unknown>;
  const thinkingLevel = settingValue(record["thinkingLevel"]);
  if (
    thinkingLevel === "minimal" ||
    thinkingLevel === "low" ||
    thinkingLevel === "medium" ||
    thinkingLevel === "high" ||
    thinkingLevel === "xhigh" ||
    thinkingLevel === "max"
  ) {
    config.thinkingLevel = thinkingLevel;
  }
  const fastMode = settingValue(record["fastMode"]);
  if (typeof fastMode === "boolean") config.fastMode = fastMode;
  const approvalLevel = settingValue(record["approvalLevel"]);
  if (approvalLevel === 0 || approvalLevel === 1 || approvalLevel === 2) {
    config.approvalLevel = approvalLevel;
  }
  const respondPolicy = settingValue(record["respondPolicy"]);
  if (
    respondPolicy === "all" ||
    respondPolicy === "mentioned" ||
    respondPolicy === "mentioned-strict" ||
    respondPolicy === "mentioned-or-followup" ||
    respondPolicy === "from-participants"
  ) {
    config.respondPolicy = respondPolicy;
  }
  const respondFromValue = settingValue(record["respondFrom"]);
  if (Array.isArray(respondFromValue)) {
    const respondFrom = respondFromValue.filter(
      (item): item is string => typeof item === "string",
    );
    if (respondFrom.length > 0) config.respondFrom = respondFrom;
  }
  return config;
}

function isProviderLevelFailureCode(code: unknown): boolean {
  return typeof code === "string" && PROVIDER_LEVEL_FAILURE_CODES.has(code);
}

/**
 * Individual message card — wrapped in React.memo so it only re-renders
 * when its own message data or relevant callbacks change.
 * Closures for onInterrupt/onCopy are created here (inside the memo boundary)
 * so they don't cause parent-level re-renders.
 */
export const MessageCard = React.memo(function MessageCard({
  msg,
  index,
  selfId,
  senderType,
  senderInfo,
  participants,
  mentionLabels,
  replyContext,
  isStreaming,
  isCopied,
  inlineUiComponents,
  messageTypeComponents,
  chat = {},
  browserHandoffCaller,
  onInterrupt,
  onCopy,
  onClearCopied,
  onReply,
  onFocusPanel,
  onReloadPanel,
  mdxActions,
}: MessageCardProps) {
  const key = msg.id || `fallback-msg-${index}`;

  // Per-message closures — created inside the memo boundary
  const handleInterrupt = useCallback(() => {
    onInterrupt(msg.id, msg.senderId);
  }, [onInterrupt, msg.id, msg.senderId]);

  const handleCopy = useCallback(() => {
    onCopy(msg.id, msg.content);
  }, [onCopy, msg.id, msg.content]);
  const handleClearCopied = useCallback(() => {
    onClearCopied(msg.id);
  }, [onClearCopied, msg.id]);
  const handleReply = useCallback(() => {
    onReply?.(msg.id);
  }, [onReply, msg.id]);
  const [resumeScheduleState, setResumeScheduleState] = useState<
    "idle" | "scheduling" | "scheduled" | "failed"
  >("idle");
  const [retryLocalState, setRetryLocalState] = useState<
    "idle" | "switching" | "ready" | "sent" | "failed"
  >("idle");
  const [retryState, setRetryState] = useState<
    "idle" | "sending" | "ready" | "sent" | "failed"
  >("idle");
  const [cleanStartState, setCleanStartState] = useState<
    "idle" | "starting" | "started" | "failed"
  >("idle");
  const [currentAgentModelRef, setCurrentAgentModelRef] = useState<
    string | null | undefined
  >(undefined);
  const [longContentExpanded, setLongContentExpanded] = useState(false);
  const inputActions = useOptionalChatInputActions();
  const messageActions = useOptionalChatMessageActions();
  const automationClient = useMemo(() => {
    if (
      msg.contentType !== "automation" ||
      (!msg.automation && !msg.automationDefinition)
    )
      return null;
    const bridge = chat["rpc"] as
      | {
          call?: (
            target: string,
            method: string,
            args: unknown[],
          ) => Promise<unknown>;
        }
      | undefined;
    if (typeof bridge?.call !== "function") return null;
    return createAutomationUiClient(
      bridge as { call: NonNullable<typeof bridge.call> },
    );
  }, [chat, msg.automation, msg.automationDefinition, msg.contentType]);
  const callMethod = chatCallMethod(chat);
  const sendFromChat = chatSend(chat);
  const providerLevelModelFailure =
    msg.contentType === "diagnostic" &&
    msg.diagnostic?.code === "message_failed" &&
    isProviderLevelFailureCode(msg.diagnostic.failureCode);
  const localContextOverflowFailure =
    msg.contentType === "diagnostic" &&
    msg.diagnostic?.code === "message_failed" &&
    msg.diagnostic.failureCode === "context_overflow_terminal";
  const sameModelRetryFailure =
    msg.contentType === "diagnostic" &&
    msg.diagnostic?.code === "message_failed" &&
    (msg.diagnostic.failureCode === "model_stream_stalled_retryable" ||
      msg.diagnostic.failureCode === "unknown_retryable");
  const shouldInspectCurrentAgentModel =
    providerLevelModelFailure || localContextOverflowFailure;
  const currentAgentModelIsLocal =
    typeof currentAgentModelRef === "string" &&
    currentAgentModelRef.startsWith("local:");
  const currentAgentModelKnown = currentAgentModelRef !== undefined;
  const canRetryWithLocal =
    providerLevelModelFailure &&
    currentAgentModelKnown &&
    !currentAgentModelIsLocal &&
    Boolean(callMethod && (inputActions || sendFromChat));
  const canRetry =
    sameModelRetryFailure && Boolean(inputActions || sendFromChat);
  const canStartCleanLocalChat =
    localContextOverflowFailure &&
    currentAgentModelKnown &&
    currentAgentModelIsLocal &&
    Boolean(messageActions?.onNewConversation && callMethod);

  useEffect(() => {
    if (!shouldInspectCurrentAgentModel || !callMethod) {
      setCurrentAgentModelRef(undefined);
      return;
    }
    let cancelled = false;
    setCurrentAgentModelRef(undefined);
    void callMethod(msg.senderId, "getAgentSettings", {})
      .then((settings) => {
        if (!cancelled) setCurrentAgentModelRef(modelRefFromSettings(settings));
      })
      .catch(() => {
        if (!cancelled) setCurrentAgentModelRef(null);
      });
    return () => {
      cancelled = true;
    };
  }, [callMethod, msg.senderId, shouldInspectCurrentAgentModel]);

  const handleRetryWithLocalModel = useCallback(async () => {
    if (!callMethod) return;
    setRetryLocalState("switching");
    try {
      const currentModel = await callMethod(
        msg.senderId,
        "getAgentSettings",
        {},
      )
        .then(modelRefFromSettings)
        .catch(() => currentAgentModelRef ?? null);
      if (!currentModel?.startsWith("local:")) {
        await callMethod(msg.senderId, "setModel", {
          model: LOCAL_FALLBACK_MODEL_REF,
        });
        setCurrentAgentModelRef(LOCAL_FALLBACK_MODEL_REF);
        if (selfId) {
          void callMethod(selfId, "persist_agent_model", {
            participantId: msg.senderId,
            model: LOCAL_FALLBACK_MODEL_REF,
          }).catch((err: unknown) => {
            console.warn("[MessageCard] local model persistence failed:", err);
          });
        }
      }
      if (sendFromChat) {
        await sendFromChat("retry", { tier: "primary" });
        setRetryLocalState("sent");
      } else if (inputActions) {
        inputActions.onInputChange("retry");
        setRetryLocalState("ready");
      }
    } catch (err) {
      console.warn("[MessageCard] Retry with local model failed:", err);
      setRetryLocalState("failed");
    }
  }, [
    callMethod,
    currentAgentModelRef,
    inputActions,
    msg.senderId,
    selfId,
    sendFromChat,
  ]);

  const handleRetry = useCallback(async () => {
    setRetryState("sending");
    try {
      if (sendFromChat) {
        await sendFromChat("retry", { tier: "primary" });
        setRetryState("sent");
      } else if (inputActions) {
        inputActions.onInputChange("retry");
        setRetryState("ready");
      }
    } catch (err) {
      console.warn("[MessageCard] Retry failed:", err);
      setRetryState("failed");
    }
  }, [inputActions, sendFromChat]);

  const handleStartCleanLocalChat = useCallback(async () => {
    const onNewConversation = messageActions?.onNewConversation;
    if (!onNewConversation || !callMethod) return;
    setCleanStartState("starting");
    try {
      const settings = await callMethod(
        msg.senderId,
        "getAgentSettings",
        {},
      ).catch(() => null);
      const model =
        modelRefFromSettings(settings) ?? currentAgentModelRef ?? null;
      await onNewConversation({
        agentConfig: agentConfigFromSettings(settings, model),
      });
      setCleanStartState("started");
    } catch (err) {
      console.warn("[MessageCard] Clean local chat launch failed:", err);
      setCleanStartState("failed");
    }
  }, [
    callMethod,
    currentAgentModelRef,
    messageActions?.onNewConversation,
    msg.senderId,
  ]);

  const handleScheduleResumeAtReset = useCallback(async () => {
    const diagnostic = msg.diagnostic;
    if (!diagnostic?.messageId || !diagnostic.resetAt || !callMethod) {
      return;
    }
    setResumeScheduleState("scheduling");
    try {
      const result = await callMethod(msg.senderId, "scheduleResumeAtReset", {
        messageId: diagnostic.messageId,
        resetAt: diagnostic.resetAt,
      });
      const scheduled =
        !!result &&
        typeof result === "object" &&
        (result as { scheduled?: unknown }).scheduled === true;
      setResumeScheduleState(scheduled ? "scheduled" : "failed");
    } catch {
      setResumeScheduleState("failed");
    }
  }, [callMethod, msg.diagnostic, msg.senderId]);

  // Fork/edit affordances read fork state + the outbox editor from context.
  // Read optionally so the card still renders provider-less (tests, standalone
  // transcript views); the affordances simply stay hidden without a provider.
  const forkState = messageActions?.forkState;
  const editPendingMessage = messageActions?.editPendingMessage;
  // Edit dialog: "outbox" edits the unread message in place; "fork" seeds an
  // edit-fork (own read messages) or a steer-fork (agent messages).
  const [editMode, setEditMode] = useState<null | "outbox" | "fork">(null);
  const [editText, setEditText] = useState("");
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);
  const openEdit = useCallback(
    (mode: "outbox" | "fork") => {
      setEditText(msg.content);
      setForkError(null);
      setEditMode(mode);
    },
    [msg.content],
  );
  const forkFromHere = useCallback(() => {
    setForkError(null);
    void forkState?.actions.forkFromMessage(msg).catch((err) => {
      console.error("[MessageCard] fork failed:", err);
      setForkError(errorMessage(err, "Fork failed"));
    });
  }, [forkState, msg]);
  const submitEdit = useCallback(async () => {
    const text = editText;
    const mode = editMode;
    if (!text.trim()) return;
    setForkError(null);
    setEditSubmitting(true);
    try {
      if (mode === "outbox") {
        await editPendingMessage?.(msg.id, text);
      } else if (mode === "fork") {
        await forkState?.actions.editAndForkMessage(msg, text);
      }
      setEditMode(null);
    } catch (err) {
      console.error("[MessageCard] edit failed:", err);
      if (mode === "fork")
        setForkError(errorMessage(err, "Edit and fork failed"));
    } finally {
      setEditSubmitting(false);
    }
  }, [editText, editMode, editPendingMessage, forkState, msg]);

  // Handle inline_ui messages
  if (msg.contentType === CONTENT_TYPE_INLINE_UI) {
    const data = msg.inlineUi ?? parseInlineUiData(msg.content);
    if (data) {
      const compiled = inlineUiComponents?.get(data.id);
      return (
        <Box
          key={key}
          className="message-row message-row-agent message-row-inline-ui"
        >
          <InlineUiMessage
            data={data}
            messageId={msg.id}
            compiledComponent={compiled?.Component}
            compilationError={compiled?.error}
            compilationErrorStack={compiled?.errorStack}
            runtime={compiled?.runtime}
          />
        </Box>
      );
    }
  }

  // Model credential connect card — rendered from the channel's unresolved
  // credential requests (agentic.credential-connect.v1 envelopes).
  if (msg.contentType === "credential-connect" && msg.credentialRequest) {
    const request = msg.credentialRequest;
    return (
      <Box key={key} className="message-row message-row-system">
        <ModelCredentialRequiredCard
          props={{
            ...(request.connectSpec as Record<string, unknown>),
            providerId: request.providerId,
            ...(request.modelBaseUrl
              ? { modelBaseUrl: request.modelBaseUrl }
              : {}),
            ...(request.reason ? { reason: request.reason } : {}),
            ...(request.failureCode
              ? { failureCode: request.failureCode }
              : {}),
            agentParticipantId: request.agentParticipantId,
            ...(selfId ? { modelPersistenceParticipantId: selfId } : {}),
            ...(browserHandoffCaller
              ? {
                  browserHandoffCallerId: browserHandoffCaller.id,
                  browserHandoffCallerKind: browserHandoffCaller.kind,
                }
              : {}),
          }}
          chat={
            chat as {
              callMethod: (
                participantId: string,
                method: string,
                args: unknown,
              ) => Promise<unknown>;
            }
          }
        />
      </Box>
    );
  }

  // Handle system messages (e.g., agent disconnection notifications)
  if (
    msg.contentType === "automation" &&
    (msg.automation || msg.automationDefinition) &&
    automationClient
  ) {
    return (
      <Box key={key} className="message-row message-row-system">
        {msg.automation ? (
          <AutomationActivity
            activity={msg.automation}
            client={automationClient}
          />
        ) : (
          <AutomationActivity
            definition={msg.automationDefinition!}
            client={automationClient}
          />
        )}
      </Box>
    );
  }

  if (msg.kind === "system" && msg.disconnectedAgent) {
    return (
      <Box key={key} className="message-row message-row-system">
        <AgentDisconnectedMessage
          agent={msg.disconnectedAgent}
          onFocusPanel={onFocusPanel}
          onReloadPanel={onReloadPanel}
        />
      </Box>
    );
  }

  if (msg.contentType === "lifecycle" && msg.lifecycle) {
    const color =
      msg.lifecycle.status === "recovered"
        ? "green"
        : msg.lifecycle.status === "failed"
          ? "red"
          : "amber";
    const badgeLabel =
      msg.lifecycle.status === "recovered"
        ? "Recovered"
        : msg.lifecycle.status === "failed"
          ? "Recovery failed"
          : msg.lifecycle.status === "waiting"
            ? "Waiting"
            : "Interrupted";
    return (
      <Box key={key} className="message-row message-row-system">
        <Card className="message-card message-card-lifecycle">
          <Flex align="start" gap="2">
            <Box className="message-lifecycle-icon" aria-hidden="true">
              <ReloadIcon />
            </Box>
            <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
              <Flex align="center" gap="2" wrap="wrap">
                <Badge color={color} size="1" variant="soft">
                  {badgeLabel}
                </Badge>
                <Text size="2" weight="medium">
                  {msg.lifecycle.title}
                </Text>
              </Flex>
              {(msg.lifecycle.detail || msg.content) && (
                <Text size="1" color="gray" style={{ whiteSpace: "pre-wrap" }}>
                  {msg.lifecycle.detail ?? msg.content}
                </Text>
              )}
            </Flex>
          </Flex>
        </Card>
      </Box>
    );
  }

  if (msg.contentType === "diagnostic" && msg.diagnostic) {
    const color =
      msg.diagnostic.severity === "error"
        ? "red"
        : msg.diagnostic.severity === "warning"
          ? "amber"
          : "blue";
    return (
      <Box key={key} className="message-row message-row-system">
        <Card className="message-card message-card-lifecycle">
          <Flex align="start" gap="2">
            <Box className="message-lifecycle-icon" aria-hidden="true">
              <ChatBubbleIcon />
            </Box>
            <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
              <Flex align="center" gap="2" wrap="wrap">
                <Badge color={color} size="1" variant="soft">
                  {msg.diagnostic.severity === "error"
                    ? "Error"
                    : msg.diagnostic.severity === "warning"
                      ? "Notice"
                      : "Info"}
                </Badge>
                <Text size="2" weight="medium">
                  {msg.diagnostic.title}
                </Text>
              </Flex>
              {(msg.diagnostic.detail || msg.content) && (
                <Text size="1" color="gray" style={{ whiteSpace: "pre-wrap" }}>
                  {msg.diagnostic.detail ?? msg.content}
                </Text>
              )}
              {msg.diagnostic.resetAt && msg.diagnostic.messageId && (
                <Flex align="center" gap="2" wrap="wrap">
                  <Button
                    size="1"
                    variant="soft"
                    color={resumeScheduleState === "failed" ? "red" : "blue"}
                    disabled={
                      resumeScheduleState === "scheduling" ||
                      resumeScheduleState === "scheduled"
                    }
                    onClick={handleScheduleResumeAtReset}
                    title="Resume this turn when the provider limit resets"
                  >
                    <ReloadIcon />
                    {resumeScheduleState === "scheduling"
                      ? "Scheduling"
                      : resumeScheduleState === "scheduled"
                        ? "Scheduled"
                        : resumeScheduleState === "failed"
                          ? "Retry scheduling"
                          : "Resume at reset"}
                  </Button>
                </Flex>
              )}
              {canRetryWithLocal && (
                <Flex align="center" gap="2" wrap="wrap">
                  <Button
                    size="1"
                    variant="soft"
                    color={retryLocalState === "failed" ? "red" : "blue"}
                    disabled={
                      retryLocalState === "switching" ||
                      retryLocalState === "ready" ||
                      retryLocalState === "sent"
                    }
                    onClick={handleRetryWithLocalModel}
                    title="Switch this agent to the local fallback model and prepare a retry"
                  >
                    <ReloadIcon />
                    {retryLocalState === "switching"
                      ? "Switching"
                      : retryLocalState === "ready"
                        ? "Ready — press Send"
                        : retryLocalState === "sent"
                          ? "Retry sent"
                          : retryLocalState === "failed"
                            ? "Retry local failed"
                            : "Retry with local model"}
                  </Button>
                </Flex>
              )}
              {canRetry && (
                <Flex align="center" gap="2" wrap="wrap">
                  <Button
                    size="1"
                    variant="soft"
                    color={retryState === "failed" ? "red" : "blue"}
                    disabled={
                      retryState === "sending" ||
                      retryState === "ready" ||
                      retryState === "sent"
                    }
                    onClick={handleRetry}
                    title="Retry this turn with the current model"
                  >
                    <ReloadIcon />
                    {retryState === "sending"
                      ? "Retrying"
                      : retryState === "ready"
                        ? "Ready — press Send"
                        : retryState === "sent"
                          ? "Retry sent"
                          : retryState === "failed"
                            ? "Retry failed"
                            : "Retry"}
                  </Button>
                </Flex>
              )}
              {canStartCleanLocalChat && (
                <Flex align="center" gap="2" wrap="wrap">
                  <Button
                    size="1"
                    variant="soft"
                    color={cleanStartState === "failed" ? "red" : "blue"}
                    disabled={
                      cleanStartState === "starting" ||
                      cleanStartState === "started"
                    }
                    onClick={handleStartCleanLocalChat}
                    title="Open a new chat with this local model and no previous transcript"
                  >
                    <ChatBubbleIcon />
                    {cleanStartState === "starting"
                      ? "Opening new chat"
                      : cleanStartState === "started"
                        ? "New chat opened"
                        : cleanStartState === "failed"
                          ? "New chat failed"
                          : "New chat without history"}
                  </Button>
                </Flex>
              )}
            </Flex>
          </Flex>
        </Card>
      </Box>
    );
  }

  if (msg.contentType === "approval" && msg.approval) {
    const approval = msg.approval;
    const color =
      approval.status === "granted"
        ? "green"
        : approval.status === "denied"
          ? "red"
          : "amber";
    const title =
      approval.status === "granted"
        ? "Approved"
        : approval.status === "denied"
          ? "Denied"
          : "Approval requested";
    return (
      <Box key={key} className="message-row message-row-agent">
        <Card className="message-card">
          <Flex direction="column" gap="2">
            <Flex align="center" gap="2" wrap="wrap">
              <Badge color={color} size="1" variant="soft">
                {title}
              </Badge>
            </Flex>
            {approval.question && (
              <Text size="2" style={{ whiteSpace: "pre-wrap" }}>
                {approval.question}
              </Text>
            )}
            {approval.reason && (
              <Text size="1" color={color} style={{ whiteSpace: "pre-wrap" }}>
                {approval.reason}
              </Text>
            )}
          </Flex>
        </Card>
      </Box>
    );
  }

  // Inline "conversation forked" annotation row (from ChannelViewState.forks).
  if (msg.contentType === "cross-channel-sent" && msg.crossChannel) {
    return <CrossChannelDispatchRow key={key} dispatch={msg.crossChannel} />;
  }
  if (msg.contentType === "fork" && msg.fork) {
    return <ForkRow key={key} fork={msg.fork} />;
  }

  const custom = msg.contentType === "custom" ? msg.custom : undefined;
  if (custom && custom.displayMode !== "inline") {
    return (
      <Box key={key} className="message-row message-row-agent">
        <CustomMessageCard
          payload={custom}
          entry={messageTypeComponents?.get(custom.typeId)}
          chat={chat}
        />
      </Box>
    );
  }

  // Client messages (panel, headless) render right-aligned in the user-side
  // styling. Agent messages render left-aligned in the agent styling.
  const isClient = isClientParticipantType(senderType);
  const hasError = Boolean(msg.error);
  const hasContent = msg.content.length > 0;
  const hasAttachments = msg.attachments && msg.attachments.length > 0;
  const modelLabel = msg.model?.displayName || msg.model?.ref;
  const showModelBadge = senderType === "agent" && Boolean(modelLabel);
  // Tier 2 (secondary salience) renders slighter — see styles.css. Absent ⇒ tier 1.
  const isSecondary = msg.tier === "secondary";
  const isSelfAuthored = Boolean(selfId && msg.senderId === selfId);
  const isEdited = msg.revision !== undefined || msg.editedAt !== undefined;
  // Show a delivery badge for the user's own non-retracted real messages.
  const showAckBadge =
    isSelfAuthored && !msg.retracted && !hasError && Boolean(msg.receipts);
  // An unread own message keeps the in-place outbox edit; a READ own message or
  // an agent message can only be forked (the `message.edited` reducer drops
  // edits once a recipient has read the message).
  const isUnreadOutbox =
    isSelfAuthored && (!msg.receipts || msg.receipts.aggregate === "pending");
  // Fork/edit menu available only once the message has a durable seq (fork point).
  const canFork =
    Boolean(forkState) && msg.seq !== undefined && !isStreaming && !msg.pending;
  const showForkMenu = canFork && msg.kind === "message";

  // A retracted message collapses to a slim tombstone — no content, actions,
  // or badge. The author canceled it before any recipient read it.
  if (msg.retracted) {
    return (
      <Box
        id={`message-${msg.id}`}
        className={classNames(
          "message-row",
          isClient ? "message-row-client" : "message-row-agent",
        )}
      >
        <Card className="message-card message-card-tombstone">
          <Flex align="center" gap="2">
            <Box className="message-tombstone-icon" aria-hidden="true">
              <Cross2Icon />
            </Box>
            <Text size="1" color="gray">
              Message canceled
            </Text>
          </Flex>
        </Card>
      </Box>
    );
  }

  return (
    <Box
      id={`message-${msg.id}`}
      data-part="message"
      data-message-role={isClient ? "player" : "agent"}
      data-message-tier={msg.tier ?? "primary"}
      className={classNames(
        "message-row",
        isClient ? "message-row-client" : "message-row-agent",
        isSecondary && "message-row-tier2",
      )}
    >
      <Card
        className={classNames(
          "message-card",
          isClient && "message-card-client",
          hasError && "message-card-error",
          isSecondary && "message-card-tier2",
        )}
      >
        <Flex className="message-card-body" direction="column" gap="2">
          <Flex align="center" justify="between" gap="2">
            <Flex align="center" gap="1" style={{ minWidth: 0 }}>
              {/* Live account avatar for human senders (WP6 §6, WP0 §3.8). */}
              {senderInfo.avatar && (
                <img
                  src={senderInfo.avatar}
                  alt=""
                  aria-hidden="true"
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    flexShrink: 0,
                    objectFit: "cover",
                  }}
                />
              )}
              <Box style={{ minWidth: 0 }}>
                <Text size="1" weight="medium" truncate>
                  {senderInfo.name}
                </Text>
                <Text
                  as="span"
                  size="1"
                  color="gray"
                  style={{
                    marginLeft: 6,
                    // Account tint (WP6 §6) — personalizes the handle only.
                    ...(senderInfo.color ? { color: senderInfo.color } : {}),
                  }}
                >
                  @{senderInfo.handle}
                </Text>
                {/* Guest chip (messaging plan §4.10.4): this participant is not
                    on our roster. The message is still an ordinary message —
                    someone talking — it just came from somewhere else. */}
                {msg.origin ? (
                  <GuestOriginChip origin={msg.origin} sender={msg.senderMetadata} />
                ) : null}
              </Box>
              {showModelBadge && (
                <Badge
                  size="1"
                  variant="soft"
                  color="gray"
                  title={modelLabel}
                  style={{
                    flexShrink: 1,
                    maxWidth: 180,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {modelLabel}
                </Badge>
              )}
              {/* Copy lives in the header (right after the handle) to keep the
                  card bottom free for content + the delivery badge. */}
              {hasContent && !isStreaming && (
                <IconButton
                  className="copy-button"
                  size="1"
                  variant="ghost"
                  color="gray"
                  style={{ flexShrink: 0 }}
                  onClick={handleCopy}
                  onBlur={handleClearCopied}
                  onPointerLeave={handleClearCopied}
                  title="Copy message"
                >
                  {isCopied ? <CheckIcon /> : <CopyIcon />}
                </IconButton>
              )}
            </Flex>
            {/* Top-bar right cluster: delivery status + edited marker + reply,
                kept in the header to save a whole row at the card bottom. */}
            <Flex align="center" gap="2" style={{ flexShrink: 0 }}>
              {isEdited && !isStreaming && (
                <Text size="1" color="gray" className="message-edited-marker">
                  edited
                </Text>
              )}
              {showAckBadge && !isStreaming && (
                <AckBadge
                  receipts={msg.receipts!}
                  participants={participants ?? {}}
                  mode="compact"
                />
              )}
              {onReply && hasContent && !isStreaming && (
                <IconButton
                  className="copy-button"
                  size="1"
                  variant="ghost"
                  color="gray"
                  onClick={handleReply}
                  title="Reply"
                >
                  <ChatBubbleIcon />
                </IconButton>
              )}
              {showForkMenu && (
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger>
                    <IconButton
                      className="copy-button"
                      size="1"
                      variant="ghost"
                      color="gray"
                      title="Message actions"
                      aria-label="Message actions"
                    >
                      <DotsHorizontalIcon />
                    </IconButton>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Content align="end">
                    <DropdownMenu.Item onSelect={forkFromHere}>
                      Fork from here
                    </DropdownMenu.Item>
                    {isUnreadOutbox ? (
                      <DropdownMenu.Item onSelect={() => openEdit("outbox")}>
                        Edit
                      </DropdownMenu.Item>
                    ) : (
                      <DropdownMenu.Item onSelect={() => openEdit("fork")}>
                        {isSelfAuthored ? "Edit & fork" : "Edit & fork (steer)"}
                      </DropdownMenu.Item>
                    )}
                  </DropdownMenu.Content>
                </DropdownMenu.Root>
              )}
            </Flex>
          </Flex>
          {msg.replaces && (
            <Text size="1" color="gray" className="message-edited-marker">
              ⑂ substituted this turn
            </Text>
          )}
          {forkError ? (
            <Text size="1" color="red">
              {forkError}
            </Text>
          ) : null}
          {replyContext && (
            <Box
              asChild
              style={{
                borderLeft: "2px solid var(--gray-a7)",
                paddingLeft: 8,
                cursor: "pointer",
              }}
            >
              <a href={`#message-${replyContext.id}`}>
                <Text size="1" color="gray" truncate>
                  Replying to {replyContext.senderName}: {replyContext.snippet}
                </Text>
              </a>
            </Box>
          )}
          {mentionLabels.length > 0 && (
            <Flex gap="1" wrap="wrap">
              {mentionLabels.map((label) => (
                <Badge key={label} size="1" variant="soft" color="blue">
                  @{label}
                </Badge>
              ))}
            </Flex>
          )}
          {hasContent && (
            <>
              <Box
                className="message-content"
                style={
                  !isStreaming &&
                  msg.content.length > 6_000 &&
                  !longContentExpanded
                    ? {
                        maxHeight: "28rem",
                        overflow: "hidden",
                        maskImage:
                          "linear-gradient(to bottom, black 85%, transparent)",
                      }
                    : undefined
                }
              >
                <MessageContent
                  content={msg.content}
                  isStreaming={isStreaming}
                  mdxActions={mdxActions}
                />
              </Box>
              {!isStreaming && msg.content.length > 6_000 ? (
                <Button
                  size="1"
                  variant="ghost"
                  color="gray"
                  onClick={() =>
                    setLongContentExpanded((expanded) => !expanded)
                  }
                >
                  {longContentExpanded ? "Show less" : "Show full message"}
                </Button>
              ) : null}
            </>
          )}
          {hasAttachments && <ImageGallery attachments={msg.attachments!} />}
          {msg.escalation && msg.escalation.alert !== "none" ? (
            <EscalationFooter
              escalation={msg.escalation}
              receipts={msg.receipts}
              participants={participants}
            />
          ) : null}
          {hasError && (
            <Text size="2" color="red" style={{ whiteSpace: "pre-wrap" }}>
              Error: {msg.error}
            </Text>
          )}
          {isStreaming && (
            <TypingIndicator
              isPaused={false}
              showInterruptButton={true}
              onInterrupt={handleInterrupt}
            />
          )}
        </Flex>
      </Card>
      <Dialog.Root
        open={editMode !== null}
        onOpenChange={(open) => !open && !editSubmitting && setEditMode(null)}
      >
        <Dialog.Content maxWidth="560px">
          <Dialog.Title>
            {editMode === "outbox" ? "Edit message" : "Edit & fork from here"}
          </Dialog.Title>
          <Dialog.Description size="1" color="gray">
            {editMode === "outbox"
              ? "Rewrite this unread message in place."
              : "Branches a new conversation seeded with your edited text; the original stays intact."}
          </Dialog.Description>
          <Box mt="3">
            <TextArea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={5}
              autoFocus
            />
          </Box>
          {forkError && editMode === "fork" ? (
            <Text as="p" size="1" color="red" mt="2">
              {forkError}
            </Text>
          ) : null}
          <Flex justify="end" gap="2" mt="3">
            <Dialog.Close>
              <Button variant="soft" color="gray" disabled={editSubmitting}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button
              disabled={editSubmitting || !editText.trim()}
              onClick={() => void submitEdit()}
            >
              {editSubmitting
                ? "Working…"
                : editMode === "outbox"
                  ? "Save"
                  : "Edit & fork"}
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </Box>
  );
});

/** Inline "conversation forked" annotation row + a Switch affordance. */
/**
 * The guest chip (messaging plan §4.10.4): the sender is not on this roster;
 * the message is still an ordinary message — someone talking — it just came
 * from somewhere else. The chip is the affordance to go there, landing on the
 * authoring envelope when the origin named one.
 */
function GuestOriginChip({
  origin,
  sender,
}: {
  origin: NonNullable<ChatMessage["origin"]>;
  sender?: { name?: string; handle?: string };
}) {
  const onOpenChannel = useOptionalChatMessageActions()?.onOpenChannel;
  const label = `◆ from ${origin.channelId}`;
  const open = () =>
    void Promise.resolve(
      onOpenChannel?.(origin.channelId, {
        ...(origin.envelopeId ? { focusMessageId: origin.envelopeId } : {}),
      })
    ).catch(() => undefined);
  const replyRef = sender?.handle
    ? `agent:${sender.handle}@${origin.channelId}`
    : `channel:${origin.channelId}`;
  return (
    <HoverCard.Root openDelay={250}>
      <HoverCard.Trigger>
        <Button
          size="1"
          variant="ghost"
          color="gray"
          style={{ marginLeft: 6, height: "auto", padding: "0 4px" }}
          title="Guest participant — hover for who this is; click to open where they spoke from"
          onClick={open}
          disabled={!onOpenChannel}
        >
          {label} {onOpenChannel ? "▸" : ""}
        </Button>
      </HoverCard.Trigger>
      <HoverCard.Content size="1" style={{ maxWidth: 320 }}>
        <Flex direction="column" gap="1">
          <Text size="2" weight="medium">
            {sender?.name ?? sender?.handle ?? origin.participantId}
            {sender?.handle ? (
              <Text size="1" color="gray">
                {" "}
                @{sender.handle}
              </Text>
            ) : null}
          </Text>
          <Text size="1" color="gray">
            Not on this roster — a guest speaking from another conversation.
          </Text>
          <Text size="1" color="gray">
            Origin: {origin.channelId}
          </Text>
          <Text size="1" color="gray">
            Reply ref: <code>{replyRef}</code>
          </Text>
          {onOpenChannel ? (
            <Button size="1" variant="soft" onClick={open}>
              Open their conversation
            </Button>
          ) : null}
        </Flex>
      </HoverCard.Content>
    </HoverCard.Root>
  );
}

/**
 * Escalation footer (messaging plan §4.10.5): the rung the sender declared and
 * how far it got, drawn from the same read receipts `AckBadge` uses. Metadata
 * on the message, never a second row.
 */
function EscalationFooter({
  escalation,
  receipts,
  participants,
}: {
  escalation: NonNullable<ChatMessage["escalation"]>;
  receipts: ChatMessage["receipts"];
  participants?: Record<string, Participant<ChatParticipantMetadata>>;
}) {
  const people = escalation.users.map((participantId) => {
    const participant = participants?.[participantId];
    const name =
      participant?.metadata?.name ??
      participant?.metadata?.handle ??
      participantId.replace(/^user:/u, "");
    const state = receipts?.byParticipant[participantId];
    return { participantId, name: String(name), state: state === "read" ? "read" : "sent" };
  });
  if (people.length === 0) return null;
  return (
    <Text size="1" color="gray" className="message-escalation-footer">
      ⤴{" "}
      {people.map((person, index) => (
        <span key={person.participantId}>
          {index > 0 ? ", " : ""}
          {person.name} · {escalation.alert} · {person.state}
        </span>
      ))}
    </Text>
  );
}

/**
 * Outgoing cross-channel dispatch (messaging plan §4.10.3).
 *
 * Deliberately marginalia, not a turn: it is the agent's own speech, but it was
 * said *somewhere else*. The body is the reference excerpt — the utterance
 * itself lives once, in the target channel's log (D15) — so this row must never
 * read as if the conversation happened here. Expanding observes that envelope
 * and its replies in place; `[Open ▸]` goes there.
 */
function CrossChannelDispatchRow({
  dispatch,
}: {
  dispatch: NonNullable<ChatMessage["crossChannel"]>;
}) {
  const actions = useOptionalChatMessageActions();
  const onOpenChannel = actions?.onOpenChannel;
  const childTranscript = actions?.childTranscript;
  const [open, setOpen] = useState(false);
  const observed = useForeignEnvelope({
    connection: childTranscript ?? null,
    channelId: dispatch.channelId,
    envelopeId: dispatch.envelopeId,
    enabled: open && Boolean(childTranscript),
  });
  const sender = dispatch.from.handle
    ? `@${dispatch.from.handle}`
    : (dispatch.from.displayName ?? dispatch.from.id);
  const target =
    dispatch.addressees && dispatch.addressees.length > 0
      ? dispatch.addressees
          // `agent:gmail@ch-1` reads as `@gmail`; the channel is named once, after "in".
          .map((ref) => ref.replace(/^agent:/u, "@").replace(/@[^@]+$/u, ""))
          .join(", ")
      : null;
  const canExpand = Boolean(childTranscript);
  const statusLabel = !open
    ? null
    : observed.error
      ? "unavailable"
      : observed.loading
        ? "looking…"
        : observed.status;
  const handleOpen = () => {
    if (!onOpenChannel) return;
    void Promise.resolve(
      onOpenChannel(dispatch.channelId, { focusMessageId: dispatch.envelopeId })
    ).catch(() => undefined);
  };
  return (
    <Box className="message-row message-row-system">
      <Card className="message-card message-card-lifecycle">
        <Flex direction="column" gap="1">
          <Flex align="center" gap="2" wrap="wrap">
            {canExpand ? (
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                aria-expanded={open}
                aria-label={open ? "Collapse" : "Show the message and replies"}
                onClick={() => setOpen((value) => !value)}
                style={{ transform: open ? "rotate(180deg)" : undefined }}
              >
                <ChevronDownIcon />
              </IconButton>
            ) : (
              <Text size="1" aria-hidden="true">
                ↗
              </Text>
            )}
            <Text size="1" color="gray" style={{ minWidth: 0, flex: 1 }}>
              {sender}
              {target ? ` → ${target}` : ""} in {dispatch.channelId}
              {statusLabel ? ` · ${statusLabel}` : ""}
            </Text>
            {onOpenChannel ? (
              <Button size="1" variant="ghost" color="gray" onClick={handleOpen} title="Open that conversation">
                Open <ExternalLinkIcon />
              </Button>
            ) : null}
          </Flex>
          {!open && dispatch.summary ? (
            <Text size="1" color="gray" style={{ minWidth: 0 }} truncate>
              “{dispatch.summary}”
            </Text>
          ) : null}
          {open ? (
            observed.error ? (
              <Text size="1" color="amber">
                Conversation no longer available ({observed.error}).
              </Text>
            ) : (
              <SubagentTranscriptContent transcript={observed} />
            )
          ) : null}
        </Flex>
      </Card>
    </Box>
  );
}

function ForkRow({ fork }: { fork: NonNullable<ChatMessage["fork"]> }) {
  const forkState = useOptionalChatMessageActions()?.forkState;
  if (fork.archived) return null;
  const actorName = fork.actor.displayName ?? fork.actor.id;
  return (
    <Box className="message-row message-row-system">
      <Card className="message-card message-card-lifecycle">
        <Flex align="center" gap="2" wrap="wrap">
          <Text size="1" aria-hidden="true">
            ⑂
          </Text>
          <Text size="1" color="gray" style={{ minWidth: 0 }}>
            {actorName} forked this conversation from message {fork.forkPointId}
            {fork.label ? ` — ${fork.label}` : ""}
          </Text>
          <Button
            size="1"
            variant="ghost"
            onClick={() => {
              if (!forkState) return;
              forkState.actions.clearError();
              void (async () => {
                try {
                  await forkState.actions.markForkRead?.(
                    fork.forkedChannelId,
                    fork.headSeq,
                  );
                } catch (cause) {
                  forkState.actions.reportError(
                    "Could not save the conversation read position",
                    cause,
                  );
                }
                try {
                  await forkState.actions.switchTo(
                    fork.forkedChannelId,
                    fork.forkedContextId,
                  );
                } catch (cause) {
                  forkState.actions.reportError(
                    "Could not switch conversations",
                    cause,
                  );
                }
              })();
            }}
          >
            Switch
          </Button>
        </Flex>
      </Card>
    </Box>
  );
}
