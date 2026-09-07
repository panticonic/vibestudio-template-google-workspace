/**
 * Code transformation using Sucrase.
 *
 * NOTE: Sucrase (~460KB) is lazy-loaded on first transform to reduce initial bundle size.
 */

export interface TransformOptions {
  /** Source syntax: JavaScript, TypeScript, JSX, or TSX. */
  syntax: "javascript" | "typescript" | "jsx" | "tsx";
}

export interface TransformResult {
  code: string;
  /** Module specifiers found in require() calls */
  requires: string[];
}

// Lazy-loaded sucrase transform function
type SucraseTransform = typeof import("sucrase").transform;
let sucraseTransform: SucraseTransform | null = null;
let sucrasePromise: Promise<SucraseTransform> | null = null;

async function getSucraseTransform(): Promise<SucraseTransform> {
  if (sucraseTransform) {
    return sucraseTransform;
  }
  if (!sucrasePromise) {
    sucrasePromise = import("sucrase").then((m) => {
      sucraseTransform = m.transform;
      return sucraseTransform;
    });
  }
  return sucrasePromise;
}

/**
 * Transform TypeScript/TSX/JSX to CommonJS JavaScript using Sucrase.
 * NOTE: This is now async due to lazy loading of sucrase.
 */
export async function transformCode(source: string, options: TransformOptions): Promise<TransformResult> {
  const transform = await getSucraseTransform();

  const transforms: ("typescript" | "jsx" | "imports")[] = ["imports"];

  if (options.syntax === "typescript" || options.syntax === "tsx") {
    transforms.push("typescript");
  }
  if (options.syntax === "jsx" || options.syntax === "tsx") {
    transforms.push("jsx");
  }

  const result = transform(source, {
    transforms,
    jsxRuntime: "automatic",
    jsxImportSource: "react",
    // Dynamic workspace UI executes inside an already-built panel. Its JSX
    // runtime must not vary with the server process's NODE_ENV: production
    // panel bundles intentionally do not expose jsxDEV. Target the stable
    // react/jsx-runtime contract for both development and packaged hosts.
    production: true,
    disableESTransforms: true,
  });

  const requires = extractRequires(result.code);

  return {
    code: result.code,
    requires,
  };
}

/**
 * Extract module specifiers from require() calls.
 * Used to validate all dependencies are available before execution.
 */
function extractRequires(code: string): string[] {
  const matches = Array.from(code.matchAll(/require\(["']([^"']+)["']\)/g));
  const specifiers: string[] = [];
  for (const match of matches) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return Array.from(new Set(specifiers));
}
