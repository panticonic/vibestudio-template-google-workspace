import { describe, expect, it } from "vitest";
import { detectAgent } from "./detectAgent.js";

describe("detectAgent", () => {
  it.each([
    [["claude"], { kind: "claude-code", title: "Claude Code" }],
    [["/opt/claude-code"], { kind: "claude-code", title: "Claude Code" }],
    [["codex"], { kind: "codex", title: "Codex" }],
    [
      ["vibestudio", "claude", "--channel", "chan-1"],
      { kind: "claude-code", title: "Claude Code" },
    ],
    [["pnpm", "test"], { kind: "test-runner", title: "Tests" }],
    [["next", "dev"], { kind: "dev-server", title: "Dev server" }],
  ])("detects structured argv %j", (argv, expected) => {
    expect(detectAgent(argv)).toEqual(expected);
  });

  it.each([
    ["node", "-e", "process.exit(0)", "claude"],
    ["bash", "-lc", "echo claude"],
    ["pnpm", "exec", "claude"],
    ["next", "build"],
    ["tsx", "script.ts", "watch"],
  ])("does not infer identity from arguments: %j", (...argv) => {
    expect(detectAgent(argv)).toBeUndefined();
  });
});
