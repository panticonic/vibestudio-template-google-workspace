import { describe, expect, it, vi } from "vitest";
import type { SandboxOptions, SandboxResult, ScopeManager } from "@workspace/eval";
import type { MethodExecutionContext } from "@workspace/pubsub";
import { buildClientEvalMethod } from "./clientEval";

function scopeManager(initial: Record<string, unknown> = {}) {
  const current = { ...initial };
  return {
    current,
    api: {
      currentId: "scope-1",
      push: vi.fn(async () => "scope-2"),
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
      save: vi.fn(async () => undefined),
    },
    enterEval: vi.fn(),
    exitEval: vi.fn(async () => undefined),
  } as unknown as ScopeManager;
}

function context(signal = new AbortController().signal): MethodExecutionContext {
  return {
    callId: "call-1",
    invocationId: "invocation-1",
    transportCallId: "transport-1",
    callerId: "agent-1",
    signal,
    stream: vi.fn(async () => undefined),
    streamWithAttachments: vi.fn(async () => undefined),
    resultWithAttachments: (content, attachments) => ({ content, attachments }),
  };
}

function method(
  overrides: {
    executeSandbox?: (code: string, options?: SandboxOptions) => Promise<SandboxResult>;
    loadSourceFile?: (path: string) => Promise<string>;
    manager?: ScopeManager;
  } = {}
) {
  const manager = overrides.manager ?? scopeManager();
  const executeSandbox =
    overrides.executeSandbox ??
    vi.fn(async () => ({
      success: true,
      consoleOutput: "",
      returnValue: 42,
    }));
  return {
    manager,
    executeSandbox,
    definition: buildClientEvalMethod({
      importLoader: vi.fn(async () => ({ bundle: "", format: "cjs" as const })),
      executeSandbox,
      loadSourceFile:
        overrides.loadSourceFile ??
        vi.fn(async (path: string) => `return ${JSON.stringify(path)};`),
      getChat: () => ({ channelId: "channel-1" }) as never,
      scopeManager: manager,
    }),
  };
}

describe("client_eval", () => {
  it("requires exactly one source and accepts panel-targeted package imports", () => {
    const { definition } = method();

    expect(definition.parameters.safeParse({}).success).toBe(false);
    expect(definition.parameters.safeParse({ code: "return 1", path: "run.ts" }).success).toBe(
      false
    );
    expect(
      definition.parameters.safeParse({
        code: "return 1",
        imports: { "@workspace-skills/onboarding": "workspace:*" },
      }).success
    ).toBe(true);
  });

  it("executes with the panel chat, durable scope, cancellation, and deadline", async () => {
    const manager = scopeManager({ existing: true });
    let seen: SandboxOptions | undefined;
    const executeSandbox = vi.fn(async (_code: string, options?: SandboxOptions) => {
      seen = options;
      (options?.bindings?.["scope"] as Record<string, unknown>)["answer"] = 42;
      return { success: true, consoleOutput: "hello", returnValue: { ok: true } };
    });
    const { definition } = method({ executeSandbox, manager });

    const result = await definition.execute(
      { code: "return 42", syntax: "typescript", timeoutMs: 1000 },
      context()
    );

    expect(seen?.bindings).toMatchObject({
      chat: { channelId: "channel-1" },
      scope: { existing: true, answer: 42 },
    });
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(seen?.deadline?.timeoutMs).toBe(1000);
    expect(manager.enterEval).toHaveBeenCalledOnce();
    expect(manager.exitEval).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).toContain("[client_eval] Return value");
    expect(JSON.stringify(result)).toContain("[scope] keys: existing, answer");
  });

  it("loads file-backed code from the inviting panel context", async () => {
    const loadSourceFile = vi.fn(async () => "return 'from-file';");
    const executeSandbox = vi.fn(async () => ({
      success: true,
      consoleOutput: "",
      returnValue: "from-file",
    }));
    const { definition } = method({ executeSandbox, loadSourceFile });

    await definition.execute({ path: "skills/onboarding/check.ts", syntax: "tsx" }, context());

    expect(loadSourceFile).toHaveBeenCalledWith("skills/onboarding/check.ts");
    expect(executeSandbox).toHaveBeenCalledWith(
      "return 'from-file';",
      expect.objectContaining({
        sourcePath: "skills/onboarding/check.ts",
        loadSourceFile,
      })
    );
  });

  it("returns authored failures as correctable tool output", async () => {
    const { definition } = method({
      executeSandbox: vi.fn(async () => ({
        success: false,
        consoleOutput: "",
        error: "callMain is not defined",
        failureKind: "user-code" as const,
      })),
    });

    const result = await definition.execute(
      { code: "return callMain('x')", syntax: "tsx" },
      context()
    );

    expect(result).toMatchObject({ details: { success: false } });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining('import { callMain } from "@workspace/runtime"'),
        }),
      ])
    );
  });
});
