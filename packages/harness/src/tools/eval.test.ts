import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { createEvalTool, formatEvalResult, type EvalRunResult } from "./eval.js";

/** Join the text parts of a formatted tool result. */
function textOf(out: ReturnType<typeof formatEvalResult>): string {
  return out.content.map((c) => (c as { type: string; text?: string }).text ?? "").join("\n");
}

function terminal(result: EvalRunResult): {
  runId: string;
  status: "terminal";
  snapshot: { status: "done"; result: EvalRunResult };
} {
  return { runId: "echo", status: "terminal", snapshot: { status: "done", result } };
}

describe("formatEvalResult (shared by the eval tool's execute + the agent's deferred onEvalComplete)", () => {
  it("presents one flat argument object instead of duplicating options across a union", () => {
    const tool = createEvalTool(async () => ({ success: true, console: "" }) as never);
    const schema = tool.parameters as {
      type?: string;
      anyOf?: unknown;
      properties?: Record<string, unknown>;
    };

    expect(schema.type).toBe("object");
    expect(schema.anyOf).toBeUndefined();
    expect(schema.properties).toHaveProperty("code");
    expect(schema.properties).toHaveProperty("path");
    expect(schema.properties).toHaveProperty("authority");
  });

  it("makes the JavaScript parser boundary explicit in the model-visible schema", () => {
    const tool = createEvalTool(async () => ({ success: true, console: "" }) as never);
    const schema = JSON.stringify(tool.parameters);

    expect(schema).toContain("Omit this for TypeScript/TSX");
    expect(schema).toContain("only for plain JavaScript with no type annotations");
  });

  it("directs API discovery through the live self-describing runtime", () => {
    const tool = createEvalTool(async () => ({ success: true, console: "" }) as never);
    expect(tool.description).toContain("await help()");
    expect(tool.description).toContain('await help("workers")');
    expect(tool.description).toContain("before guessing an API or return shape");
    expect(tool.description).toContain("handle.cdp.screenshot()");
    expect(tool.description).toContain("page.consoleEvents()");
    expect(tool.description).toContain("{ entries, errors, dropped, capacity }");
  });

  it("documents the warm notebook contract and makes a cold restart impossible to miss", () => {
    const tool = createEvalTool(async () => ({ success: true, console: "" }) as never);
    expect(tool.description).toContain("retained for 30 minutes");
    expect(tool.description).toContain("objects with methods");
    expect(tool.description).toContain("[kernel] Restarted");

    const text = textOf(
      formatEvalResult({
        success: true,
        console: "",
        scopeKeys: ["panelId"],
        kernel: {
          incarnationId: "kernel-2",
          startedAt: 2,
          idleExpiresAt: 3,
          event: {
            kind: "restarted",
            recovery: {
              status: "complete",
              restored: ["panelId"],
              lost: ["panelHandle"],
            },
          },
        },
      })
    );

    expect(text).toContain("[kernel] Restarted");
    expect(text).toContain("Durable scope restored: panelId");
    expect(text).toContain("Live-only scope lost: panelHandle");
    expect(text).toContain("Reacquire lost handles from stable IDs");
  });

  it("reports restart recovery as unavailable when hydration itself fails", () => {
    const text = textOf(
      formatEvalResult({
        success: false,
        console: "",
        error: "scope backend unavailable",
        kernel: {
          incarnationId: "kernel-2",
          startedAt: 2,
          event: {
            kind: "restarted",
            recovery: { status: "unavailable" },
          },
        },
      })
    );

    expect(text).toContain("[kernel] Restarted");
    expect(text).toContain("recovery could not be assessed");
    expect(text).toContain("[eval] Error: scope backend unavailable");
  });

  it("accepts only a positive integer timeout and forwards the explicit deadline", async () => {
    const calls: unknown[][] = [];
    const tool = createEvalTool(async (_method, args) => {
      calls.push(args);
      return terminal({ success: true, console: "" }) as never;
    });

    expect(Value.Check(tool.parameters, { code: "return 1" })).toBe(true);
    expect(
      Value.Check(tool.parameters, {
        code: "return 1",
        authority: { effects: "read-write" },
      })
    ).toBe(true);
    expect(
      Value.Check(tool.parameters, {
        code: "return 1",
        authority: { effects: "mutable" },
      })
    ).toBe(false);
    expect(Value.Check(tool.parameters, { code: "return 1", timeoutMs: 250 })).toBe(true);
    expect(Value.Check(tool.parameters, { code: "return 1", timeoutMs: 0 })).toBe(false);
    expect(Value.Check(tool.parameters, { code: "return 1", timeoutMs: 1.5 })).toBe(false);
    expect(tool.description).toContain("no implicit wall deadline");
    expect(tool.description).toContain("never add a generic 120000/300000 safety timeout");
    expect(tool.description).toContain("Bound a specific wait");

    await tool.execute("call-timeout", { code: "return 1", timeoutMs: 250 });
    expect(calls[0]?.[0]).toMatchObject({
      source: { kind: "inline", code: "return 1" },
      timeoutMs: 250,
    });
  });

  it("treats a transport-materialized empty path as omitted for inline code", async () => {
    const calls: unknown[][] = [];
    const tool = createEvalTool(async (_method, args) => {
      calls.push(args);
      return terminal({ success: true, console: "" }) as never;
    });
    await tool.execute("call-1", { code: "return 1", path: "" } as never);
    expect(calls[0]?.[0]).toMatchObject({
      source: { kind: "inline", code: "return 1", pathHint: undefined },
    });
  });
  it("uses path as a source-base hint when inline code is present", async () => {
    const calls: unknown[][] = [];
    const tool = createEvalTool(async (_method, args) => {
      calls.push(args);
      return terminal({ success: true, console: "" }) as never;
    });

    await tool.execute("call-1", { code: "return 1", path: "meta" } as never);

    expect(calls[0]?.[0]).toMatchObject({
      source: {
        kind: "inline",
        code: "return 1",
        pathHint: "meta/__inline_eval__.tsx",
      },
    });
  });
  it("forwards reset as an atomic pre-run lifecycle option", async () => {
    const calls: unknown[][] = [];
    const tool = createEvalTool(async (_method, args) => {
      calls.push(args);
      return terminal({ success: true, console: "", scopeKeys: [] }) as never;
    });

    await tool.execute("call-reset", { reset: true, code: "return Object.keys(scope)" } as never);

    expect(calls[0]?.[0]).toMatchObject({
      reset: true,
      source: { kind: "inline", code: "return Object.keys(scope)" },
    });
  });
  it("loads a non-executable text/data path instead of parsing it as TypeScript", async () => {
    const calls: unknown[][] = [];
    const tool = createEvalTool(async (_method, args) => {
      calls.push(args);
      return terminal({ success: true, console: "", returnValue: "# Sandbox" }) as never;
    });

    await tool.execute("call-1", { path: "skills/sandbox/SKILL.md" } as never);

    expect(calls[0]?.[0]).toMatchObject({
      source: {
        kind: "inline",
        code: 'return await fs.readFile("skills/sandbox/SKILL.md", "utf8");',
      },
    });
    expect(calls[0]?.[0]).not.toHaveProperty("source.path");
  });
  it("executes ordinary TypeScript and JavaScript file paths", async () => {
    const calls: unknown[][] = [];
    const tool = createEvalTool(async (_method, args) => {
      calls.push(args);
      return terminal({ success: true, console: "", returnValue: { ok: true } }) as never;
    });

    await tool.execute("call-ts", { path: ".vibestudio/eval/check.ts" } as never);
    await tool.execute("call-js", { path: ".vibestudio/eval/check.js" } as never);

    expect(calls[0]?.[0]).toMatchObject({
      source: { kind: "context-file", path: ".vibestudio/eval/check.ts" },
    });
    expect(calls[1]?.[0]).toMatchObject({
      source: { kind: "context-file", path: ".vibestudio/eval/check.js" },
    });
  });
  it("formats a successful run: console + return value + scope keys, raw result on details", () => {
    const result: EvalRunResult = {
      success: true,
      console: "hello",
      returnValue: { a: 1 },
      scopeKeys: ["x", "y"],
    };
    const out = formatEvalResult(result);
    const text = textOf(out);
    expect(text).toContain("[eval] Console:\nhello");
    expect(text).toContain("[eval] Return value:");
    expect(text).toContain('"a": 1');
    expect(text).toContain("[scope] keys: x, y (2 total)");
    // The untruncated result is preserved on `details` for the harness.
    expect(out.details).toBe(result);
    expect(out.isError).toBe(false);
  });

  it("projects a canonical panel screenshot as native image content without base64 text", () => {
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    const out = formatEvalResult({
      success: true,
      console: "",
      returnValue: { data, mimeType: "image/png", width: 1280, height: 720 },
    });

    expect(textOf(out)).toContain("attached image/png image (1280×720)");
    expect(textOf(out)).not.toContain(data);
    expect(out.content[1]).toEqual({ type: "image", mimeType: "image/png", data });
    expect(out.details).toMatchObject({
      returnValue: {
        protocol: "eval-image-result.v1",
        attached: true,
        mimeType: "image/png",
        width: 1280,
        height: 720,
      },
    });
    expect(JSON.stringify(out.details)).not.toContain(data);
  });

  it("formats a failure: error line, no return value", () => {
    const out = formatEvalResult({ success: false, console: "", error: "boom" });
    const text = textOf(out);
    expect(text).toContain("[eval] Error: boom");
    expect(text).not.toContain("[eval] Return value");
    expect(text).toContain("[scope] (empty)");
    expect(out.isError).toBe(true);
  });

  it("references structured failure data once and preserves it on tool details", () => {
    const result: EvalRunResult = {
      success: false,
      console: "",
      error: "publication failed",
      failureCode: "scaffold_publication_failed",
      errorData: {
        code: "scaffold_publication_failed",
        committedEventId: "event:committed",
        published: false,
      },
    };
    const out = formatEvalResult(result);
    const text = textOf(out);

    expect(text).toContain("[eval] Structured failure: scaffold_publication_failed");
    expect(text).not.toContain('"committedEventId": "event:committed"');
    expect(out.details).toBe(result);
  });

  it("uses 'unknown error' when a failure has no error string", () => {
    const text = textOf(formatEvalResult({ success: false, console: "" }));
    expect(text).toContain("[eval] Error: unknown error");
  });

  it("does NOT print a return value on failure even if one is present", () => {
    const text = textOf(
      formatEvalResult({ success: false, console: "", error: "x", returnValue: 42 })
    );
    expect(text).not.toContain("[eval] Return value");
  });

  it("windows oversized console with its stable recovery slot", () => {
    const big = "a".repeat(150_000);
    const text = textOf(formatEvalResult({ success: true, console: big }));
    expect(text.length).toBeLessThan(big.length); // truncated
    expect(text).toContain("truncated");
    expect(text).toContain("scope.$lastLargeConsole");
  });

  it("windows an oversized return value with its stable recovery slot", () => {
    const big = "b".repeat(150_000);
    const text = textOf(formatEvalResult({ success: true, console: "", returnValue: big }));
    expect(text).toContain("scope.$lastLargeReturn");
    expect(text).toContain("truncated");
  });

  it("does not truncate normal-sized output", () => {
    const text = textOf(formatEvalResult({ success: true, console: "small", returnValue: "tiny" }));
    expect(text).not.toContain("truncated");
    expect(text).toContain("small");
    expect(text).toContain("tiny");
  });
});
