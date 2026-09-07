/**
 * Integration tests that verify the eval package works in scenarios
 * similar to how workers would use it (without __vibestudioRequire__).
 */
import { describe, it, expect } from "vitest";
import { transformCode, execute, validateRequires, createConsoleCapture, formatConsoleOutput } from "./index";

describe("Worker-like usage (custom require)", () => {
  // Simulate a worker's module system
  const workerModules: Record<string, unknown> = {
    "lodash": { capitalize: (s: string) => s.charAt(0).toUpperCase() + s.slice(1) },
    "utils": { double: (n: number) => n * 2 },
  };

  const workerRequire = (id: string): unknown => {
    if (id in workerModules) {
      return workerModules[id];
    }
    throw new Error(`Module not found: ${id}`);
  };

  it("transforms and executes TypeScript code with custom require", async () => {
    const source = `
      import { capitalize } from "lodash";
      export default capitalize("hello");
    `;

    const transformed = await transformCode(source, { syntax: "typescript" });
    const result = execute(transformed.code, { require: workerRequire });

    expect(result.exports["default"]).toBe("Hello");
  });

  it("validates requires before execution", async () => {
    const source = `
      import { capitalize } from "lodash";
      import { missing } from "nonexistent";
      console.log(capitalize, missing); // Use them so Sucrase doesn't tree-shake
    `;

    const transformed = await transformCode(source, { syntax: "typescript" });
    const validation = validateRequires(transformed.requires, workerRequire);

    expect(validation.valid).toBe(false);
    expect(validation.missingModule).toBe("nonexistent");
  });

  it("captures console output during execution", async () => {
    const source = `
      console.log("Starting...");
      console.warn("Warning!");
      console.log("Done");
    `;

    const transformed = await transformCode(source, { syntax: "typescript" });
    const capture = createConsoleCapture();

    execute(transformed.code, {
      require: workerRequire,
      console: capture.proxy,
    });

    const output = formatConsoleOutput(capture.getEntries());
    expect(output).toContain("Starting...");
    expect(output).toContain("[WARN] Warning!");
    expect(output).toContain("Done");
  });

  it("works with scope bindings", async () => {
    const source = `
      import { double } from "utils";
      export default double(inputValue);
    `;

    const transformed = await transformCode(source, { syntax: "typescript" });
    const result = execute(transformed.code, {
      require: workerRequire,
      bindings: { inputValue: 21 },
    });

    expect(result.exports["default"]).toBe(42);
  });

  it("handles async code with returned promises", async () => {
    const source = `
      async function fetchData() {
        return { data: "test" };
      }
      export default fetchData();
    `;

    const transformed = await transformCode(source, { syntax: "typescript" });
    const result = execute(transformed.code, { require: workerRequire });

    // Workers would need to await the returned promise manually
    const data = await (result.exports["default"] as Promise<{ data: string }>);
    expect(data).toEqual({ data: "test" });
  });
});

describe("Full transform-validate-execute pipeline", () => {
  const mockModules: Record<string, unknown> = {
    "math-utils": {
      add: (a: number, b: number) => a + b,
      multiply: (a: number, b: number) => a * b,
    },
  };

  const mockRequire = (id: string): unknown => {
    if (id in mockModules) return mockModules[id];
    throw new Error(`Module not found: ${id}`);
  };

  it("demonstrates safe eval workflow", async () => {
    const userCode = `
      import { add, multiply } from "math-utils";

      const result = add(2, 3);
      console.log("Sum:", result);

      export default multiply(result, 4);
    `;

    // Step 1: Transform
    const transformed = await transformCode(userCode, { syntax: "typescript" });
    expect(transformed.requires).toContain("math-utils");

    // Step 2: Validate (before execution)
    const validation = validateRequires(transformed.requires, mockRequire);
    expect(validation.valid).toBe(true);

    // Step 3: Execute with console capture
    const capture = createConsoleCapture();
    const result = execute(transformed.code, {
      require: mockRequire,
      console: capture.proxy,
    });

    // Step 4: Check results
    expect(result.exports["default"]).toBe(20); // (2+3) * 4
    expect(formatConsoleOutput(capture.getEntries())).toContain("Sum: 5");
  });
});
