import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Button, IconButton } from "@radix-ui/themes";
import { CheckIcon, CopyIcon } from "@radix-ui/react-icons";

/**
 * Copy-to-clipboard with the usual "copied" flash. Extracted because the
 * expanded tool detail and the subagent card each grew their own copy of the
 * flag + timeout dance; they now flash for the same duration and report the
 * same accessible label.
 */
function useCopy(value: string): { copied: boolean; copy: (event: MouseEvent) => void } {
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      mounted.current = false;
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    []
  );

  const copy = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      void Promise.resolve(navigator.clipboard?.writeText(value)).then(() => {
        if (!mounted.current) return;
        setCopied(true);
        if (resetTimer.current !== null) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => {
          resetTimer.current = null;
          if (mounted.current) setCopied(false);
        }, 1200);
      });
    },
    [value]
  );
  return { copied, copy };
}

/** Icon-only copy affordance (identifier rows, dense headers). */
export function CopyIconButton({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const { copied, copy } = useCopy(value);
  return (
    <IconButton
      size="1"
      variant="ghost"
      color={copied ? "green" : "gray"}
      className={className}
      onClick={copy}
      title={copied ? "Copied" : label}
      aria-label={copied ? "Copied" : label}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  );
}

/**
 * Labelled copy affordance ("Copy details"). `ariaLabel` lets the accessible
 * name stay more specific than the visible text, which has to stay short.
 */
export function CopyButton({
  value,
  label,
  ariaLabel,
  copiedLabel = "Copied",
  style,
}: {
  value: string;
  label: string;
  ariaLabel?: string;
  copiedLabel?: string;
  style?: React.CSSProperties;
}) {
  const { copied, copy } = useCopy(value);
  const accessibleName = ariaLabel ?? label;
  return (
    <Button
      size="1"
      color="gray"
      variant="ghost"
      onClick={copy}
      aria-label={accessibleName}
      title={accessibleName}
      style={style}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? copiedLabel : label}
    </Button>
  );
}
