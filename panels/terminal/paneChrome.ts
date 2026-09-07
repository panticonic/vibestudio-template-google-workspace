import type { NotificationSeverity } from "./types.js";

export function paneBorderColor(severity: NotificationSeverity, focused: boolean): string {
  if (severity === "failure") return "var(--red-8)";
  if (severity === "approval") return "var(--amber-8)";
  if (severity === "waiting") return "var(--blue-8)";
  return focused ? "var(--accent-8)" : "var(--gray-5)";
}

export function paneAttentionShadow(severity: NotificationSeverity): string | undefined {
  if (severity === "failure") return "0 0 0 2px color-mix(in srgb, var(--red-8) 22%, transparent)";
  if (severity === "approval") return "0 0 0 2px color-mix(in srgb, var(--amber-8) 22%, transparent)";
  if (severity === "waiting") return "0 0 0 2px color-mix(in srgb, var(--blue-8) 18%, transparent)";
  return undefined;
}

export function headerBorderColor(severity: NotificationSeverity, focused: boolean): string {
  if (severity === "failure") return "var(--red-8)";
  if (severity === "approval") return "var(--amber-8)";
  if (severity === "waiting") return "var(--blue-8)";
  return focused ? "var(--accent-7)" : "var(--gray-5)";
}

export function headerBackground(focused: boolean): string {
  return focused ? "var(--accent-2)" : "var(--gray-2)";
}

export function severityDotColor(severity: NotificationSeverity, alive: boolean): string {
  if (!alive) return severity === "failure" ? "var(--red-9)" : "var(--gray-9)";
  if (severity === "failure") return "var(--red-9)";
  if (severity === "approval") return "var(--amber-9)";
  if (severity === "waiting") return "var(--blue-9)";
  if (severity === "done") return "var(--green-9)";
  return "var(--gray-9)";
}
