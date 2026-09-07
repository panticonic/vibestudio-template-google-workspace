import { describe, expect, it } from "vitest";
import { composeSystemPrompt, VIBESTUDIO_BASE_SYSTEM_PROMPT } from "./system-prompt.js";

describe("composeSystemPrompt", () => {
  it("keeps authored source distinct from live platform state", () => {
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain(
      "Filesystem tools show what is authored in the workspace"
    );
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("documented live runtime/service APIs");
  });

  it("routes ordinary managed file work through the focused authoring boundary", () => {
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain(
      "Use the focused file tools for ordinary discovery, reading, and authoring"
    );
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain(
      "`apply_patch` when multiple files must change atomically"
    );
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain(
      "Do not emulate managed file authoring through generic `eval`"
    );
  });

  it("defines the evidence boundary for a completed executable-source repair", () => {
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain(
      "A managed executable-source repair is complete only after"
    );
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("exact affected unit builds successfully");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("`vcs` reports a clean working state");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain(
      "Publish the committed event only when the requested workflow includes advancing protected main"
    );
  });

  it("appends Vibestudio, workspace, skills, and channel prompts by default", () => {
    const prompt = composeSystemPrompt({
      workspacePrompt: "WORKSPACE",
      skillIndex: "SKILLS",
      agentPrompt: "AGENT",
      systemPrompt: "CHANNEL",
    });

    expect(prompt).toContain(VIBESTUDIO_BASE_SYSTEM_PROMPT);
    expect(prompt.indexOf(VIBESTUDIO_BASE_SYSTEM_PROMPT)).toBeLessThan(prompt.indexOf("WORKSPACE"));
    expect(prompt.indexOf("WORKSPACE")).toBeLessThan(prompt.indexOf("SKILLS"));
    expect(prompt.indexOf("SKILLS")).toBeLessThan(prompt.indexOf("AGENT"));
    expect(prompt.indexOf("AGENT")).toBeLessThan(prompt.indexOf("CHANNEL"));
  });

  it("lets a channel prompt replace the Vibestudio base while preserving workspace resources and agent behavior", () => {
    const prompt = composeSystemPrompt({
      workspacePrompt: "WORKSPACE",
      skillIndex: "SKILLS",
      agentPrompt: "AGENT",
      systemPrompt: "CHANNEL",
      systemPromptMode: "replace-vibestudio",
    });

    expect(prompt).not.toContain(VIBESTUDIO_BASE_SYSTEM_PROMPT);
    expect(prompt.indexOf("CHANNEL")).toBeLessThan(prompt.indexOf("WORKSPACE"));
    expect(prompt.indexOf("WORKSPACE")).toBeLessThan(prompt.indexOf("SKILLS"));
    expect(prompt.indexOf("SKILLS")).toBeLessThan(prompt.indexOf("AGENT"));
  });

  it("keeps the Vibestudio base when replace-vibestudio has no replacement prompt", () => {
    const prompt = composeSystemPrompt({
      workspacePrompt: "WORKSPACE",
      systemPromptMode: "replace-vibestudio",
    });

    expect(prompt).toContain(VIBESTUDIO_BASE_SYSTEM_PROMPT);
    expect(prompt.indexOf(VIBESTUDIO_BASE_SYSTEM_PROMPT)).toBeLessThan(prompt.indexOf("WORKSPACE"));
  });

  it("lets a channel prompt replace the full prompt", () => {
    expect(
      composeSystemPrompt({
        workspacePrompt: "WORKSPACE",
        skillIndex: "SKILLS",
        systemPrompt: "CHANNEL",
        systemPromptMode: "replace",
      })
    ).toBe("CHANNEL");
  });

  it("keeps Vibestudio rich-message and browser-open guidance in the base prompt", () => {
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("MDX supports standard Markdown");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("Callout.Root");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("<ActionButton message=");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("openExternal(url)");
  });

  it("keeps diagram guidance in the base prompt", () => {
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("```mermaid");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("sequenceDiagram");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("<Diagram code=");
  });

  it("asks agents to use proper grammar in intermediate messages", () => {
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain(
      "Use proper grammar in commentary/intermediate messages."
    );
  });

  it("asks ordinary agents to replace first-message titles with stable conversation identity", () => {
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("When `set_title` is available");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain(
      "Replace the automatic first-message title with a compact noun phrase"
    );
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain(
      "retitle only when the conversation's enduring purpose materially changes"
    );
  });

  it("makes live docs the bounded platform-discovery contract", () => {
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("start with the relevant skill docs");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("`docs_search`/`docs_open`");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("Keep discovery bounded");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("instead of continuing broad source searches");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain(
      "not eval globals or `@workspace/runtime` exports"
    );
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain(
      "never emit `docs.search` or `docs.open` inside eval code"
    );
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("typed `workspace_service` tool");
  });

  it("treats structured UI interaction metadata as the selected stable action", () => {
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("structured `interaction` object");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("exact selected action");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("do not reverse-engineer component source");
  });

  it("includes core conversation fork and subagent operating guidance", () => {
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("## Conversation Forks And Subagents");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("Omit `config` by default");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("do not guess or restate your model");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("do not conflate them");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("cache-compatible model transport");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain(
      "changing provider or model does not inherit the parent's provider cache"
    );
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain(
      'Prefer `mode: "fresh"` when a precise task, paths, and durable workspace context are sufficient'
    );
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain(
      "do not poll a live child with status, transcript, log, or diff reads"
    );
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain(
      "only when that goal requires incorporating the child's work"
    );
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain(
      "when the user explicitly asks to inspect, review, or compare child work"
    );
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("complete({ report, outcome })");
    expect(VIBESTUDIO_BASE_SYSTEM_PROMPT).toContain("packages/agentic-do/SKILL.md");
  });
});
