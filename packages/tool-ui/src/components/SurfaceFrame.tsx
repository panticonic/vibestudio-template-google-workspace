import { Box, Button, Card, Flex, Text, type ButtonProps } from "@radix-ui/themes";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  Cross2Icon,
  DragHandleHorizontalIcon,
} from "@radix-ui/react-icons";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useViewportHeight } from "@workspace/react/responsive";
import { EventErrorBoundary } from "./EventErrorBoundary";

export type SurfaceTone = "gray" | "blue" | "green" | "amber" | "red";

export interface SurfaceFrameProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  tone?: SurfaceTone;
  badge?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  collapsible?: boolean;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onHeaderClick?: () => void;
  onDismiss?: () => void;
  onError?: (error: Error) => void;
  resizable?: boolean;
  maxHeightFraction?: number;
  minHeight?: number;
  bodyPadding?: "0" | "1" | "2" | "3";
}

export function SurfaceFrame({
  title,
  subtitle,
  icon,
  tone = "gray",
  badge,
  actions,
  children,
  className,
  collapsible = false,
  defaultExpanded = true,
  expanded,
  onExpandedChange,
  onHeaderClick,
  onDismiss,
  onError,
  resizable = false,
  maxHeightFraction = 0.5,
  minHeight = 100,
  bodyPadding = "2",
}: SurfaceFrameProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const isExpanded = expanded ?? internalExpanded;
  const [manualHeight, setManualHeight] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);
  const cardRef = useRef<HTMLDivElement>(null);

  const viewportHeight = useViewportHeight();
  const maxHeight = Math.floor(viewportHeight * maxHeightFraction);
  const maxHeightRef = useRef(maxHeight);
  maxHeightRef.current = maxHeight;

  const setExpanded = useCallback(
    (next: boolean) => {
      if (expanded === undefined) setInternalExpanded(next);
      onExpandedChange?.(next);
    },
    [expanded, onExpandedChange]
  );

  const toggleExpanded = useCallback(() => {
    if (!collapsible) return;
    setExpanded(!isExpanded);
  }, [collapsible, isExpanded, setExpanded]);

  const handleHeaderClick = useCallback(() => {
    onHeaderClick?.();
    toggleExpanded();
  }, [onHeaderClick, toggleExpanded]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (!resizable) return;
      event.preventDefault();
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
      setIsDragging(true);
      dragStartY.current = event.clientY;
      dragStartHeight.current = cardRef.current?.offsetHeight ?? 200;
    },
    [resizable]
  );

  useEffect(() => {
    if (!isDragging) return;

    const handlePointerMove = (event: PointerEvent) => {
      const deltaY = dragStartY.current - event.clientY;
      const nextHeight = Math.min(
        maxHeightRef.current,
        Math.max(minHeight, dragStartHeight.current + deltaY)
      );
      setManualHeight(nextHeight);
    };

    const handlePointerUp = () => setIsDragging(false);
    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("pointercancel", handlePointerUp);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [isDragging, minHeight]);

  const headerInteractive = collapsible || onHeaderClick;
  const surfaceBackground = `var(--tool-surface-background, var(--tool-surface-${tone}-background, var(--color-panel)))`;
  const surfaceBorder = `var(--tool-surface-border, var(--tool-surface-${tone}-border, var(--${tone}-a4)))`;
  const surfaceStyle: CSSProperties & Record<"--card-background-color", string> = {
    "--card-background-color": surfaceBackground,
    position: "relative",
    display: "flex",
    flexDirection: "column",
    ...(resizable
      ? manualHeight != null
        ? { height: manualHeight, minHeight }
        : { maxHeight }
      : {}),
    flexShrink: 0,
    overflow: "hidden",
    border: `1px solid ${surfaceBorder}`,
    background: surfaceBackground,
  };
  const handleHeaderKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (!headerInteractive) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      handleHeaderClick();
    },
    [handleHeaderClick, headerInteractive]
  );

  return (
    <Card
      ref={cardRef}
      className={className}
      data-part="tool-surface"
      data-tone={tone}
      variant="surface"
      size="1"
      style={surfaceStyle}
    >
      {resizable && (
        <Box
          data-part="tool-surface-resize-handle"
          onPointerDown={handlePointerDown}
          style={{
            height: 14,
            cursor: "ns-resize",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: isDragging
              ? "var(--tool-surface-handle-active, var(--gray-5))"
              : "var(--tool-surface-handle, var(--gray-4))",
            borderBottom: "1px solid var(--tool-surface-handle-border, var(--gray-5))",
            flexShrink: 0,
            userSelect: "none",
            touchAction: "none",
          }}
        >
          <DragHandleHorizontalIcon
            style={{ color: "var(--tool-surface-muted, var(--gray-9))", width: 16, height: 16 }}
          />
        </Box>
      )}

      <Flex
        data-part="tool-surface-header"
        align="center"
        gap="2"
        px="2"
        py="1"
        flexShrink="0"
        onClick={headerInteractive ? handleHeaderClick : undefined}
        onKeyDown={headerInteractive ? handleHeaderKeyDown : undefined}
        tabIndex={headerInteractive ? 0 : undefined}
        role={headerInteractive ? "button" : undefined}
        aria-expanded={collapsible ? isExpanded : undefined}
        style={{
          cursor: headerInteractive ? "pointer" : undefined,
          userSelect: headerInteractive ? "none" : undefined,
          borderBottom: isExpanded
            ? "1px solid var(--tool-surface-header-border, var(--gray-a4))"
            : "none",
        }}
      >
        {icon && (
          <Text
            style={{
              display: "flex",
              alignItems: "center",
              flexShrink: 0,
              color: `var(--tool-surface-accent, var(--${tone}-11))`,
            }}
          >
            {icon}
          </Text>
        )}
        <Flex direction="column" gap="0" style={{ minWidth: 0, flex: 1 }}>
          <Text
            data-part="tool-surface-title"
            size="1"
            weight="medium"
            truncate
            style={{ color: `var(--tool-surface-accent, var(--${tone}-11))` }}
          >
            {title}
          </Text>
          {subtitle && (
            <Text size="1" truncate style={{ color: "var(--tool-surface-muted, var(--gray-11))" }}>
              {subtitle}
            </Text>
          )}
        </Flex>
        {badge}
        {actions && (
          <Box
            onClick={(event) => event.stopPropagation()}
            style={{ display: "flex", alignItems: "center", flexShrink: 0 }}
          >
            {actions}
          </Box>
        )}
        {onDismiss && (
          <Button
            color="gray"
            variant="ghost"
            size="1"
            onClick={(event) => {
              event.stopPropagation();
              onDismiss();
            }}
            style={{ cursor: "pointer" }}
          >
            <Cross2Icon />
          </Button>
        )}
        {collapsible && (
          <Button
            color="gray"
            variant="ghost"
            size="1"
            tabIndex={-1}
            style={{ pointerEvents: "none" }}
          >
            {isExpanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
          </Button>
        )}
      </Flex>

      {isExpanded && (
        <Box
          data-part="tool-surface-body"
          px={bodyPadding}
          py={bodyPadding}
          flexGrow="1"
          style={{ minHeight: 0, overflow: "auto" }}
        >
          {onError ? (
            <EventErrorBoundary onError={onError}>{children}</EventErrorBoundary>
          ) : (
            children
          )}
        </Box>
      )}
    </Card>
  );
}

export function surfaceButtonProps(): Pick<ButtonProps, "size" | "variant"> {
  return { size: "1", variant: "ghost" };
}
