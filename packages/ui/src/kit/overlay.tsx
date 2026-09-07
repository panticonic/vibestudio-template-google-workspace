/**
 * Shared dialog/popover wrappers enforcing ONE stacking-context policy.
 *
 * The recon flagged approval-bar vs dialog vs tooltip z-index confusion. These
 * wrappers pin overlay content to the `--z-*` tokens from `foundation.css` so the
 * whole app shares one overlay hierarchy:
 *
 *   chrome (10) < approval-bar (50) < popover (100) < dialog (200)
 *     < toast (300) < tooltip (400)
 */
import type { CSSProperties, ReactNode } from "react";
import { Dialog, Popover } from "@radix-ui/themes";

/** The z-index tokens, surfaced for callers that render bespoke overlays. */
export const OVERLAY_Z = {
  chrome: "var(--z-chrome)",
  approvalBar: "var(--z-approval-bar)",
  popover: "var(--z-popover)",
  dialog: "var(--z-dialog)",
  toast: "var(--z-toast)",
  tooltip: "var(--z-tooltip)",
} as const;

export interface AppDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Optional trigger element (omit when controlling `open` externally). */
  trigger?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Max content width. */
  maxWidth?: CSSProperties["maxWidth"];
  className?: string;
  style?: CSSProperties;
}

/**
 * A dialog pinned to the `--z-dialog` layer with the standard overlay
 * elevation. Provides title/description slots wired for a11y.
 */
export function AppDialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  maxWidth = 520,
  className,
  style,
}: AppDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger != null && <Dialog.Trigger>{trigger}</Dialog.Trigger>}
      <Dialog.Content
        className={className}
        style={{
          maxWidth,
          zIndex: OVERLAY_Z.dialog as unknown as number,
          boxShadow: "var(--elevation-overlay)",
          ...style,
        }}
      >
        {title != null && <Dialog.Title>{title}</Dialog.Title>}
        {description != null && <Dialog.Description>{description}</Dialog.Description>}
        {children}
      </Dialog.Content>
    </Dialog.Root>
  );
}

export interface AppPopoverProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger: ReactNode;
  children: ReactNode;
  side?: React.ComponentProps<typeof Popover.Content>["side"];
  align?: React.ComponentProps<typeof Popover.Content>["align"];
  width?: CSSProperties["width"];
  className?: string;
  style?: CSSProperties;
}

/** A popover pinned to the `--z-popover` layer below dialogs/toasts. */
export function AppPopover({
  open,
  onOpenChange,
  trigger,
  children,
  side,
  align,
  width,
  className,
  style,
}: AppPopoverProps) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger>{trigger}</Popover.Trigger>
      <Popover.Content
        side={side}
        align={align}
        className={className}
        style={{
          width,
          zIndex: OVERLAY_Z.popover as unknown as number,
          boxShadow: "var(--elevation-2)",
          ...style,
        }}
      >
        {children}
      </Popover.Content>
    </Popover.Root>
  );
}
