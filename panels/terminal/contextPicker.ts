/**
 * Context-picker model (§4.1) — pure helpers for the terminal panel's
 * "open in context" affordance. Keeping the derivation here (out of the React
 * component) makes the dedup/label logic unit-testable.
 */

/** One live runtime entity, as returned by `runtime.listEntities`. */
export interface LiveEntity {
  id: string;
  kind: string;
  source: string;
  contextId: string;
  title?: string;
  createdAt?: number;
}

/** A pickable context choice surfaced in the dropdown. */
export interface ContextOption {
  contextId: string;
  label: string;
}

/**
 * Derive the distinct live contexts from a flat entity list: dedup by
 * contextId, label each with the best human hint available (an explicit title,
 * else the source of the first entity in the context), and sort newest-first so
 * recently-created contexts surface at the top.
 */
export function deriveContextOptions(entities: LiveEntity[]): ContextOption[] {
  const byContext = new Map<string, { label: string; createdAt: number }>();
  for (const entity of entities) {
    if (!entity.contextId) continue;
    const existing = byContext.get(entity.contextId);
    const label = entity.title?.trim() || entity.source || entity.contextId;
    const createdAt = entity.createdAt ?? 0;
    // Prefer an entity that carries a title, then the earliest-created one, as
    // the label source; track the newest createdAt for ordering.
    if (!existing) {
      byContext.set(entity.contextId, { label, createdAt });
    } else {
      if (entity.title && !existing.label) existing.label = label;
      existing.createdAt = Math.max(existing.createdAt, createdAt);
    }
  }
  return [...byContext.entries()]
    .map(([contextId, { label }]) => ({ contextId, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
