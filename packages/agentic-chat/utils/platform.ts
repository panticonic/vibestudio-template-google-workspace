/**
 * Tiny platform helper for keyboard-shortcut labels. Mac surfaces the Cmd
 * glyphs (⌘ / ⇧ / ↵); every other platform uses Ctrl text. Handlers always
 * gate on `metaKey || ctrlKey` so both paths work regardless of label.
 */

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent ??
    "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** The primary modifier label ("⌘" on Mac, "Ctrl" elsewhere). */
export function modKeyLabel(mac = isMacPlatform()): string {
  return mac ? "⌘" : "Ctrl";
}

/** The shift label ("⇧" on Mac, "Shift" elsewhere). */
export function shiftKeyLabel(mac = isMacPlatform()): string {
  return mac ? "⇧" : "Shift";
}

/** The enter/return label ("↵" on Mac, "Enter" elsewhere). */
export function enterKeyLabel(mac = isMacPlatform()): string {
  return mac ? "↵" : "Enter";
}

/** Joined shortcut label, e.g. "⌘↵" on Mac or "Ctrl+Enter" elsewhere. */
export function shortcutLabel(
  parts: { mod?: boolean; shift?: boolean; enter?: boolean },
  mac = isMacPlatform()
): string {
  const tokens: string[] = [];
  if (parts.mod) tokens.push(modKeyLabel(mac));
  if (parts.shift) tokens.push(shiftKeyLabel(mac));
  if (parts.enter) tokens.push(enterKeyLabel(mac));
  return mac ? tokens.join("") : tokens.join("+");
}
