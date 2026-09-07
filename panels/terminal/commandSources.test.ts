import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadCommandSuggestions } from "./commandSources.js";

vi.mock("@workspace/runtime", () => ({
  fs: {
    readFile: vi.fn(),
  },
}));

describe("command sources", () => {
  beforeEach(async () => {
    const { fs } = await import("@workspace/runtime");
    vi.mocked(fs.readFile).mockReset();
  });

  it("loads custom commands and quotes shell-sensitive args", async () => {
    const { fs } = await import("@workspace/runtime");
    vi.mocked(fs.readFile).mockImplementation(async (path: string) => {
      if (path.endsWith("/.snug/commands.json")) {
        return JSON.stringify({
          commands: [{
            id: "say",
            label: "Say hello",
            command: "node scripts/say.js",
            args: ["hello world", "it's ok"],
          }],
        });
      }
      throw new Error("missing");
    });

    const suggestions = await loadCommandSuggestions({ query: "hello", cwd: "/repo", history: [] });

    expect(suggestions).toContainEqual(expect.objectContaining({
      kind: "project",
      label: "Say hello",
      command: "node scripts/say.js 'hello world' 'it'\\''s ok'",
    }));
  });

  it("preserves custom command split direction as the launcher default target", async () => {
    const { fs } = await import("@workspace/runtime");
    vi.mocked(fs.readFile).mockImplementation(async (path: string) => {
      if (path.endsWith("/.snug/commands.json")) {
        return JSON.stringify({
          commands: [{
            id: "test-down",
            label: "Test down",
            command: "pnpm",
            args: ["test"],
            splitDirection: "down",
          }],
        });
      }
      throw new Error("missing");
    });

    const suggestions = await loadCommandSuggestions({ query: "test", cwd: "/repo", history: [] });

    expect(suggestions).toContainEqual(expect.objectContaining({
      id: "custom:test-down",
      defaultTarget: "splitDown",
    }));
  });

  it("honors custom command openInNewPane as a launcher target hint", async () => {
    const { fs } = await import("@workspace/runtime");
    vi.mocked(fs.readFile).mockImplementation(async (path: string) => {
      if (path.endsWith("/.snug/commands.json")) {
        return JSON.stringify({
          commands: [
            { id: "workspace", label: "Workspace shell", command: "zellij", openInNewPane: false },
            { id: "dev", label: "Dev server", command: "pnpm", args: ["dev"], openInNewPane: true },
          ],
        });
      }
      throw new Error("missing");
    });

    const suggestions = await loadCommandSuggestions({ query: "", cwd: "/repo", history: [] });

    expect(suggestions).toContainEqual(expect.objectContaining({
      id: "custom:workspace",
      defaultTarget: "here",
    }));
    expect(suggestions).toContainEqual(expect.objectContaining({
      id: "custom:dev",
      defaultTarget: "splitRight",
    }));
  });

  it("loads package scripts from the focused cwd", async () => {
    const { fs } = await import("@workspace/runtime");
    vi.mocked(fs.readFile).mockImplementation(async (path: string) => {
      if (path === "/repo/package.json") return JSON.stringify({ scripts: { dev: "vite" } });
      throw new Error("missing");
    });

    const suggestions = await loadCommandSuggestions({ query: "dev", cwd: "/repo", history: [] });

    expect(suggestions).toContainEqual(expect.objectContaining({
      id: "script:dev",
      kind: "project",
      label: "pnpm dev",
      command: "pnpm dev",
    }));
  });

  it("discovers project commands from parent directories", async () => {
    const { fs } = await import("@workspace/runtime");
    vi.mocked(fs.readFile).mockImplementation(async (path: string) => {
      if (path === "/repo/.snug/commands.json") {
        return JSON.stringify({ commands: [{ id: "lint", label: "Lint", command: "pnpm", args: ["lint"] }] });
      }
      if (path === "/repo/package.json") return JSON.stringify({ scripts: { dev: "vite" } });
      throw new Error("missing");
    });

    const suggestions = await loadCommandSuggestions({ query: "", cwd: "/repo/packages/app", history: [] });

    expect(suggestions).toContainEqual(expect.objectContaining({
      id: "custom:lint",
      kind: "project",
      command: "pnpm lint",
    }));
    expect(suggestions).toContainEqual(expect.objectContaining({
      id: "script:dev",
      kind: "project",
      command: "pnpm dev",
    }));
  });

  it("adds raw command fallback only when the user typed a query", async () => {
    const empty = await loadCommandSuggestions({ query: "", cwd: "/repo", history: [] });
    const queried = await loadCommandSuggestions({ query: "npm test -- --watch", cwd: "/repo", history: [] });

    expect(empty.some((item) => item.kind === "raw")).toBe(false);
    expect(queried).toContainEqual(expect.objectContaining({
      kind: "raw",
      command: "npm test -- --watch",
      subtitle: "/repo",
    }));
  });

  it("includes launcher builtins for core pane actions", async () => {
    const suggestions = await loadCommandSuggestions({ query: "toggle", cwd: "/repo", history: [] });

    expect(suggestions).toContainEqual(expect.objectContaining({
      id: "builtin:toggleFind",
      kind: "builtin",
      action: "toggleFind",
    }));
    expect(suggestions).toContainEqual(expect.objectContaining({
      id: "builtin:toggleNotifications",
      kind: "builtin",
      action: "toggleNotifications",
    }));
  });

  it("keeps large project command sets for the virtualized launcher", async () => {
    const { fs } = await import("@workspace/runtime");
    const scripts = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`task:${index}`, "echo ok"]));
    vi.mocked(fs.readFile).mockImplementation(async (path: string) => {
      if (path === "/repo/package.json") return JSON.stringify({ scripts });
      throw new Error("missing");
    });

    const suggestions = await loadCommandSuggestions({ query: "", cwd: "/repo", history: [] });

    expect(suggestions.filter((item) => item.kind === "project")).toHaveLength(80);
  });
});
