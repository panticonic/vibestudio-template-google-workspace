import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createConsoleCapture,
  formatConsoleEntry,
  formatConsoleOutput,
  type ConsoleEntry,
} from "./consoleCapture";

describe("createConsoleCapture", () => {
  describe("proxy methods", () => {
    it("captures log calls", () => {
      const capture = createConsoleCapture();
      capture.proxy.log("hello", "world");

      const entries = capture.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.level).toBe("log");
      expect(entries[0]!.args).toEqual(["hello", "world"]);
    });

    it("captures warn calls", () => {
      const capture = createConsoleCapture();
      capture.proxy.warn("warning!");

      const entries = capture.getEntries();
      expect(entries[0]!.level).toBe("warn");
    });

    it("captures error calls", () => {
      const capture = createConsoleCapture();
      capture.proxy.error("error!");

      const entries = capture.getEntries();
      expect(entries[0]!.level).toBe("error");
    });

    it("captures info calls", () => {
      const capture = createConsoleCapture();
      capture.proxy.info("info");

      const entries = capture.getEntries();
      expect(entries[0]!.level).toBe("info");
    });

    it("captures debug calls", () => {
      const capture = createConsoleCapture();
      capture.proxy.debug("debug");

      const entries = capture.getEntries();
      expect(entries[0]!.level).toBe("debug");
    });

    it("handles table as log", () => {
      const capture = createConsoleCapture();
      capture.proxy.table([1, 2, 3]);

      const entries = capture.getEntries();
      expect(entries[0]!.level).toBe("log");
    });

    it("handles dir as log", () => {
      const capture = createConsoleCapture();
      capture.proxy.dir({ a: 1 });

      const entries = capture.getEntries();
      expect(entries[0]!.level).toBe("log");
    });

    it("handles assert with false condition", () => {
      const capture = createConsoleCapture();
      capture.proxy.assert(false, "assertion failed");

      const entries = capture.getEntries();
      expect(entries[0]!.level).toBe("error");
      expect(entries[0]!.args).toContain("Assertion failed:");
    });

    it("handles assert with true condition (no-op)", () => {
      const capture = createConsoleCapture();
      capture.proxy.assert(true, "should not log");

      const entries = capture.getEntries();
      expect(entries).toHaveLength(0);
    });

    it("no-op methods don't throw", () => {
      const capture = createConsoleCapture();

      expect(() => {
        capture.proxy.clear();
        capture.proxy.group();
        capture.proxy.groupEnd();
        capture.proxy.groupCollapsed();
        capture.proxy.time();
        capture.proxy.timeEnd();
        capture.proxy.timeLog();
        capture.proxy.count();
        capture.proxy.countReset();
      }).not.toThrow();
    });
  });

  describe("timestamps", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("records timestamps", () => {
      vi.setSystemTime(new Date("2024-01-01T12:00:00Z"));
      const capture = createConsoleCapture();
      capture.proxy.log("test");

      const entries = capture.getEntries();
      expect(entries[0]!.timestamp).toBe(
        new Date("2024-01-01T12:00:00Z").getTime(),
      );
    });
  });

  describe("getEntries", () => {
    it("returns a copy of entries", () => {
      const capture = createConsoleCapture();
      capture.proxy.log("one");

      const entries1 = capture.getEntries();
      capture.proxy.log("two");
      const entries2 = capture.getEntries();

      expect(entries1).toHaveLength(1);
      expect(entries2).toHaveLength(2);
    });

    it("returns entries in order", () => {
      const capture = createConsoleCapture();
      capture.proxy.log("first");
      capture.proxy.log("second");
      capture.proxy.log("third");

      const entries = capture.getEntries();
      expect(entries[0]!.args).toEqual(["first"]);
      expect(entries[1]!.args).toEqual(["second"]);
      expect(entries[2]!.args).toEqual(["third"]);
    });
  });

  describe("onEntry subscription", () => {
    it("calls callback on new entries", () => {
      const capture = createConsoleCapture();
      const callback = vi.fn();

      capture.onEntry(callback);
      capture.proxy.log("test");

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0]![0].args).toEqual(["test"]);
    });

    it("supports multiple subscribers", () => {
      const capture = createConsoleCapture();
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      capture.onEntry(callback1);
      capture.onEntry(callback2);
      capture.proxy.log("test");

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it("returns unsubscribe function", () => {
      const capture = createConsoleCapture();
      const callback = vi.fn();

      const unsubscribe = capture.onEntry(callback);
      capture.proxy.log("first");
      unsubscribe();
      capture.proxy.log("second");

      expect(callback).toHaveBeenCalledTimes(1);
    });
  });
});

describe("formatConsoleEntry", () => {
  it("formats log without prefix", () => {
    const entry: ConsoleEntry = {
      level: "log",
      args: ["hello", "world"],
      timestamp: Date.now(),
    };

    expect(formatConsoleEntry(entry)).toBe("hello world");
  });

  it("formats warn with prefix", () => {
    const entry: ConsoleEntry = {
      level: "warn",
      args: ["warning"],
      timestamp: Date.now(),
    };

    expect(formatConsoleEntry(entry)).toBe("[WARN] warning");
  });

  it("formats error with prefix", () => {
    const entry: ConsoleEntry = {
      level: "error",
      args: ["error"],
      timestamp: Date.now(),
    };

    expect(formatConsoleEntry(entry)).toBe("[ERROR] error");
  });

  it("formats info with prefix", () => {
    const entry: ConsoleEntry = {
      level: "info",
      args: ["info"],
      timestamp: Date.now(),
    };

    expect(formatConsoleEntry(entry)).toBe("[INFO] info");
  });

  it("formats debug with prefix", () => {
    const entry: ConsoleEntry = {
      level: "debug",
      args: ["debug"],
      timestamp: Date.now(),
    };

    expect(formatConsoleEntry(entry)).toBe("[DEBUG] debug");
  });

  it("formats objects as JSON", () => {
    const entry: ConsoleEntry = {
      level: "log",
      args: [{ a: 1, b: 2 }],
      timestamp: Date.now(),
    };

    const formatted = formatConsoleEntry(entry);
    expect(formatted).toContain('"a": 1');
    expect(formatted).toContain('"b": 2');
  });

  it("formats Error objects with stack", () => {
    const error = new Error("test error");
    const entry: ConsoleEntry = {
      level: "log",
      args: [error],
      timestamp: Date.now(),
    };

    const formatted = formatConsoleEntry(entry);
    expect(formatted).toContain("test error");
    expect(formatted).toContain("Error");
  });

  it("handles circular references", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj["self"] = obj;

    const entry: ConsoleEntry = {
      level: "log",
      args: [obj],
      timestamp: Date.now(),
    };

    const formatted = formatConsoleEntry(entry);
    expect(formatted).toContain("[Circular]");
  });

  it("handles primitives", () => {
    const entry: ConsoleEntry = {
      level: "log",
      args: [42, true, null, undefined, "string"],
      timestamp: Date.now(),
    };

    expect(formatConsoleEntry(entry)).toBe("42 true null undefined string");
  });
});

describe("formatConsoleOutput", () => {
  it("joins entries with newlines", () => {
    const entries: ConsoleEntry[] = [
      { level: "log", args: ["line 1"], timestamp: 1 },
      { level: "log", args: ["line 2"], timestamp: 2 },
      { level: "log", args: ["line 3"], timestamp: 3 },
    ];

    expect(formatConsoleOutput(entries)).toBe("line 1\nline 2\nline 3");
  });

  it("returns empty string for empty array", () => {
    expect(formatConsoleOutput([])).toBe("");
  });

  it("includes level prefixes", () => {
    const entries: ConsoleEntry[] = [
      { level: "log", args: ["normal"], timestamp: 1 },
      { level: "warn", args: ["warning"], timestamp: 2 },
      { level: "error", args: ["error"], timestamp: 3 },
    ];

    const output = formatConsoleOutput(entries);
    expect(output).toBe("normal\n[WARN] warning\n[ERROR] error");
  });
});

describe("bounded console capture", () => {
  it("retains the newest entries and reports how many older entries were dropped", () => {
    const capture = createConsoleCapture({ capacity: 2 });

    capture.proxy.log("first");
    capture.proxy.warn("second");
    capture.proxy.error("third");

    expect(capture.capacity).toBe(2);
    expect(capture.getDroppedCount()).toBe(1);
    expect(capture.getEntries().map(formatConsoleEntry)).toEqual([
      "[WARN] second",
      "[ERROR] third",
    ]);
  });
});
