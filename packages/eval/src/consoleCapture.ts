export interface ConsoleEntry {
  level: "log" | "warn" | "error" | "info" | "debug";
  args: unknown[];
  timestamp: number;
}

export interface ConsoleCapture {
  /** Proxy console object to pass to executed code */
  proxy: Console;
  /** Get all captured entries */
  getEntries(): ConsoleEntry[];
  /** Subscribe to new entries (for streaming) */
  onEntry(callback: (entry: ConsoleEntry) => void): () => void;
  /** Number of older entries discarded after the configured capacity was reached. */
  getDroppedCount(): number;
  /** Maximum retained entries. Infinity when no bound was requested. */
  readonly capacity: number;
}

export function createConsoleCapture(
  options: { capacity?: number } = {},
): ConsoleCapture {
  const capacity =
    options.capacity === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.floor(options.capacity));
  const entries: ConsoleEntry[] = [];
  const listeners = new Set<(entry: ConsoleEntry) => void>();
  let dropped = 0;

  const createMethod =
    (level: ConsoleEntry["level"]) =>
    (...args: unknown[]) => {
      const entry: ConsoleEntry = {
        level,
        args,
        timestamp: Date.now(),
      };
      entries.push(entry);
      if (entries.length > capacity) {
        dropped += entries.length - capacity;
        entries.splice(0, entries.length - capacity);
      }
      listeners.forEach((cb) => cb(entry));
    };

  const proxy = {
    log: createMethod("log"),
    warn: createMethod("warn"),
    error: createMethod("error"),
    info: createMethod("info"),
    debug: createMethod("debug"),
    clear: () => {},
    table: createMethod("log"),
    dir: createMethod("log"),
    trace: createMethod("log"),
    group: () => {},
    groupEnd: () => {},
    groupCollapsed: () => {},
    time: () => {},
    timeEnd: () => {},
    timeLog: () => {},
    count: () => {},
    countReset: () => {},
    assert: (condition?: boolean, ...args: unknown[]) => {
      if (!condition) {
        createMethod("error")("Assertion failed:", ...args);
      }
    },
  } as Console;

  return {
    proxy,
    getEntries: () => [...entries],
    getDroppedCount: () => dropped,
    capacity,
    onEntry: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}

/**
 * Format a single console entry for streaming.
 */
export function formatConsoleEntry(entry: ConsoleEntry): string {
  const prefix = entry.level === "log" ? "" : `[${entry.level.toUpperCase()}] `;
  const argsStr = entry.args.map(formatArg).join(" ");
  return prefix + argsStr;
}

function formatArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack || arg.message;
  }
  if (typeof arg === "object" && arg !== null) {
    try {
      return JSON.stringify(arg, getCircularReplacer(), 2);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

function getCircularReplacer() {
  const seen = new WeakSet();
  return (_key: string, value: unknown) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value as object)) return "[Circular]";
      seen.add(value as object);
    }
    return value;
  };
}

/**
 * Format all console entries for final display.
 */
export function formatConsoleOutput(entries: ConsoleEntry[]): string {
  return entries.map(formatConsoleEntry).join("\n");
}
