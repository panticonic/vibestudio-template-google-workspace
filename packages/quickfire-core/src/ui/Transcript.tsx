/**
 * The conversation itself: one implementation, both clients (spec §4.3, §7.2).
 *
 * Everything here reads from `QuickfireCard` (../cards) and draws through the
 * skin (./primitives), so what a card *means* is decided in one pure module,
 * what it *looks like* is decided in one component tree, and what it is *made
 * of* is the only thing each platform still owns.
 *
 * The rule the old surfaces broke, and this one keeps: detail is always
 * reachable. A message's failure text, a tool's input and output, an approval's
 * reason, a card the venue cannot run — none of it is summarized away. It is
 * collapsed, which is a different thing, and every collapse says what is inside.
 */

import { useState, type ReactNode } from "react";
import type {
  QuickfireCard,
  QuickfireCardActionId,
  QuickfireDetail,
} from "../cards";
import { Markdown } from "./Markdown";
import { useSkin } from "./primitives";

export interface TranscriptProps {
  cards: readonly QuickfireCard[];
  /** Invoked when a card offers something this venue cannot do itself. */
  onAction?: (
    action: QuickfireCardActionId,
    card: QuickfireCard,
    value?: string,
  ) => void;
  /**
   * Rendered above the list when older entries were trimmed. The surface owns
   * the affordance because only it knows whether they can be pulled in.
   */
  header?: ReactNode;
  footer?: ReactNode;
}

export function Transcript({
  cards,
  onAction,
  header,
  footer,
}: TranscriptProps) {
  const { Box } = useSkin();
  return (
    <Box row gap="md" testId="quickfire-transcript">
      {header ? <Box full>{header}</Box> : null}
      {cards.map((card) => (
        <TranscriptCard
          key={card.id}
          card={card}
          {...(onAction ? { onAction } : {})}
        />
      ))}
      {footer ? <Box full>{footer}</Box> : null}
    </Box>
  );
}

export function TranscriptCard({
  card,
  onAction,
}: {
  card: QuickfireCard;
  onAction?: (
    action: QuickfireCardActionId,
    card: QuickfireCard,
    value?: string,
  ) => void;
}) {
  const { Box, Text, Icon, Spinner, Pill } = useSkin();
  const speech = card.layout === "speech";
  const agentMessage = card.kind === "message" && card.role === "agent";
  const answer = agentMessage && card.tier !== "secondary";
  const supportingSpeech = agentMessage && card.tier === "secondary";
  const presentationTone =
    answer && card.tone === "neutral" ? "accent" : card.tone;
  const standaloneWork = card.kind === "tool" ? card.work[0] : undefined;
  if (standaloneWork) {
    return (
      <WorkRecord
        record={standaloneWork}
        card={card}
        {...(onAction ? { onAction } : {})}
        testId={`quickfire-card-${card.id}`}
      />
    );
  }
  const compact = card.kind === "thinking" || card.kind === "activity";
  // Reasoning is a heading *and* a disclosure — it has nothing else in it. Two
  // rows for one idea read as a stutter, so the heading is the summary.
  const headerIsDisclosure =
    card.kind === "thinking" && card.details.length === 1;
  const header = (
    <Box row gap="xs" align="center">
      {card.busy ? (
        <Spinner tone={presentationTone} />
      ) : (
        <Icon name={card.glyph} tone={presentationTone} />
      )}
      {/* A speaker's name is a label; a thought is a sentence, and setting one
          in small caps makes it unreadable at exactly the size it is shown. */}
      <Text
        variant={card.kind === "thinking" ? "caption" : "label"}
        tone={answer ? presentationTone : speech ? "muted" : card.tone}
        clamp
      >
        {card.title}
      </Text>
      {card.badges.map((badge) => (
        <Pill key={badge.id} tone={badge.tone}>
          {badge.label}
        </Pill>
      ))}
      <Box grow />
      {card.meta ? (
        <Text variant="caption" tone="muted" clamp>
          {card.meta}
        </Text>
      ) : null}
    </Box>
  );
  return (
    <Box
      surface={
        answer ? "answer" : supportingSpeech || !speech ? "rail" : "card"
      }
      tone={answer ? presentationTone : card.tone}
      pad={answer ? "md" : "sm"}
      {...(compact ? { fit: true } : { full: true })}
      gap="xs"
      testId={`quickfire-card-${card.id}`}
      {...(card.busy ? { live: true } : {})}
      {...(card.focused ? { emphasis: true } : {})}
    >
      {/* A repeated "agent / agent / agent" column is noise; the first card in a
          run carries the heading and the rest continue under it. */}
      {card.continues || headerIsDisclosure ? null : header}

      {card.body ? (
        card.body.format === "markdown" ? (
          // The caret rides the last line of the prose, which is where a cursor
          // belongs; a block-level one reads as an empty bullet.
          <Markdown
            source={card.body.text}
            {...(card.busy && card.layout === "speech" ? { caret: true } : {})}
          />
        ) : (
          <Text selectable>{card.body.text}</Text>
        )
      ) : null}

      {card.details.map((detail) => (
        <Detail
          key={detail.id}
          detail={detail}
          tone={card.tone}
          {...(headerIsDisclosure
            ? { summary: header, label: card.title }
            : {})}
          defaultOpen={card.kind === "thinking" && card.busy}
        />
      ))}

      {card.work.length > 0 ? (
        <Box row gap="xs">
          {card.work.map((record) => (
            <WorkRecord
              key={record.id}
              record={record}
              card={card}
              {...(onAction ? { onAction } : {})}
            />
          ))}
        </Box>
      ) : null}

      {card.actions.length > 0 ? (
        <CardActions card={card} {...(onAction ? { onAction } : {})} />
      ) : null}
    </Box>
  );
}

function WorkRecord({
  record,
  card,
  onAction,
  testId,
}: {
  record: QuickfireCard["work"][number];
  card: QuickfireCard;
  onAction?: (
    action: QuickfireCardActionId,
    card: QuickfireCard,
    value?: string,
  ) => void;
  testId?: string;
}) {
  const { Box, Text, Icon, Spinner } = useSkin();
  return (
    <Box
      surface="outline"
      fit
      // A green frame around every completed call shouts about the ordinary
      // case; the glyph already says it went fine.
      {...(record.state === "done" ? {} : { tone: record.tone })}
      gap="none"
      {...(testId ? { testId } : {})}
    >
      <Detail
        tone={record.tone}
        summary={
          <Box row gap="xs" align="center">
            {record.busy ? (
              <Spinner tone={record.tone} />
            ) : (
              <Icon name={record.glyph} tone={record.tone} size="sm" />
            )}
            <Text variant="strong" tone={record.tone}>
              {record.name}
            </Text>
            <Text variant="caption" tone="muted">
              {record.statusLabel}
            </Text>
          </Box>
        }
        label={`${record.name} — ${record.statusLabel}`}
        detail={null}
        sections={record.details}
        extra={
          record.images.length > 0 ? (
            <Images
              images={record.images}
              {...(onAction ? { onAction } : {})}
              card={card}
            />
          ) : null
        }
      />
    </Box>
  );
}

function Images({
  images,
  card,
  onAction,
}: {
  images: QuickfireCard["work"][number]["images"];
  card: QuickfireCard;
  onAction?: (
    action: QuickfireCardActionId,
    card: QuickfireCard,
    value?: string,
  ) => void;
}) {
  const { Box, Text, Figure, Pressable } = useSkin();
  return (
    <Box gap="sm" pad="sm" testId="quickfire-images">
      {images.map((image) =>
        image.dataUrl ? (
          <Figure
            key={image.id}
            src={image.dataUrl}
            alt={image.alt}
            caption={image.label}
          />
        ) : (
          // Desktop keeps the bytes out of its props until they are wanted, so
          // the offer has to say what is behind it.
          <Pressable
            key={image.id}
            variant="ghost"
            tone="accent"
            label={`Show ${image.alt}, ${image.label}`}
            onPress={() => onAction?.("reveal-image", card, image.id)}
          >
            <Text variant="caption" tone="accent">
              Show image · {image.label}
            </Text>
          </Pressable>
        ),
      )}
    </Box>
  );
}

/**
 * The row of things you can do with a card.
 *
 * Copy is answered here rather than bubbled: the skin already knows how to put
 * text on the clipboard, the surface has nothing to add, and the confirmation
 * belongs next to the button that earned it.
 */
function CardActions({
  card,
  onAction,
}: {
  card: QuickfireCard;
  onAction?: (
    action: QuickfireCardActionId,
    card: QuickfireCard,
    value?: string,
  ) => void;
}) {
  const { Box, Text, Pressable, copy } = useSkin();
  const [copied, setCopied] = useState(false);
  return (
    <Box row gap="sm" hover testId="quickfire-card-actions">
      {card.actions.map((action) => (
        <Pressable
          key={action.id}
          variant="ghost"
          tone="accent"
          label={action.label}
          onPress={() => {
            if (action.id === "copy" && copy) {
              copy(action.value ?? card.plainText);
              setCopied(true);
              return;
            }
            onAction?.(action.id, card, action.value);
          }}
        >
          <Text variant="caption" tone="accent">
            {action.id === "copy"
              ? copied
                ? "Copied"
                : "Copy"
              : `${action.label} →`}
          </Text>
        </Pressable>
      ))}
    </Box>
  );
}

/**
 * A collapsed block of detail.
 *
 * Two shapes, one component: a single named payload (a message's failure text),
 * or a set of them under one summary (a tool call's input/progress/output).
 * Either way the summary names what is inside, so "expand" is never a gamble.
 */
function Detail({
  detail,
  sections,
  summary,
  label,
  tone,
  defaultOpen,
  extra,
}: {
  detail: QuickfireDetail | null;
  sections?: readonly QuickfireDetail[];
  summary?: ReactNode;
  label?: string;
  tone?: QuickfireCard["tone"];
  defaultOpen?: boolean;
  /** Rendered above the named sections — pictures before their JSON. */
  extra?: ReactNode;
}) {
  const { Box, Text, Disclosure, Code } = useSkin();
  const payload = sections ?? (detail ? [detail] : []);
  const summaryLabel = label ?? detail?.label ?? "Details";
  return (
    <Disclosure
      label={summaryLabel}
      {...(tone ? { tone } : {})}
      {...(defaultOpen ? { defaultOpen } : {})}
      summary={
        summary ?? (
          <Text variant="caption" tone="muted">
            {summaryLabel}
          </Text>
        )
      }
      testId={`quickfire-detail-${detail?.id ?? summaryLabel}`}
    >
      {extra}
      {payload.length === 0 ? (
        extra ? null : (
          <Text variant="caption" tone="muted">
            No details were recorded.
          </Text>
        )
      ) : (
        <Box gap="sm" pad="sm">
          {payload.map((section) =>
            section.format === "markdown" ? (
              <Box key={section.id} gap="xs">
                {sections ? (
                  <Text variant="label" tone="muted">
                    {section.label}
                  </Text>
                ) : null}
                <Markdown source={section.text} />
              </Box>
            ) : section.format === "text" ? (
              <Box key={section.id} gap="xs">
                {sections ? (
                  <Text variant="label" tone="muted">
                    {section.label}
                  </Text>
                ) : null}
                <Text selectable>{section.text}</Text>
              </Box>
            ) : (
              <Code
                key={section.id}
                text={section.text}
                language={section.language}
                caption={section.label}
              />
            ),
          )}
        </Box>
      )}
    </Disclosure>
  );
}
