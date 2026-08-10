import type { TriageCandidate } from "./triage-store.js";

export const TRIAGE_SYSTEM_PROMPT = [
  "You triage incoming email metadata against the user's standing attention preferences.",
  'For each numbered candidate decide: "wake" (start an agent digest turn — clearly matches what the user wants to be told about), "surface" (worth showing in passive lists, but not worth interrupting), or "ignore" (noise).',
  "Be conservative with wake: it costs the user attention. When uncertain between surface and ignore, prefer surface.",
  'Respond with ONLY a JSON array, one entry per candidate: [{"i": <number>, "decision": "wake"|"surface"|"ignore", "reason": "<short reason>"}]. No prose, no markdown fences.',
].join("\n");

export function buildTriagePrompt(preferencesText: string, candidates: TriageCandidate[]): string {
  const lines: string[] = [
    "User's attention preferences:",
    preferencesText,
    "",
    `Candidates (${candidates.length}):`,
  ];
  candidates.forEach((candidate, index) => {
    lines.push(
      [
        `${index + 1}.`,
        `from: ${candidate.from || "(unknown)"}`,
        `subject: ${candidate.subject || "(no subject)"}`,
        candidate.category ? `category: ${candidate.category}` : undefined,
        candidate.priorReply ? "prior-reply: yes" : undefined,
        candidate.snippet ? `snippet: ${candidate.snippet}` : undefined,
      ]
        .filter(Boolean)
        .join(" | ")
    );
  });
  return lines.join("\n");
}

export interface TriageVerdict {
  index: number;
  decision: "wake" | "surface" | "ignore";
  reason: string;
}

/**
 * Parse the triage model's JSON response. Returns null when unparseable so
 * the engine can fall back deterministically.
 */
export function parseTriageResponse(text: string, candidateCount: number): TriageVerdict[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const verdicts: TriageVerdict[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const index = Number(entry["i"]);
    const decision = String(entry["decision"]);
    if (!Number.isInteger(index) || index < 1 || index > candidateCount) continue;
    if (decision !== "wake" && decision !== "surface" && decision !== "ignore") continue;
    verdicts.push({
      index,
      decision,
      reason: typeof entry["reason"] === "string" ? entry["reason"].slice(0, 300) : decision,
    });
  }
  return verdicts.length > 0 ? verdicts : null;
}
