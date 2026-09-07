export const defaultKeybindings = {
  palette: "Mod+K",
  find: "Mod+F",
  findNext: "Mod+G",
  findPrev: "Shift+Mod+G",
  newPane: "Mod+Shift+T",
  splitRight: "Mod+D",
  splitDown: "Mod+Shift+D",
  closePane: "Mod+Shift+W",
  focusUp: "Mod+Alt+ArrowUp",
  focusDown: "Mod+Alt+ArrowDown",
  focusLeft: "Mod+Alt+H",
  focusRight: "Mod+Alt+L",
  fontUp: "Mod+Alt+=",
  fontDown: "Mod+Alt+-",
  fontReset: "Mod+Alt+0",
  toggleNotifications: "Mod+Shift+N",
  jumpToLatestUnread: "Mod+Shift+U",
  nextUnread: "F8",
  zoom: "Mod+Shift+Z",
  copy: "Mod+C",
  paste: "Mod+V",
  clear: "Mod+Shift+L",
  settings: "Mod+,",
  openScratch: "Mod+E",
  shortcuts: "Mod+Shift+/",
} as const;

export type KeybindingAction = keyof typeof defaultKeybindings;
export type KeybindingMap = Record<KeybindingAction, string>;
export type KeybindingOverrides = Partial<KeybindingMap>;

export interface KeybindingValidationIssue {
  action: KeybindingAction;
  chord: string;
  message: string;
}

export const neverBindPlainCtrl = new Set([
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
]);

export function resolveChord(chord: string, platform = defaultPlatform()): string {
  const isMac = /mac/i.test(platform);
  if (isMac) return normalizeChord(chord.replace(/\bMod\b/g, "Meta"));
  const hasMod = /(^|\+)Mod(?=\+|$)/i.test(chord);
  const hasExplicitShift = /(^|\+)Shift(?=\+|$)/i.test(chord);
  if (hasMod && hasExplicitShift) {
    return normalizeChord(
      chord.replace(/(^|\+)Mod(?=\+|$)/i, "$1Ctrl").replace(/(^|\+)Shift(?=\+|$)/i, "$1Alt")
    );
  }
  return normalizeChord(chord.replace(/\bMod\b/g, "Ctrl+Shift"));
}

/** Platform-resolved tokens for shortcut hints and editable placeholders. */
export function displayChord(chord: string, platform = defaultPlatform()): string[] {
  const resolved = resolveChord(chord, platform).split("+");
  return /mac/i.test(platform)
    ? resolved.map((token) => (token === "Meta" ? "⌘" : token === "Alt" ? "⌥" : token))
    : resolved;
}

function defaultPlatform(): string {
  return globalThis.navigator?.platform ?? "";
}

export function eventToChord(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.metaKey) parts.push("Meta");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey && !isShiftImplied(event)) parts.push("Shift");
  parts.push(normalizeKey(event.key));
  return parts.join("+");
}

export function isPlainEscapeEvent(event: KeyboardEvent): boolean {
  return (
    event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
  );
}

export function isForbiddenPlainCtrlChord(chord: string): boolean {
  const parts = chord.split("+");
  return (
    parts.length === 2 && parts[0] === "Ctrl" && neverBindPlainCtrl.has(parts[1]!.toLowerCase())
  );
}

export function buildResolvedKeymap(
  keymap: KeybindingOverrides = {},
  platform?: string
): Partial<Record<string, KeybindingAction>> {
  const merged = { ...defaultKeybindings, ...keymap };
  const resolved: Partial<Record<string, KeybindingAction>> = {};
  for (const [action, chord] of Object.entries(merged) as Array<[KeybindingAction, string]>) {
    const normalized = resolveChord(chord, platform);
    if (isForbiddenPlainCtrlChord(normalized)) continue;
    resolved[normalized] = action;
  }
  return resolved;
}

export function sanitizeKeybindingOverrides(
  overrides: KeybindingOverrides = {},
  platform?: string
): KeybindingOverrides {
  const issues = validateKeybindingOverrides(overrides, platform);
  const invalid = new Set(issues.map((issue) => issue.action));
  return Object.fromEntries(
    Object.entries(overrides).filter(
      ([action, chord]) => chord.trim() && !invalid.has(action as KeybindingAction)
    )
  ) as KeybindingOverrides;
}

export function validateKeybindingOverrides(
  overrides: KeybindingOverrides = {},
  platform?: string
): KeybindingValidationIssue[] {
  const issues: KeybindingValidationIssue[] = [];
  const seen = new Map<string, KeybindingAction>();
  const merged = { ...defaultKeybindings, ...overrides };
  for (const [action, chord] of Object.entries(merged) as Array<[KeybindingAction, string]>) {
    if (!chord.trim()) {
      if (action in overrides) issues.push({ action, chord, message: "Binding is empty." });
      continue;
    }
    const normalized = resolveChord(chord, platform);
    if (isForbiddenPlainCtrlChord(normalized)) {
      issues.push({
        action,
        chord,
        message: "Plain Ctrl+letter belongs to the shell. Use Mod or Ctrl+Shift.",
      });
      continue;
    }
    const existing = seen.get(normalized);
    if (existing) {
      issues.push({ action, chord, message: `Conflicts with ${actionLabel(existing)}.` });
      issues.push({
        action: existing,
        chord: merged[existing],
        message: `Conflicts with ${actionLabel(action)}.`,
      });
      continue;
    }
    seen.set(normalized, action);
  }
  return dedupeIssues(issues);
}

export function actionLabel(action: KeybindingAction): string {
  return action.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}

function normalizeChord(chord: string): string {
  const rawParts = chord
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const key = normalizeKey(rawParts.pop() ?? "");
  const modifiers = new Set(rawParts.map(normalizeModifier));
  const parts = ["Ctrl", "Meta", "Alt", "Shift"].filter((modifier) => modifiers.has(modifier));
  return [...parts, key].join("+");
}

function normalizeModifier(modifier: string): string {
  const clean = modifier.trim().toLowerCase();
  if (clean === "cmd" || clean === "command" || clean === "meta") return "Meta";
  if (clean === "ctrl" || clean === "control") return "Ctrl";
  if (clean === "option" || clean === "alt") return "Alt";
  if (clean === "shift") return "Shift";
  return modifier;
}

function dedupeIssues(issues: KeybindingValidationIssue[]): KeybindingValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.action}\0${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeKey(key: string): string {
  if (key === " ") return "Space";
  if (key === "+") return "=";
  if (key.startsWith("Arrow")) return key;
  if (/^f\d{1,2}$/i.test(key)) return key.toUpperCase();
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function isShiftImplied(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const key = event.key;
  return key.length === 1 && key.toUpperCase() === key && key.toLowerCase() !== key;
}
