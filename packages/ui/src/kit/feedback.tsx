/**
 * Feedback primitives for the shared app-wide UI kit: a generalized status
 * Badge, a transient NarrationPill, an EmptyState, and a Snackbar/undo toast.
 *
 * All motion uses the centralized keyframes/tokens from `foundation.css` and the
 * one reduced-motion block there - these components add no per-component motion
 * media queries.
 */
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Badge as RadixBadge, Box, Button, Flex, Text } from "@radix-ui/themes";

/** The shared status vocabulary, mapped onto the semantic intent tokens. */
export type Intent = "info" | "success" | "warning" | "error" | "consent" | "neutral";

const INTENT_RADIX_COLOR: Record<Intent, React.ComponentProps<typeof RadixBadge>["color"]> = {
  info: "blue",
  success: "grass",
  warning: "amber",
  error: "red",
  consent: "iris",
  neutral: "gray",
};

export interface StatusBadgeProps {
  intent?: Intent;
  children: ReactNode;
  /** Optional leading glyph (icon/avatar). */
  icon?: ReactNode;
  /** Radix badge size. */
  size?: "1" | "2" | "3";
  variant?: React.ComponentProps<typeof RadixBadge>["variant"];
  /** Replay a small ack-pop when this key changes (e.g. a receipt resolving). */
  pulseKey?: string | number;
  className?: string;
  style?: CSSProperties;
}

/**
 * Generalized delivery/status badge - the chat `AckBadge` pattern made reusable.
 * Intent picks the semantic color so badges read consistently everywhere.
 */
export function StatusBadge({
  intent = "neutral",
  children,
  icon,
  size = "1",
  variant,
  pulseKey,
  className,
  style,
}: StatusBadgeProps) {
  return (
    <RadixBadge
      key={pulseKey}
      color={INTENT_RADIX_COLOR[intent]}
      size={size}
      variant={variant}
      className={className}
      style={
        pulseKey !== undefined
          ? {
              animation: "ack-pop var(--motion-base) var(--ease-emphasized)",
              ...style,
            }
          : style
      }
    >
      {icon}
      {children}
    </RadixBadge>
  );
}

export interface NarrationPillProps {
  children: ReactNode;
  icon?: ReactNode;
  intent?: Intent;
  className?: string;
  style?: CSSProperties;
}

const INTENT_VAR: Record<Intent, { fg: string; bg: string; border: string }> = {
  info: {
    fg: "var(--intent-info)",
    bg: "var(--intent-info-surface)",
    border: "var(--intent-info-border)",
  },
  success: {
    fg: "var(--intent-success)",
    bg: "var(--intent-success-surface)",
    border: "var(--intent-success-border)",
  },
  warning: {
    fg: "var(--intent-warning)",
    bg: "var(--intent-warning-surface)",
    border: "var(--intent-warning-border)",
  },
  error: {
    fg: "var(--intent-error)",
    bg: "var(--intent-error-surface)",
    border: "var(--intent-error-border)",
  },
  consent: {
    fg: "var(--intent-consent)",
    bg: "var(--intent-consent-surface)",
    border: "var(--intent-consent-border)",
  },
  neutral: { fg: "var(--gray-11)", bg: "var(--gray-a3)", border: "var(--gray-a6)" },
};

/**
 * A small transient pill that narrates a state change ("flushing...", "agent is
 * working"). Enters with the centralized `pill-in` keyframe.
 */
export function NarrationPill({
  children,
  icon,
  intent = "neutral",
  className,
  style,
}: NarrationPillProps) {
  const tone = INTENT_VAR[intent];
  return (
    <Flex
      align="center"
      gap="1"
      px="2"
      py="1"
      className={className}
      role="status"
      aria-live="polite"
      style={{
        borderRadius: 999,
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        color: tone.fg,
        fontSize: "var(--font-size-1)",
        lineHeight: 1.3,
        animation: "pill-in var(--motion-base) var(--ease-decelerate)",
        ...style,
      }}
    >
      {icon}
      <Text size="1" style={{ color: "inherit" }}>
        {children}
      </Text>
    </Flex>
  );
}

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** Optional primary action(s). */
  actions?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** A centered "nothing here yet" affordance for empty panes. */
export function EmptyState({
  icon,
  title,
  description,
  actions,
  className,
  style,
}: EmptyStateProps) {
  return (
    <Flex
      direction="column"
      align="center"
      justify="center"
      gap="3"
      className={className}
      style={{
        height: "100%",
        minHeight: 160,
        padding: "var(--space-5)",
        textAlign: "center",
        ...style,
      }}
    >
      {icon != null && <Box style={{ color: "var(--gray-9)", opacity: 0.9 }}>{icon}</Box>}
      <Box>
        <Text as="div" size="3" weight="medium">
          {title}
        </Text>
        {description != null && (
          <Text as="div" size="2" color="gray" mt="1">
            {description}
          </Text>
        )}
      </Box>
      {actions != null && (
        <Flex gap="2" align="center">
          {actions}
        </Flex>
      )}
    </Flex>
  );
}

export interface SnackbarProps {
  /** Whether the snackbar is shown. */
  open: boolean;
  message: ReactNode;
  intent?: Intent;
  /** Label for the action button (e.g. "Undo"). */
  actionLabel?: string;
  onAction?: () => void;
  /** Called when the snackbar auto-dismisses or is dismissed. */
  onDismiss?: () => void;
  /** Auto-dismiss after this many ms. `0` disables auto-dismiss. */
  durationMs?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * A bottom-anchored snackbar with an optional action (the client-side undo
 * pattern). Sits at the `--z-toast` layer of the one stacking-context policy.
 */
export function Snackbar({
  open,
  message,
  intent = "neutral",
  actionLabel,
  onAction,
  onDismiss,
  durationMs = 6000,
  className,
  style,
}: SnackbarProps) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!open || durationMs <= 0) return;
    const t = setTimeout(() => dismissRef.current?.(), durationMs);
    return () => clearTimeout(t);
  }, [open, durationMs]);

  if (!open) return null;
  const tone = INTENT_VAR[intent];
  return (
    <Flex
      align="center"
      gap="3"
      px="3"
      py="2"
      role="status"
      aria-live="polite"
      className={className}
      style={{
        position: "fixed",
        left: "50%",
        bottom: "var(--space-5)",
        transform: "translateX(-50%)",
        zIndex: "var(--z-toast)" as unknown as number,
        background: "var(--surface-raised)",
        border: `1px solid ${tone.border}`,
        borderRadius: "var(--radius-4)",
        boxShadow: "var(--elevation-overlay)",
        maxWidth: "min(560px, calc(100vw - var(--space-6)))",
        animation: "pill-in var(--motion-emphasized) var(--ease-decelerate)",
        ...style,
      }}
    >
      <Text size="2" style={{ minWidth: 0 }}>
        {message}
      </Text>
      {actionLabel != null && (
        <Button
          size="1"
          variant="soft"
          onClick={() => {
            onAction?.();
            dismissRef.current?.();
          }}
          style={{ flexShrink: 0 }}
        >
          {actionLabel}
        </Button>
      )}
    </Flex>
  );
}

/**
 * A tiny controller hook for the undo-snackbar pattern: call `show()` with a
 * message and an undo callback; it manages open/dismiss state.
 */
export function useSnackbar() {
  const [state, setState] = useState<{
    open: boolean;
    message: ReactNode;
    intent: Intent;
    onAction?: () => void;
    actionLabel?: string;
  }>({ open: false, message: null, intent: "neutral" });

  return {
    snackbar: {
      open: state.open,
      message: state.message,
      intent: state.intent,
      actionLabel: state.actionLabel,
      onAction: state.onAction,
      onDismiss: () => setState((s) => ({ ...s, open: false })),
    } satisfies SnackbarProps,
    show(opts: {
      message: ReactNode;
      intent?: Intent;
      actionLabel?: string;
      onAction?: () => void;
    }) {
      setState({
        open: true,
        message: opts.message,
        intent: opts.intent ?? "neutral",
        actionLabel: opts.actionLabel,
        onAction: opts.onAction,
      });
    },
    dismiss() {
      setState((s) => ({ ...s, open: false }));
    },
  };
}
