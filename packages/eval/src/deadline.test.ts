import { describe, expect, it } from "vitest";
import { execute } from "./execute.js";
import { instrumentDeadlineCheckpoints } from "./deadline.js";

function runInstrumented(code: string, checkpoint: () => void): unknown {
  const transformed = instrumentDeadlineCheckpoints(code);
  return execute(transformed.code, {
    bindings: { [transformed.checkpointName]: checkpoint },
    require: () => ({}),
  }).returnValue;
}

async function runInstrumentedAsync(code: string, checkpoint: () => void): Promise<unknown> {
  return await runInstrumented(code, checkpoint);
}

describe("instrumentDeadlineCheckpoints", () => {
  it("checks every loop iteration, including a loop without a block", () => {
    let checks = 0;
    expect(() =>
      runInstrumented("let n = 0; while (true) n += 1;", () => {
        checks += 1;
        if (checks === 4) throw new Error("deadline");
      })
    ).toThrow("deadline");
    expect(checks).toBe(4);
  });

  it("checks recursive function entry", () => {
    let checks = 0;
    expect(() =>
      runInstrumented("function recurse() { return recurse(); } return recurse();", () => {
        checks += 1;
        if (checks === 5) throw new Error("deadline");
      })
    ).toThrow("deadline");
    expect(checks).toBe(5);
  });

  it("checks do/while, for, for/in, and for/of bodies", () => {
    let checks = 0;
    const result = runInstrumented(
      `let sum = 0;
       do sum += 1; while (sum < 2);
       for (let i = 0; i < 2; i++) sum += i;
       for (const key in { a: 1 }) sum += key.length;
       for (const value of [2]) sum += value;
       return sum;`,
      () => {
        checks += 1;
      }
    );
    expect(result).toBe(6);
    expect(checks).toBe(6);
  });

  it("preserves expression-bodied arrow values and nested arrows", () => {
    const value = runInstrumented(
      "const outer = (x) => (y) => x + y; return outer(2)(3);",
      () => {}
    );
    expect(value).toBe(5);
  });

  it("preserves concise async arrows and object-literal returns", async () => {
    const value = await runInstrumentedAsync(
      "const object = (x) => ({ value: x }); const later = async (x) => object(x); return later(7);",
      () => {}
    );
    expect(value).toEqual({ value: 7 });
  });

  it("instruments generators, object methods, and class methods without changing values", () => {
    let checks = 0;
    const value = runInstrumented(
      `function* values() { yield 2; }
       const object = { method() { return 3; } };
       class Box { method() { return 4; } }
       return [...values()][0] + object.method() + new Box().method();`,
      () => {
        checks += 1;
      }
    );
    expect(value).toBe(9);
    expect(checks).toBe(3);
  });

  it("preserves labels and derived constructors", () => {
    const value = runInstrumented(
      `let count = 0;
       outer: for (let i = 0; i < 3; i++) {
         for (let j = 0; j < 3; j++) {
           count += 1;
           if (j === 1) continue outer;
         }
       }
       class Base { constructor(value) { this.value = value; } }
       class Child extends Base { constructor() { super(count); } }
       return new Child().value;`,
      () => {}
    );
    expect(value).toBe(6);
  });

  it("keeps function directive prologues before the checkpoint", () => {
    const transformed = instrumentDeadlineCheckpoints(
      `function value() { "use strict"; "custom directive"; return 1; } return value();`
    );
    expect(transformed.code).toContain(
      `"use strict"; "custom directive";(typeof ${transformed.checkpointName}==="function"&&${transformed.checkpointName}()); return 1;`
    );
  });

  it("keeps serialized callbacks executable outside the sandbox realm", () => {
    const callback = runInstrumented("return (value) => value + 1;", () => {}) as (
      value: number
    ) => number;
    const executeSerialized = new Function(`return (${callback.toString()})(4);`);

    expect(executeSerialized()).toBe(5);
  });

  it("orders nested concise-arrow insertions that share a closing position", () => {
    const transformed = instrumentDeadlineCheckpoints(
      "const f = x => y => z => x + y + z; return f(1)(2)(3);"
    );
    expect(
      execute(transformed.code, {
        bindings: { [transformed.checkpointName]: () => {} },
        require: () => ({}),
      }).returnValue
    ).toBe(6);
  });

  it("chooses a binding name that cannot collide with authored code", () => {
    const source =
      "const __vibestudioDeadlineCheckpoint__ = 'authored'; return __vibestudioDeadlineCheckpoint__;";
    const transformed = instrumentDeadlineCheckpoints(source);
    expect(transformed.checkpointName).not.toBe("__vibestudioDeadlineCheckpoint__");
    expect(
      execute(transformed.code, {
        bindings: { [transformed.checkpointName]: () => {} },
        require: () => ({}),
      }).returnValue
    ).toBe("authored");
  });
});
