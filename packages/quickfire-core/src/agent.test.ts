import { describe, expect, it } from "vitest";
import { QUICKFIRE_AGENT_PROMPT, quickfireAgentConfig } from "./agent";

describe("quickfire agent referent contract", () => {
  const config = () =>
    quickfireAgentConfig("slot-a", {
      title: "Build log",
      source: "panels/build-log",
      parentSlotId: "slot-root",
    });

  it("defines a general-purpose agent whose attached panel is context, not scope", () => {
    expect(QUICKFIRE_AGENT_PROMPT).toContain(
      "general-purpose workspace and computer automation agent",
    );
    expect(QUICKFIRE_AGENT_PROMPT).toContain("not the boundary of your role");
    expect(QUICKFIRE_AGENT_PROMPT).toContain("system presents any approval out of band");
  });

  it("points panel and service orchestration at the portable runtime", () => {
    expect(QUICKFIRE_AGENT_PROMPT).toContain(
      'await panelTree.page({ group: { kind: "children", parentSlotId }, limit: 50 })',
    );
    expect(QUICKFIRE_AGENT_PROMPT).toContain(
      "const { hits } = await panelTree.search({ query, limit: 20 })",
    );
    expect(QUICKFIRE_AGENT_PROMPT).toContain("{ entry: { node, handle }, ancestors }");
    expect(QUICKFIRE_AGENT_PROMPT).toContain('require `authority.effects: "read-write"`');
    expect(QUICKFIRE_AGENT_PROMPT).toContain(
      'const handle = await openPanel(source, { parentId, focus: true, placement: { disposition: "side" } })',
    );
    expect(QUICKFIRE_AGENT_PROMPT).toContain(
      "await handle.movePanel(parentId, { beforeSlotId })",
    );
    expect(QUICKFIRE_AGENT_PROMPT).toContain("await workers.listServices()");
    expect(QUICKFIRE_AGENT_PROMPT).toContain("await workers.resolveService(protocol)");
    expect(config().features).toMatchObject({
      tools: expect.arrayContaining([{ kind: "standard" }]),
    });
  });

  it("makes panel context salient without dictating the user's referent", () => {
    expect(QUICKFIRE_AGENT_PROMPT).toContain(
      "They may be talking about that panel or its contents",
    );
    expect(QUICKFIRE_AGENT_PROMPT).toContain(
      "not a deterministic referent rule",
    );
    expect(QUICKFIRE_AGENT_PROMPT).toContain(
      "keep the two conversations distinct",
    );
    expect(QUICKFIRE_AGENT_PROMPT).toContain(
      "Do not substitute one conversation's history for the other's",
    );
  });

  it("captures one initial panel description in the stable prompt", () => {
    const configured = config();
    expect(configured.systemPromptMode).toBe("append");
    expect(configured.systemPrompt).toContain("<initial-panel-context>");
    expect(configured.systemPrompt).toContain("title: Build log");
    expect(configured.systemPrompt).toContain("source: panels/build-log");
    expect(configured.features).toMatchObject({
      resources: { subject: { kind: "panel-slot", id: "slot-a" } },
      tools: expect.arrayContaining([{ kind: "standard" }]),
    });
  });

  it("defaults new Quickfire agents to the fast Luna profile", () => {
    expect(config()).toMatchObject({
      model: "openai-codex:gpt-5.6-luna",
      thinkingLevel: "high",
    });
  });
});
