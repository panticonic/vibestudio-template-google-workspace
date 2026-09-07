import vm from "node:vm";
import { describe, it, expect, vi } from "vitest";
import { tameRealmCodegen } from "@vibestudio/shared/evalConfinement";
import {
  execute,
  executeDefault,
  validateRequires,
  getDefaultRequire,
  type CompileFunction,
} from "./execute";

describe("execute", () => {
  // Mock require function for tests
  const mockRequire = (id: string) => {
    if (id === "test-module") {
      return { value: 42 };
    }
    throw new Error(`Module not found: ${id}`);
  };

  describe("basic execution", () => {
    it("executes simple code", () => {
      const result = execute(`exports.value = 42;`, { require: mockRequire });

      expect(result.exports["value"]).toBe(42);
    });

    it("returns the return value of the code", () => {
      const result = execute(`return 123;`, { require: mockRequire });

      expect(result.returnValue).toBe(123);
    });

    it("supports module.exports assignment", () => {
      const result = execute(`module.exports = { foo: "bar" };`, {
        require: mockRequire,
      });

      expect(result.exports).toEqual({ foo: "bar" });
    });

    it("supports exports.default", () => {
      const result = execute(`exports.default = function() { return 1; };`, {
        require: mockRequire,
      });

      expect(typeof result.exports["default"]).toBe("function");
    });
  });

  describe("require function", () => {
    it("uses provided require function", () => {
      const result = execute(
        `const mod = require("test-module"); exports.val = mod.value;`,
        { require: mockRequire }
      );

      expect(result.exports["val"]).toBe(42);
    });

    it("throws when require is not available", () => {
      // Temporarily remove global require
      const original = (globalThis as Record<string, unknown>)[
        "__vibestudioRequire__"
      ];
      delete (globalThis as Record<string, unknown>)["__vibestudioRequire__"];

      try {
        expect(() => execute(`exports.x = 1;`)).toThrow(
          "__vibestudioRequire__ not available"
        );
      } finally {
        if (original) {
          (globalThis as Record<string, unknown>)["__vibestudioRequire__"] =
            original;
        }
      }
    });
  });

  describe("console capture", () => {
    it("uses provided console proxy", () => {
      const logs: string[] = [];
      const mockConsole = {
        log: (...args: unknown[]) => logs.push(args.join(" ")),
      } as unknown as Console;

      execute(`console.log("hello", "world");`, {
        require: mockRequire,
        console: mockConsole,
      });

      expect(logs).toEqual(["hello world"]);
    });

    it("uses default console when not provided", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        execute(`console.log("test");`, { require: mockRequire });
        expect(spy).toHaveBeenCalledWith("test");
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("scope bindings", () => {
    it("injects custom bindings", () => {
      const result = execute(`exports.doubled = myValue * 2;`, {
        require: mockRequire,
        bindings: { myValue: 21 },
      });

      expect(result.exports["doubled"]).toBe(42);
    });

    it("supports multiple bindings", () => {
      const result = execute(`exports.sum = a + b + c;`, {
        require: mockRequire,
        bindings: { a: 1, b: 2, c: 3 },
      });

      expect(result.exports["sum"]).toBe(6);
    });

    it("bindings can be functions", () => {
      const result = execute(`exports.result = myFn(5);`, {
        require: mockRequire,
        bindings: { myFn: (x: number) => x * 2 },
      });

      expect(result.exports["result"]).toBe(10);
    });
  });

  describe("strict mode", () => {
    it("runs in strict mode", () => {
      expect(() =>
        execute(`undeclaredVariable = 42;`, { require: mockRequire })
      ).toThrow();
    });
  });

  describe("private guest global", () => {
    // Confinement is a property of the realm guest code compiles into, so the
    // guest gets its own realm with codegen tamed — the arrangement an evaluator
    // bootstrap creates, and what workerd's isolate gives for free.
    const guestContext = vm.createContext({});
    tameRealmCodegen(vm.runInContext("globalThis", guestContext) as Record<string, unknown>);
    const compileFunction: CompileFunction = (argNames, body) =>
      vm.runInContext(`(function (${argNames.join(", ")}) {\n${body}\n})`, guestContext) as (
        ...args: unknown[]
      ) => unknown;

    const confined = (code: string, bindings?: Record<string, unknown>) =>
      execute(code, {
        require: mockRequire,
        bindings,
        compileFunction,
        confinement: "private-global",
      });

    it("refuses to run confined in a realm that can still compile code", () => {
      expect(() =>
        execute(`return 1;`, { require: mockRequire, confinement: "private-global" })
      ).toThrow(/compile code/);
    });

    it("denies the constructor-chain route out of the private global", () => {
      const result = confined(`
        const attempts = [];
        for (const reach of [
          () => ({}).constructor.constructor("return globalThis")(),
          () => [].constructor.constructor("return globalThis")(),
          () => (function () {}).constructor("return globalThis")(),
          () => (async function () {}).constructor("return globalThis")(),
          () => Object.getPrototypeOf(function () {}).constructor("return globalThis")(),
        ]) {
          try {
            attempts.push(typeof reach());
          } catch (err) {
            attempts.push(/does not permit dynamic code generation/.test(String(err))
              ? "denied"
              : "other:" + err);
          }
        }
        return attempts;
      `);

      expect(result.returnValue).toEqual(["denied", "denied", "denied", "denied", "denied"]);
    });

    it("does not expose evaluator globals or Vibestudio kernel hooks", () => {
      (globalThis as Record<string, unknown>)["__vibestudioKernelSecret__"] = "host-only";
      try {
        const result = confined(`return {
          processType: typeof process,
          fetchType: typeof fetch,
          webSocketType: typeof WebSocket,
          kernelHook: globalThis.__vibestudioKernelSecret__,
          prototype: Object.getPrototypeOf(globalThis),
        };`);

        expect(result.returnValue).toEqual({
          processType: "undefined",
          fetchType: "undefined",
          webSocketType: "undefined",
          kernelHook: undefined,
          prototype: null,
        });
      } finally {
        delete (globalThis as Record<string, unknown>)["__vibestudioKernelSecret__"];
      }
    });

    it("keeps strict-mode this semantics and explicit endowments", () => {
      const result = confined(
        `return {
          receiver: (function () { return this; })(),
          answer: secret + 1,
          globalAnswer: global.secret + 1,
          globalThisAnswer: globalThis.secret + 1,
        };`,
        { secret: 41 }
      );

      expect(result.returnValue).toEqual({
        receiver: undefined,
        answer: 42,
        globalAnswer: 42,
        globalThisAnswer: 42,
      });
    });

    it("retains the private lexical boundary in callbacks that outlive execution", () => {
      // Endowments come from the guest realm: an object carried in from a
      // codegen-capable realm would reopen the escape through its own
      // constructor chain.
      const holder = vm.runInContext("({})", guestContext) as { callback?: () => unknown };
      confined(
        `holder.callback = () => ({ processType: typeof process, secret, global: globalThis });`,
        { holder, secret: "endowed" }
      );

      const value = holder.callback?.() as Record<string, unknown>;
      expect(value["processType"]).toBe("undefined");
      expect(value["secret"]).toBe("endowed");
      expect(Object.getPrototypeOf(value["global"])).toBeNull();
    });
  });

  describe("error handling", () => {
    it("propagates runtime errors", () => {
      expect(() =>
        execute(`throw new Error("test error");`, { require: mockRequire })
      ).toThrow("test error");
    });

    it("propagates syntax errors in code", () => {
      expect(() =>
        execute(`const x = {`, { require: mockRequire })
      ).toThrow();
    });
  });
});

describe("executeDefault", () => {
  const mockRequire = () => ({});

  it("returns the default export", () => {
    const result = executeDefault<number>(
      `exports.default = 42;`,
      { require: mockRequire }
    );

    expect(result).toBe(42);
  });

  it("returns module.exports when it's a function", () => {
    const fn = executeDefault<() => number>(
      `module.exports = function() { return 123; };`,
      { require: mockRequire }
    );

    expect(fn()).toBe(123);
  });

  it("throws when no default export found", () => {
    expect(() =>
      executeDefault(`exports.named = 42;`, { require: mockRequire })
    ).toThrow("No default export found");
  });

  it("works with complex default exports", () => {
    const result = executeDefault<{ name: string; value: number }>(
      `exports.default = { name: "test", value: 42 };`,
      { require: mockRequire }
    );

    expect(result).toEqual({ name: "test", value: 42 });
  });
});

describe("validateRequires", () => {
  it("returns valid when all modules are available", () => {
    const mockRequire = (id: string) => {
      if (id === "react" || id === "lodash") return {};
      throw new Error(`Not found: ${id}`);
    };

    const result = validateRequires(["react", "lodash"], mockRequire);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.missingModule).toBeUndefined();
  });

  it("returns invalid when a module is missing", () => {
    const mockRequire = (id: string) => {
      if (id === "react") return {};
      throw new Error(`Not found: ${id}`);
    };

    const result = validateRequires(["react", "missing-module"], mockRequire);

    expect(result.valid).toBe(false);
    expect(result.missingModule).toBe("missing-module");
    expect(result.error).toContain("missing-module");
  });

  it("explains that Node built-ins are unavailable instead of suggesting npm imports", () => {
    const mockRequire = () => {
      throw new Error("Not found");
    };

    const result = validateRequires(["node:child_process"], mockRequire);

    expect(result.valid).toBe(false);
    expect(result.missingModule).toBe("node:child_process");
    expect(result.error).toContain("Node built-in module");
    expect(result.error).toContain("@workspace/runtime");
    expect(result.error).not.toContain("npm:latest");
  });

  it("returns invalid when require function is not available", () => {
    // Don't provide a require function and ensure global isn't set
    const original = (globalThis as Record<string, unknown>)["__vibestudioRequire__"];
    delete (globalThis as Record<string, unknown>)["__vibestudioRequire__"];

    try {
      const result = validateRequires(["react"]);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("__vibestudioRequire__");
    } finally {
      if (original) {
        (globalThis as Record<string, unknown>)["__vibestudioRequire__"] = original;
      }
    }
  });

  it("returns valid for empty requires array", () => {
    const mockRequire = () => ({});
    const result = validateRequires([], mockRequire);

    expect(result.valid).toBe(true);
  });

  it("stops at first missing module", () => {
    const attempted: string[] = [];
    const mockRequire = (id: string) => {
      attempted.push(id);
      if (id === "a") return {};
      throw new Error(`Not found: ${id}`);
    };

    validateRequires(["a", "b", "c"], mockRequire);

    // Should stop after "b" fails, never try "c"
    expect(attempted).toEqual(["a", "b"]);
  });
});

describe("getDefaultRequire", () => {
  it("returns undefined when global require is not set", () => {
    const original = (globalThis as Record<string, unknown>)["__vibestudioRequire__"];
    delete (globalThis as Record<string, unknown>)["__vibestudioRequire__"];

    try {
      expect(getDefaultRequire()).toBeUndefined();
    } finally {
      if (original) {
        (globalThis as Record<string, unknown>)["__vibestudioRequire__"] = original;
      }
    }
  });

  it("returns the global require function when set", () => {
    const mockFn = () => ({});
    const original = (globalThis as Record<string, unknown>)["__vibestudioRequire__"];
    (globalThis as Record<string, unknown>)["__vibestudioRequire__"] = mockFn;

    try {
      expect(getDefaultRequire()).toBe(mockFn);
    } finally {
      if (original) {
        (globalThis as Record<string, unknown>)["__vibestudioRequire__"] = original;
      } else {
        delete (globalThis as Record<string, unknown>)["__vibestudioRequire__"];
      }
    }
  });
});
