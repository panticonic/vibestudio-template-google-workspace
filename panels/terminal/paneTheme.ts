export type TerminalAppearance = "light" | "dark" | "inherit";

export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export function resolveTerminalTheme(appearance: TerminalAppearance, element?: Element | null): XtermTheme {
  const styles = typeof document === "undefined"
    ? null
    : getComputedStyle(element ?? document.documentElement);
  const fallback = fallbackTheme(appearance);
  const token = (name: string, fallbackValue: string) => styles?.getPropertyValue(name).trim() || fallbackValue;
  return {
    background: token("--gray-1", fallback.background),
    foreground: token("--gray-12", fallback.foreground),
    cursor: token("--accent-11", fallback.cursor),
    selectionBackground: token("--accent-5", fallback.selectionBackground),
    black: token("--gray-8", fallback.black),
    red: token("--red-9", fallback.red),
    green: token("--green-9", fallback.green),
    yellow: token("--yellow-9", fallback.yellow),
    blue: token("--blue-9", fallback.blue),
    magenta: token("--purple-9", fallback.magenta),
    cyan: token("--cyan-9", fallback.cyan),
    white: token("--gray-11", fallback.white),
    brightBlack: token("--gray-10", fallback.brightBlack),
    brightRed: token("--red-11", fallback.brightRed),
    brightGreen: token("--green-11", fallback.brightGreen),
    brightYellow: token("--yellow-11", fallback.brightYellow),
    brightBlue: token("--blue-11", fallback.brightBlue),
    brightMagenta: token("--purple-11", fallback.brightMagenta),
    brightCyan: token("--cyan-11", fallback.brightCyan),
    brightWhite: token("--gray-12", fallback.brightWhite),
  };
}

function fallbackTheme(appearance: TerminalAppearance): XtermTheme {
  if (appearance === "light") {
    return {
      background: "#fcfcfd",
      foreground: "#1c2024",
      cursor: "#006adc",
      selectionBackground: "#d6eaff",
      black: "#8b8d98",
      red: "#e5484d",
      green: "#30a46c",
      yellow: "#f5d90a",
      blue: "#0090ff",
      magenta: "#8e4ec6",
      cyan: "#00a2c7",
      white: "#60646c",
      brightBlack: "#7e808a",
      brightRed: "#d64045",
      brightGreen: "#218358",
      brightYellow: "#ab6400",
      brightBlue: "#006adc",
      brightMagenta: "#6e56cf",
      brightCyan: "#007c9f",
      brightWhite: "#1c2024",
    };
  }
  return {
    background: "#111113",
    foreground: "#eeeeee",
    cursor: "#70b8ff",
    selectionBackground: "#1d4f85",
    black: "#6f6f76",
    red: "#e5484d",
    green: "#30a46c",
    yellow: "#f5d90a",
    blue: "#0090ff",
    magenta: "#8e4ec6",
    cyan: "#00a2c7",
    white: "#b4b4bb",
    brightBlack: "#7e808a",
    brightRed: "#ff6369",
    brightGreen: "#3dd68c",
    brightYellow: "#f0c000",
    brightBlue: "#70b8ff",
    brightMagenta: "#d19dff",
    brightCyan: "#00c2d7",
    brightWhite: "#eeeeee",
  };
}
