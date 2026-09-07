import type { TerminalState } from "./types.js";

type SettingsPatch = Partial<Pick<
  TerminalState,
  "fontSize" | "scrollbackBytes" | "themeOverride" | "pasteMode" | "imagePasteRelative"
>>;

export function settingsToastMessage(next: SettingsPatch): string | undefined {
  if (typeof next.fontSize === "number") return `Font ${next.fontSize}px`;
  if (typeof next.scrollbackBytes === "number") return `Scrollback ${formatBytes(next.scrollbackBytes)}`;
  if (next.themeOverride) return `Theme ${themeLabel(next.themeOverride)}`;
  if (next.pasteMode) return `Paste files as ${pasteModeLabel(next.pasteMode)}`;
  if (typeof next.imagePasteRelative === "boolean") {
    return next.imagePasteRelative ? "Relative file paths on" : "Relative file paths off";
  }
  return undefined;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${bytes / (1024 * 1024)} MB`;
  return `${bytes / 1024} KB`;
}

function themeLabel(value: TerminalState["themeOverride"]): string {
  if (value === "auto") return "auto";
  if (value === "light") return "light";
  return "dark";
}

function pasteModeLabel(value: TerminalState["pasteMode"]): string {
  if (value === "dataUri") return "data URI";
  if (value === "both") return "path and data URI";
  return "path";
}
