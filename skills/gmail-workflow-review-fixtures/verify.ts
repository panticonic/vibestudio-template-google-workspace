import type { GmailWorkflowWorld } from "./worlds.js";

export function verifyGmailWorkflowWorld(
  world: GmailWorkflowWorld,
  candidate: unknown,
): boolean {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !("status" in candidate) ||
    !("findings" in candidate)
  )
    return false;
  if (
    candidate.status !== world.expected.status ||
    !Array.isArray(candidate.findings)
  )
    return false;
  const findings: unknown[] = candidate.findings;
  if (findings.length !== world.expected.findings.length) return false;
  return world.expected.findings.every((expected, index) => {
    const actual = findings[index];
    if (
      !actual ||
      typeof actual !== "object" ||
      !("code" in actual) ||
      !("evidenceIds" in actual)
    )
      return false;
    if (actual.code !== expected.code || !Array.isArray(actual.evidenceIds))
      return false;
    const evidenceIds: unknown[] = actual.evidenceIds;
    return (
      evidenceIds.length === expected.evidenceIds.length &&
      expected.evidenceIds.every((id, position) => evidenceIds[position] === id)
    );
  });
}
