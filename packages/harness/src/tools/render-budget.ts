/**
 * One attention budget for every provenance surface.
 *
 * Rendered lines pay rent in the agent's context for the rest of the session,
 * so the budget, the degradation order, and the truncation marker are shared:
 * read memory, walks, query results, search hits, and the `vcs` comparison and
 * blame surfaces all degrade the same way and say so the same way.
 */
export const PROVENANCE_RENDER_BUDGET = 6_000;

/** Marker every surface uses when it drops rendered lines. */
export const PROVENANCE_TRUNCATION_MARKER =
  "… truncated to the render budget; continue with a returned @ref";

/** The one footer: continuations are refs, not repeated call syntax. */
export const PROVENANCE_REF_FOOTER = "continue: pass any @ref back as target";

/**
 * Degrade a block by dropping trailing detail until it fits.
 *
 * `sections` are rendered in order; the last droppable section goes first, so
 * the spine of an answer survives and its trailing frontier does not.
 */
export function renderWithinBudget(input: {
  header: string;
  lines: readonly string[];
  footer?: string;
  budget?: number;
  truncated?: boolean;
}): string {
  const budget = input.budget ?? PROVENANCE_RENDER_BUDGET;
  const lines = [...input.lines];
  let truncated = input.truncated ?? false;
  const render = (): string =>
    [
      input.header,
      ...lines,
      ...(truncated ? [PROVENANCE_TRUNCATION_MARKER] : []),
      ...(input.footer ? [input.footer] : []),
    ].join("\n");
  while (render().length > budget && lines.length > 1) {
    lines.pop();
    truncated = true;
  }
  return render();
}

/** Collapse whitespace and bound one rendered field. */
export function compactText(value: string, limit = 280): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
