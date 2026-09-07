import { describe, it, expect, vi } from "vitest";
import {
  loadVibestudioResources,
  formatSkillIndex,
  type RpcCaller,
  type SkillEntry,
} from "./resource-loader.js";

/**
 * Builds a mock `RpcCaller` whose `call()` returns canned responses keyed
 * by `<targetId>:<method>`. Unknown methods reject so missing routes
 * surface immediately as test failures.
 */
function createMockRpc(responses: Record<string, unknown>): RpcCaller {
  const call = vi.fn(async (targetId: string, method: string) => {
    const key = `${targetId}:${method}`;
    if (!(key in responses)) {
      throw new Error(`Unexpected RPC call: ${key}`);
    }
    return responses[key];
  });
  return {
    call: call as RpcCaller["call"],
    stream: vi.fn(async () => new Response()) as unknown as RpcCaller["stream"],
  };
}

const SAMPLE_SKILLS: SkillEntry[] = [
  {
    name: "eval",
    description: "Evaluate expressions in a sandboxed JS REPL.",
    dirPath: "skills/eval",
    skillPath: "skills/eval/SKILL.md",
  },
  {
    name: "search",
    description: "Search the codebase using ripgrep.",
    dirPath: "packages/search",
    skillPath: "packages/search/SKILL.md",
  },
];

describe("loadVibestudioResources", () => {
  it("fetches system prompt + skills via workspace.* RPC", async () => {
    const rpc = createMockRpc({
      "main:workspace.getAgentsMd": "System prompt content",
      "main:workspace.listSkills": SAMPLE_SKILLS,
    });
    const callSpy = rpc.call as ReturnType<typeof vi.fn>;

    const resources = await loadVibestudioResources({ rpc });

    expect(resources.systemPrompt).toBe("System prompt content");
    expect(resources.skills).toEqual(SAMPLE_SKILLS);
    expect(callSpy).toHaveBeenCalledTimes(2);
    expect(callSpy).toHaveBeenCalledWith("main", "workspace.getAgentsMd", []);
    expect(callSpy).toHaveBeenCalledWith("main", "workspace.listSkills", []);
  });

  it("passes the abort signal to both resource RPC calls", async () => {
    const rpc = createMockRpc({
      "main:workspace.getAgentsMd": "System prompt content",
      "main:workspace.listSkills": SAMPLE_SKILLS,
    });
    const callSpy = rpc.call as ReturnType<typeof vi.fn>;
    const controller = new AbortController();

    await loadVibestudioResources({ rpc, signal: controller.signal });

    expect(callSpy).toHaveBeenCalledWith(
      "main",
      "workspace.getAgentsMd",
      [],
      { signal: controller.signal },
    );
    expect(callSpy).toHaveBeenCalledWith(
      "main",
      "workspace.listSkills",
      [],
      { signal: controller.signal },
    );
  });

  it("rejects on abort even when a resource RPC does not settle", async () => {
    const controller = new AbortController();
    const call = vi.fn((_targetId: string, method: string) => {
      if (method === "workspace.getAgentsMd") return new Promise<string>(() => undefined);
      if (method === "workspace.listSkills") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected method: ${method}`));
    });
    const rpc: RpcCaller = {
      call: call as RpcCaller["call"],
      stream: vi.fn(async () => new Response()) as unknown as RpcCaller["stream"],
    };

    const loadPromise = loadVibestudioResources({ rpc, signal: controller.signal });
    await Promise.resolve();
    controller.abort(new Error("user interrupted"));

    await expect(loadPromise).rejects.toThrow("user interrupted");
  });

  it("formats skillIndex as a markdown section listing each skill", async () => {
    const rpc = createMockRpc({
      "main:workspace.getAgentsMd": "System prompt content",
      "main:workspace.listSkills": SAMPLE_SKILLS,
    });

    const { skillIndex } = await loadVibestudioResources({ rpc });

    expect(skillIndex).toContain("## Available skills");
    expect(skillIndex).toContain(
      "- **eval** (skills/eval) \u2014 Evaluate expressions in a sandboxed JS REPL.",
    );
    expect(skillIndex).toContain(
      "- **search** (packages/search) \u2014 Search the codebase using ripgrep.",
    );
    expect(skillIndex).toContain('read("<dirPath>/SKILL.md")');
    expect(skillIndex).toContain("per-context folder");
  });

  it("returns an empty skillIndex when there are no skills", async () => {
    const rpc = createMockRpc({
      "main:workspace.getAgentsMd": "System prompt content",
      "main:workspace.listSkills": [],
    });

    const resources = await loadVibestudioResources({ rpc });

    expect(resources.skills).toEqual([]);
    expect(resources.skillIndex).toBe("");
    expect(resources.systemPrompt).toBe("System prompt content");
  });

  it("fails clearly when workspace.getAgentsMd returns a non-string", async () => {
    const rpc = createMockRpc({
      "main:workspace.getAgentsMd": { text: "wrong" },
      "main:workspace.listSkills": [],
    });

    await expect(loadVibestudioResources({ rpc })).rejects.toMatchObject({
      name: "AgentWorkerError",
      code: "resource_loading",
      message: expect.stringContaining("workspace.getAgentsMd returned invalid resource shape"),
    });
  });

  it("fails clearly when workspace.listSkills returns a malformed descriptor", async () => {
    const rpc = createMockRpc({
      "main:workspace.getAgentsMd": "System prompt content",
      "main:workspace.listSkills": [{ name: "broken", description: 7, dirPath: "/broken" }],
    });

    await expect(loadVibestudioResources({ rpc })).rejects.toMatchObject({
      name: "AgentWorkerError",
      code: "resource_loading",
      message: expect.stringContaining("workspace.listSkills[0] returned invalid resource shape"),
    });
  });

  it("issues both RPC calls in parallel (does not serialize)", async () => {
    let agentsMdResolve: ((value: string) => void) | undefined;
    let skillsResolve: ((value: SkillEntry[]) => void) | undefined;
    const agentsMdPromise = new Promise<string>((r) => {
      agentsMdResolve = r;
    });
    const skillsPromise = new Promise<SkillEntry[]>((r) => {
      skillsResolve = r;
    });

    const call = vi.fn(async (_targetId: string, method: string) => {
      if (method === "workspace.getAgentsMd") return agentsMdPromise;
      if (method === "workspace.listSkills") return skillsPromise;
      throw new Error(`unexpected method: ${method}`);
    });
    const rpc: RpcCaller = {
      call: call as RpcCaller["call"],
      stream: vi.fn(async () => new Response()) as unknown as RpcCaller["stream"],
    };

    const loadPromise = loadVibestudioResources({ rpc });
    // Both calls should be in flight before either resolves.
    expect(call).toHaveBeenCalledTimes(2);

    skillsResolve?.([]);
    agentsMdResolve?.("Prompt");
    const result = await loadPromise;
    expect(result.systemPrompt).toBe("Prompt");
    expect(result.skills).toEqual([]);
  });
});

describe("formatSkillIndex", () => {
  it("returns empty string for empty input", () => {
    expect(formatSkillIndex([])).toBe("");
  });

  it("starts with a leading blank line and the heading", () => {
    const out = formatSkillIndex([
      {
        name: "x",
        description: "X skill",
        dirPath: "packages/x",
        skillPath: "packages/x/SKILL.md",
      },
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("");
    expect(lines[1]).toBe("## Available skills");
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("- **x** (packages/x) \u2014 X skill");
    expect(out).toContain("read every skill whose description clearly matches the task");
    expect(out).toContain("does not replace a more specific matching skill");
  });
});
