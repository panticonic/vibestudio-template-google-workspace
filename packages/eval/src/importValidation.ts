/**
 * Static-import validation for the eval sandbox.
 *
 * Turns two silent footguns into clear, actionable errors:
 *  1. Importing an ambient-only global (the `EVAL_AMBIENT_ONLY` set:
 *     `services`/`scope`/`scopes`/`db`/`ctx`/`help`/`chat`) from
 *     `@workspace/runtime` — these are injected free variables, not exports, so
 *     importing them shadows the working binding with `undefined`. (`rpc`/`fs`
 *     are NOT in this set — they are genuinely importable.)
 *  2. Importing a name a workspace module does not export — a CJS destructure
 *     yields `undefined` silently, surfacing as a confusing error far away.
 */

import { EVAL_AMBIENT_ONLY } from "@vibestudio/service-schemas/runtime/runtimeSurface.eval";
import { analyzeModuleImports } from "@vibestudio/module-imports";

/**
 * Eval globals that are injected ambiently, NOT exported by `@workspace/runtime`
 * — importing them shadows the working binding with `undefined`. Single source:
 * `EVAL_AMBIENT_ONLY` (so this can't drift from the EvalDO's actual injection).
 */
const PRE_INJECTED = new Set<string>(EVAL_AMBIENT_ONLY);
const RUNTIME_SPECIFIER = "@workspace/runtime";
/** Workspace-controlled namespaces with stable, statically-known named exports. */
const WORKSPACE_NAMESPACE = /^@(?:workspace|workspace-skills|vibestudio)\//;

export interface ParsedImport {
  specifier: string;
  /** Imported (original) names, excluding inline `type` specifiers. */
  named: string[];
  hasDefault: boolean;
  hasNamespace: boolean;
}

export function parseStaticImports(code: string): ParsedImport[] {
  return analyzeModuleImports(code)
    .filter(
      (reference) =>
        reference.kind === "value" &&
        (reference.syntax === "import" || reference.syntax === "export")
    )
    .map(({ specifier, named, hasDefault, hasNamespace }) => ({
      specifier,
      named,
      hasDefault,
      hasNamespace,
    }));
}

/**
 * Throw if eval code imports a pre-injected global from `@workspace/runtime`.
 * (#1) These are ambient — importing them shadows the binding with `undefined`.
 */
export function assertNoPreInjectedImports(
  code: string,
  runtimeModule?: Record<string, unknown> | null
): void {
  for (const imp of parseStaticImports(code)) {
    if (imp.specifier !== RUNTIME_SPECIFIER) continue;
    const offenders = imp.named.filter(
      (name) => PRE_INJECTED.has(name) && !(runtimeModule && name in runtimeModule)
    );
    if (offenders.length === 0) continue;
    const plural = offenders.length > 1;
    throw new Error(
      `${offenders.join(", ")} ${plural ? "are" : "is"} pre-injected into eval as ambient ` +
        `global${plural ? "s" : ""} — use ${plural ? "them" : "it"} directly; do not import ` +
        `${plural ? "them" : "it"} from "${RUNTIME_SPECIFIER}".`
    );
  }
}

/**
 * Throw if eval code imports a name a loaded workspace module does not export.
 * (#2) Only workspace-namespaced modules with object exports are checked, so
 * npm/CJS interop and relative bundles are left alone.
 */
export function assertNamedExportsExist(
  code: string,
  resolveModule: (specifier: string) => unknown
): void {
  for (const imp of parseStaticImports(code)) {
    if (imp.named.length === 0) continue;
    if (!WORKSPACE_NAMESPACE.test(imp.specifier)) continue;
    const mod = resolveModule(imp.specifier);
    if (!mod || typeof mod !== "object") continue; // not loaded, or a non-namespace export
    const exportsObj = mod as Record<string, unknown>;
    const missing = imp.named.filter((name) => !(name in exportsObj));
    if (missing.length === 0) continue;
    const available = Object.keys(exportsObj)
      .filter((k) => k !== "default" && k !== "__esModule")
      .sort();
    const shown = available.slice(0, 30);
    const suffix =
      available.length > shown.length ? `, …(+${available.length - shown.length})` : "";
    const plural = missing.length > 1;
    throw new Error(
      `${missing.join(", ")} ${plural ? "are" : "is"} not exported by "${imp.specifier}". ` +
        `Available: ${shown.join(", ") || "(none)"}${suffix}.`
    );
  }
}
