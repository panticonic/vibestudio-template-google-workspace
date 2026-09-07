/**
 * The conversation's chrome: heading, resume state, banners, transcript, and
 * the honest empty/disabled states — shared by the desktop overlay card and the
 * mobile sheet.
 *
 * Only the compose control itself stays client-owned, because the two are
 * genuinely different objects: desktop reuses the palette's input at the top of
 * the card (so the conversation reads downward from it), mobile has a keyboard-
 * anchored box at the bottom. Everything above and around that is the same
 * product, and is now the same code.
 */

import type { ReactNode } from "react";
import {
  resumeLabel,
  transcriptCards,
  type QuickfireCardActionId,
} from "../cards";
import type { QuickfireComposeView } from "../model";
import { useSkin } from "./primitives";
import { Transcript } from "./Transcript";

export type ConversationIntent =
  | { kind: "clear" }
  | { kind: "promote" }
  | { kind: "focus-promoted" }
  | { kind: "start-fresh" }
  | { kind: "show-older" }
  | { kind: "stop" }
  /** A suggested opener was tapped; the text goes on the wire as typed. */
  | { kind: "send"; text: string }
  /** Re-aim the conversation at a different panel (spec §4.1). */
  | { kind: "retarget" };

export interface ConversationProps {
  compose: QuickfireComposeView;
  /** Epoch ms, passed in so every relative time on the surface agrees. */
  now: number;
  onIntent: (intent: ConversationIntent) => void;
  /** Card actions only the surface can satisfy: promotion, image bytes, resend. */
  onCardAction?: (action: QuickfireCardActionId, value?: string) => void;
}

/**
 * Who you are talking to, and the two ways out of the conversation: throw it
 * away, or move it somewhere it can grow.
 */
export function ConversationHeader({
  compose,
  onIntent,
}: Omit<ConversationProps, "now">) {
  const { Box, Text, Icon, Pressable } = useSkin();
  const bound = compose.kind === "conversation";
  return (
    <Box row gap="sm" align="center" testId="quickfire-conversation-header">
      <Icon name={bound ? "bell" : "spark"} tone="accent" />
      <Text variant="heading" clamp>
        {compose.panelTitle}
      </Text>
      <Box grow />
      {bound ? null : (
        <Pressable
          variant="ghost"
          label="Clear this conversation and return to commands"
          disabled={!compose.hasConversation}
          onPress={() => onIntent({ kind: "clear" })}
        >
          <Text variant="caption" tone="muted">
            Clear
          </Text>
        </Pressable>
      )}
      <Pressable
        variant="ghost"
        tone="accent"
        label={
          bound
            ? "Open this conversation in its chat panel"
            : "Move this conversation into a chat panel, keeping its history"
        }
        disabled={!compose.hasConversation}
        onPress={() => onIntent({ kind: "promote" })}
      >
        <Text variant="caption" tone="accent">
          {bound ? "Open chat panel" : "Move to chat panel"}
        </Text>
      </Pressable>
    </Box>
  );
}

/**
 * The conversation between the heading and the compose row.
 *
 * `leading` is rendered directly against the input — the send hint on desktop,
 * where the input is above the transcript — so each client can put its own
 * affordances where its layout wants them without forking this component.
 */
export function ConversationBody({
  compose,
  now,
  onIntent,
  onCardAction,
  leading,
}: ConversationProps & { leading?: ReactNode }) {
  const { Box, Text, Spinner, Pressable } = useSkin();

  if (compose.promoted) {
    return (
      <Box gap="md" pad="md" testId="quickfire-promoted">
        <Text tone="muted">
          This conversation continues in a chat panel, which now owns it.
        </Text>
        <Box row gap="sm">
          <Pressable
            variant="primary"
            tone="accent"
            label="Open the chat panel this conversation continued into"
            onPress={() => onIntent({ kind: "focus-promoted" })}
          >
            <Text tone="accent" variant="strong">
              Continued in chat panel →
            </Text>
          </Pressable>
          <Pressable
            variant="ghost"
            label="Start a new conversation here"
            onPress={() => onIntent({ kind: "start-fresh" })}
          >
            <Text variant="caption" tone="muted">
              Start a new one here
            </Text>
          </Pressable>
        </Box>
      </Box>
    );
  }

  const cards = transcriptCards(compose.transcript, {
    now,
    ...(compose.transcriptOrder ? { order: compose.transcriptOrder } : {}),
    ...(compose.focusMessageId ? { focusId: compose.focusMessageId } : {}),
  });
  const older =
    compose.olderCount > 0 || compose.expandable || compose.loadingOlder ? (
      <Box row gap="sm" align="center" testId="quickfire-older">
        <Text variant="caption" tone="muted">
          {compose.olderCount > 0
            ? `${compose.olderCount} earlier ${compose.olderCount === 1 ? "entry" : "entries"}`
            : "Earlier history is available"}
        </Text>
        {compose.loadingOlder ? (
          <Box row gap="xs" align="center">
            <Spinner tone="accent" />
            <Text variant="caption" tone="muted">
              loading
            </Text>
          </Box>
        ) : compose.expandable ? (
          <Pressable
            variant="ghost"
            tone="accent"
            label="Show earlier entries in this conversation"
            onPress={() => onIntent({ kind: "show-older" })}
          >
            <Text variant="caption" tone="accent">
              show them
            </Text>
          </Pressable>
        ) : (
          <Pressable
            variant="ghost"
            tone="accent"
            label="Open the chat panel to read the whole conversation"
            onPress={() => onIntent({ kind: "promote" })}
          >
            <Text variant="caption" tone="accent">
              open the chat panel
            </Text>
          </Pressable>
        )}
      </Box>
    ) : null;

  return (
    <Box gap="sm">
      {leading}

      {compose.resume ? (
        <Box
          row
          gap="sm"
          align="center"
          surface="sunken"
          pad="sm"
          testId="quickfire-resume-chip"
        >
          <Text variant="caption" tone="muted">
            {resumeLabel(compose.resume, now)}
          </Text>
          <Box grow />
          <Pressable
            variant="ghost"
            tone="accent"
            label="Open the whole conversation in a chat panel"
            onPress={() => onIntent({ kind: "promote" })}
          >
            <Text variant="caption" tone="accent">
              show all →
            </Text>
          </Pressable>
        </Box>
      ) : null}

      {compose.credentialRequest ? (
        <Box
          surface="rail"
          tone="warning"
          pad="sm"
          gap="xs"
          testId="quickfire-credential"
        >
          <Text variant="label" tone="warning">
            Model credential needed
          </Text>
          <Text variant="caption" tone="muted">
            {compose.credentialRequest.reason ??
              `The ${compose.credentialRequest.providerId} connection needs attention.`}
          </Text>
          <Pressable
            variant="ghost"
            tone="accent"
            label="Reconnect the model in the chat panel"
            onPress={() => onIntent({ kind: "promote" })}
          >
            <Text variant="caption" tone="accent">
              Reconnect in chat →
            </Text>
          </Pressable>
        </Box>
      ) : null}

      {cards.length > 0 ? (
        <Transcript
          cards={cards}
          {...(older ? { header: older } : {})}
          {...(onCardAction
            ? {
                onAction: (action, _card, value) => onCardAction(action, value),
              }
            : {})}
        />
      ) : (
        <Box gap="sm">
          {older}
          <Box gap="sm" pad="md" testId="quickfire-empty">
            <Box row gap="sm" align="center" live>
              {compose.connecting ? <Spinner tone="accent" /> : null}
              <Text tone="muted">
                {compose.connecting
                  ? compose.kind === "conversation"
                    ? "Opening the conversation…"
                    : "Starting a conversation about this panel…"
                  : compose.hint}
              </Text>
            </Box>
            {compose.suggestions?.length ? (
              <Box row gap="sm" testId="quickfire-suggestions">
                {compose.suggestions.map((suggestion) => (
                  <Pressable
                    key={suggestion.id}
                    variant="primary"
                    tone="accent"
                    label={suggestion.prompt}
                    onPress={() =>
                      onIntent({ kind: "send", text: suggestion.prompt })
                    }
                  >
                    <Text variant="caption" tone="accent">
                      {suggestion.label}
                    </Text>
                  </Pressable>
                ))}
              </Box>
            ) : null}
          </Box>
        </Box>
      )}

      {compose.error ? (
        <Box surface="rail" tone="danger" pad="sm" testId="quickfire-error">
          <Text variant="caption" tone="danger" selectable>
            {compose.error}
          </Text>
        </Box>
      ) : null}

      {compose.disabledReason && compose.disabledReason !== compose.error ? (
        <Box surface="rail" tone="warning" pad="sm" testId="quickfire-disabled">
          <Text variant="caption" tone="warning">
            {compose.disabledReason}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
