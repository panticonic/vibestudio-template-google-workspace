import { useEffect, useMemo } from "react";
import { buildResolvedKeymap, eventToChord, sanitizeKeybindingOverrides, type KeybindingAction, type KeybindingOverrides } from "./keybindings.js";

export type KeybindingHandlers = Partial<Record<KeybindingAction, (event: KeyboardEvent) => void>>;

export function useKeybindings(keymap: KeybindingOverrides, handlers: KeybindingHandlers, enabled = true): void {
  const resolved = useMemo(() => buildResolvedKeymap(sanitizeKeybindingOverrides(keymap)), [keymap]);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const action = resolved[eventToChord(event)];
      if (!action) return;
      const handler = handlers[action];
      if (!handler) return;
      if (isEditableTarget(event.target) && event.key !== "Escape" && !event.metaKey && !(event.ctrlKey && event.shiftKey)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      handler(event);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [enabled, handlers, resolved]);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}
