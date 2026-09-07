import { Card, Flex, IconButton, Text } from "@radix-ui/themes";
import { Cross1Icon } from "@radix-ui/react-icons";
import { useCallback, useEffect, useState } from "react";

export interface PaneToast {
  id: number;
  title: string;
  message?: string;
  severity: "info" | "error";
}

export function useToast(): {
  toast: PaneToast | null;
  showToast(title: string, message?: string, severity?: "info" | "error"): void;
  dismissToast(): void;
} {
  const [toasts, setToasts] = useState<PaneToast[]>([]);
  const toast = toasts[0] ?? null;

  const showToast = useCallback((title: string, message?: string, severity: "info" | "error" = "info") => {
    setToasts((current) => [
      ...current,
      { id: Date.now() + Math.random(), title, message, severity },
    ].slice(-5));
  }, []);
  const dismissToast = useCallback(() => setToasts((current) => current.slice(1)), []);

  useEffect(() => {
    if (!toast) return;
    const textLength = toast.title.length + (toast.message?.length ?? 0);
    const ttl = toast.severity === "error"
      ? Math.max(6_000, textLength * 70)
      : Math.max(1_800, textLength * 45);
    const timer = setTimeout(() => setToasts((current) => current.slice(1)), ttl);
    return () => clearTimeout(timer);
  }, [toast]);

  return { toast, showToast, dismissToast };
}

export function Toast(props: { toast: PaneToast | null; onDismiss?(): void }) {
  if (!props.toast) return null;
  return (
    <Card
      size="1"
      data-surface-tone={props.toast.severity === "error" ? "error" : "info"}
      style={{
        position: "absolute",
        right: "var(--space-3)",
        bottom: "var(--space-3)",
        zIndex: 10,
        boxShadow: "var(--shadow-4)",
        transition: "opacity 150ms, transform 150ms",
      }}
    >
      <Flex align="start" gap="2">
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text size="2" weight="medium" color={props.toast.severity === "error" ? "red" : undefined}>
            {props.toast.title}
          </Text>
          {props.toast.message ? <Text size="1" color="gray" as="div">{props.toast.message}</Text> : null}
        </div>
        {props.onDismiss ? (
          <IconButton size="1" variant="ghost" color="gray" aria-label="Dismiss notification" onClick={props.onDismiss}>
            <Cross1Icon />
          </IconButton>
        ) : null}
      </Flex>
    </Card>
  );
}
