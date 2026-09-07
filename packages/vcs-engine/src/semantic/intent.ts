/** Shared, pure intent-evidence ladder.
 *
 * This module deliberately knows nothing about merges, storage, trajectories,
 * or renderers. Callers project those domains into this bounded evidence shape.
 */

export type IntentTier = "stated" | "trigger" | "mechanical";

export interface ResolvedIntent {
  text: string;
  tier: IntentTier;
}

export interface IntentEvidence {
  /** Prose explicitly supplied by the author of the work unit. */
  stated?: string | null;
  /** A coordinator's declared description of an external delta. */
  externalDescription?: string | null;
  /** Exact causal trigger evidence, when the work unit has no statement. */
  trigger?: { text: string; sender: string } | null;
  /** Canonical effect-derived description. It is evidence of mechanics only. */
  mechanical: string;
}

const bounded = (value: string | null | undefined, maximum = 1_200): string | null => {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
};

/** Resolve the first available evidence tier without inventing authorial intent. */
export function resolveIntent(evidence: IntentEvidence): ResolvedIntent {
  const stated = bounded(evidence.stated) ?? bounded(evidence.externalDescription);
  if (stated) return { text: stated, tier: "stated" };

  const trigger = bounded(evidence.trigger?.text);
  if (trigger) {
    const sender = bounded(evidence.trigger?.sender, 160) ?? "requester";
    const prefix = `asked by ${sender}: `;
    const renderedTrigger = bounded(trigger, 1_200 - prefix.length);
    if (!renderedTrigger) {
      throw new Error("Intent trigger evidence cannot be empty after normalization");
    }
    return { text: `${prefix}${renderedTrigger}`, tier: "trigger" };
  }

  const mechanical = bounded(evidence.mechanical);
  if (!mechanical) {
    throw new Error("Intent resolution requires a canonical mechanical description");
  }
  return { text: mechanical, tier: "mechanical" };
}
