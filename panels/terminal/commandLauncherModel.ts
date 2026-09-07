export type CommandRunTarget = "here" | "splitRight" | "splitDown";

export function commandTargetForEnter(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey">): CommandRunTarget {
  // Plain Enter uses the shell already in focus. Mod+Enter opens right and
  // Shift+Enter opens down, providing a keyboard path to every target.
  if (event.shiftKey) return "splitDown";
  if (event.ctrlKey || event.metaKey) return "splitRight";
  return "here";
}

export function hasCommandTargetModifier(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey">): boolean {
  return event.ctrlKey || event.metaKey || event.shiftKey;
}
