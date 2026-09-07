/**
 * Registration-time lint for custom-message renderer sources.
 *
 * Sandbox renderers must be runtime-self-contained: every *value* import must
 * resolve from the panel's host-exposed modules, the registration's declared
 * `imports`, or a relative file (loaded via loadSourceFile). Anything else
 * forces a build-service round trip at render time — at best slow, at worst a
 * misresolved build and a permanently stuck card. Catch it when the type is
 * registered, where the error is attributable and actionable, instead of at
 * render time in someone else's panel.
 */

import { analyzeModuleImports } from "@vibestudio/module-imports";

/** Modules the chat panel exposes to sandbox components (its exposeModules). */
export const DEFAULT_HOST_MODULES: readonly string[] = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@radix-ui/themes",
  "@radix-ui/react-icons",
  "@workspace/runtime",
  "@workspace/react/responsive",
  "@vibestudio/browser-data/client",
];

export interface RendererLintIssue {
  specifier: string;
  message: string;
}

/**
 * Lint renderer source for value imports that the panel cannot satisfy
 * without a build-service call. Returns issues (empty = clean).
 */
export function lintRendererSource(
  code: string,
  opts: {
    /** Declared registration imports (loaded on demand — allowed). */
    imports?: Record<string, string> | undefined;
    /** Host-exposed modules; defaults to the chat panel's exposeModules. */
    hostModules?: readonly string[] | undefined;
  } = {}
): RendererLintIssue[] {
  const allowed = new Set([
    ...(opts.hostModules ?? DEFAULT_HOST_MODULES),
    ...Object.keys(opts.imports ?? {}),
  ]);
  const issues: RendererLintIssue[] = [];
  for (const reference of analyzeModuleImports(code)) {
    if (reference.kind === "type") continue;
    const { specifier } = reference;
    if (
      reference.syntax === "dynamic-import" &&
      (specifier.startsWith("./") || specifier.startsWith("../"))
    ) {
      issues.push({
        specifier,
        message:
          `Dynamic relative import "${specifier}" is not supported by file-loaded sandbox ` +
          `renderers. Use a static relative import so the local module is bundled before render.`,
      });
      continue;
    }
    if (reference.syntax !== "import" && reference.syntax !== "export") continue;
    if (specifier.startsWith("./") || specifier.startsWith("../")) continue;
    if (allowed.has(specifier)) continue;
    issues.push({
      specifier,
      message:
        `Value import "${specifier}" is not host-exposed and not in the registration's imports. ` +
        `It would require a build-service round trip on every render. Either add it to the ` +
        `registration's imports (npm: packages), make it a relative import, inline it, or use ` +
        `\`import type\` if only types are needed.`,
    });
  }
  return issues;
}
