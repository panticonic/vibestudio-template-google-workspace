import { describe, expect, it } from "vitest";
import { verifyGmailWorkflowWorld } from "./verify.js";
import { gmailWorkflowWorlds } from "./worlds.js";

describe("Gmail workflow review verification", () => {
  for (const world of gmailWorkflowWorlds) {
    it(world.id, () => {
      expect(verifyGmailWorkflowWorld(world, world.expected)).toBe(true);
      const badStatus = world.expected.status === "ready" ? "blocked" : "ready";
      expect(
        verifyGmailWorkflowWorld(world, {
          ...world.expected,
          status: badStatus,
        }),
      ).toBe(false);
      expect(
        verifyGmailWorkflowWorld(world, { ...world.expected, findings: [] }),
      ).toBe(false);
      for (const finding of world.expected.findings) {
        expect(
          verifyGmailWorkflowWorld(world, {
            ...world.expected,
            findings: [{ ...finding, evidenceIds: ["other-context"] }],
          }),
        ).toBe(false);
      }

      const alias = <T>(value: T): T => {
        let json = JSON.stringify(value);
        for (const id of world.expected.findings.flatMap(
          (finding) => finding.evidenceIds,
        )) {
          json = json.replaceAll(
            JSON.stringify(id),
            JSON.stringify(`anonymous-${id}`),
          );
        }
        return JSON.parse(json);
      };
      const aliased = alias(world);
      expect(verifyGmailWorkflowWorld(aliased, aliased.expected)).toBe(true);
      expect(verifyGmailWorkflowWorld(aliased, world.expected)).toBe(false);
    });
  }

  it("retains distinct tasks across all five facilities", () => {
    expect(new Set(gmailWorkflowWorlds.map((world) => world.id)).size).toBe(
      gmailWorkflowWorlds.length,
    );
    expect(
      new Set(gmailWorkflowWorlds.map((world) => world.request.kind)),
    ).toEqual(new Set(["setup", "read", "attention", "compose", "sync"]));
    expect(
      new Set(
        gmailWorkflowWorlds.map((world) => world.expected.findings[0].code),
      ).size,
    ).toBe(gmailWorkflowWorlds.length);
  });
});
