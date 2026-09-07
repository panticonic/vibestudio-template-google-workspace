import { createPrivateGuestGlobal, getRealmCompiler } from "@vibestudio/shared/evalConfinement";

/**
 * Compiles a function body + named args into a callable. Default uses `new Function`;
 * realms where dynamic codegen is blocked (e.g. workerd) inject one backed by an
 * UnsafeEval binding: `(names, body) => env.unsafeEval.newFunction(body, "eval", ...names)`.
 */
export type CompileFunction = (argNames: string[], body: string) => (...args: unknown[]) => unknown;

const nativeCompileFunction: CompileFunction = (argNames, body) =>
  // Not `new Function` directly: a realm bootstrapped with `tameRealmCodegen()`
  // has an inert global `Function`, and the kernel's compile capability is the
  // constructor captured before taming.
  new (getRealmCompiler())(...argNames, body) as (...args: unknown[]) => unknown;

/**
 * Resolves the realm's compile function: a global `__vibestudioCompileFunction__` override
 * (installed by realms where `new Function` is blocked — e.g. the workerd EvalDO kernel,
 * backed by an UnsafeEval binding) — else native `new Function`. Mirrors how the realm
 * provides `__vibestudioRequire__`.
 */
export const defaultCompileFunction: CompileFunction = (argNames, body) => {
  const override = (globalThis as Record<string, unknown>)["__vibestudioCompileFunction__"] as
    | CompileFunction
    | undefined;
  return (override ?? nativeCompileFunction)(argNames, body);
};

const GUEST_REALMS = new WeakMap<CompileFunction, Record<string, unknown>>();

/**
 * The realm guest code will actually run in — whatever realm `compileFunction`
 * compiles into, which is not necessarily this module's realm (workerd's
 * UnsafeEval binding, a node:vm context in tests). Confinement is a property of
 * that realm, so both the guest global's intrinsics and the codegen check must
 * come from it.
 */
function guestRealmOf(compileFunction: CompileFunction): Record<string, unknown> {
  let realm = GUEST_REALMS.get(compileFunction);
  if (!realm) {
    realm = (compileFunction([], "return globalThis") as () => Record<string, unknown>)();
    GUEST_REALMS.set(compileFunction, realm);
  }
  return realm;
}

/**
 * Execute CJS code with scope injection.
 */
export interface ExecuteOptions {
  /** Additional bindings to inject into scope */
  bindings?: Record<string, unknown>;
  /** Console proxy for capturing output */
  console?: Console;
  /** Custom require function. If not provided, uses globalThis.__vibestudioRequire__ */
  require?: (id: string) => unknown;
  /** Function constructor. If not provided, uses `new Function` (`defaultCompileFunction`). */
  compileFunction?: CompileFunction;
  /** Resolve every free identifier against a private allowlisted guest global. */
  confinement?: "private-global";
}

export interface ExecuteResult {
  /** The exports object (module.exports) */
  exports: Record<string, unknown>;
  /** The return value of the last expression (if any) */
  returnValue: unknown;
}

/**
 * Get the default require function from the global scope.
 * Returns undefined if not available.
 */
export function getDefaultRequire(): ((id: string) => unknown) | undefined {
  return (globalThis as Record<string, unknown>)["__vibestudioRequire__"] as
    | ((id: string) => unknown)
    | undefined;
}

/**
 * Get the async require function from the global scope.
 * Returns undefined if not available.
 */
export function getAsyncRequire(): ((id: string) => Promise<unknown>) | undefined {
  return (globalThis as Record<string, unknown>)["__vibestudioRequireAsync__"] as
    | ((id: string) => Promise<unknown>)
    | undefined;
}

/**
 * Get the preload modules function from the global scope.
 * Returns undefined if not available.
 */
export function getPreloadModules(): ((ids: string[]) => Promise<unknown[]>) | undefined {
  return (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"] as
    | ((ids: string[]) => Promise<unknown[]>)
    | undefined;
}

/**
 * Result of validating module requires.
 */
export interface ValidateRequiresResult {
  valid: boolean;
  /** Missing module specifier (if invalid) */
  missingModule?: string;
  /** Error message (if invalid) */
  error?: string;
}

export function unavailableModuleMessage(spec: string): string {
  if (spec.startsWith("node:")) {
    return `Node built-in module "${spec}" is not available in sandbox eval. Safe node:buffer, node:fs, node:fs/promises, node:path, node:util, node:crypto, and tenant-neutral node:os compatibility modules are supplied by the EvalDO host; use @workspace/runtime APIs such as fs and vcs for other portable work, or put privileged Node work behind a workspace extension/worker service.`;
  }
  return `Module "${spec}" not available. For npm packages, use the imports parameter: imports: { "${spec}": "npm:latest" }`;
}

/**
 * Validate that all required modules are available before execution.
 * This allows early failure with a descriptive error instead of runtime crashes.
 *
 * @param requires - Array of module specifiers to validate
 * @param requireFn - Optional custom require function (defaults to __vibestudioRequire__)
 * @returns Validation result with error details if invalid
 */
export function validateRequires(
  requires: string[],
  requireFn?: (id: string) => unknown
): ValidateRequiresResult {
  const require = requireFn ?? getDefaultRequire();

  if (!require) {
    return {
      valid: false,
      error:
        "__vibestudioRequire__ not available. Provide a custom require function or ensure the runtime is initialized.",
    };
  }

  for (const spec of requires) {
    try {
      require(spec);
    } catch {
      return {
        valid: false,
        missingModule: spec,
        error: unavailableModuleMessage(spec),
      };
    }
  }

  return { valid: true };
}

/**
 * Result of preloading module requires.
 */
export interface PreloadRequiresResult {
  success: boolean;
  /** Module that failed to load (if unsuccessful) */
  failedModule?: string;
  /** Error message (if unsuccessful) */
  error?: string;
}

/**
 * Preload all required modules asynchronously before execution.
 * Uses __vibestudioRequireAsync__ to load modules from CDN if not pre-bundled.
 *
 * @param requires - Array of module specifiers to preload
 * @returns Promise that resolves when all modules are loaded
 */
export async function preloadRequires(requires: string[]): Promise<PreloadRequiresResult> {
  const preloadFn = getPreloadModules();
  const asyncRequire = getAsyncRequire();

  // If preload function is available, use it for parallel loading
  if (preloadFn) {
    try {
      await preloadFn(requires);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Try to extract the module name from the error
      const match = message.match(/Module "([^"]+)"/);
      return {
        success: false,
        failedModule: match?.[1],
        error: message,
      };
    }
  }

  // Fall back to sequential async require
  if (asyncRequire) {
    for (const spec of requires) {
      try {
        await asyncRequire(spec);
      } catch (err) {
        return {
          success: false,
          failedModule: spec,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return { success: true };
  }

  // No async loading available - fall back to sync validation
  const syncResult = validateRequires(requires);
  if (!syncResult.valid) {
    return {
      success: false,
      failedModule: syncResult.missingModule,
      error: syncResult.error,
    };
  }

  return { success: true };
}

export function execute(code: string, options: ExecuteOptions = {}): ExecuteResult {
  const { bindings = {}, console: consoleProxy = console } = options;

  const require =
    options.require ??
    ((globalThis as Record<string, unknown>)["__vibestudioRequire__"] as
      | ((id: string) => unknown)
      | undefined);

  if (!require) {
    throw new Error(
      "__vibestudioRequire__ not available. Provide a custom require function or ensure the runtime is initialized."
    );
  }

  const exports: Record<string, unknown> = {};
  const module = { exports };

  const scopeNames = Object.keys(bindings);
  const scopeValues = Object.values(bindings);

  const compileFunction = options.compileFunction ?? defaultCompileFunction;
  const receiver = [require, exports, module, consoleProxy, ...scopeValues];
  let returnValue: unknown;
  if (options.confinement === "private-global") {
    const runConfined = compileFunction(
      ["scope"],
      `with (scope) {\n` +
        `  return (function(require, exports, module, console, ${scopeNames.join(", ")}) {\n` +
        `    "use strict";\n${code}\n` +
        `  }).apply(undefined, this.receiver);\n` +
        `}`
    );
    // `scope` claims every identifier, including names used by this kernel.
    // Carry invocation values through the sloppy outer function's receiver;
    // the strict guest function has `this === undefined` and cannot observe it.
    returnValue = runConfined.call(
      { receiver },
      createPrivateGuestGlobal(guestRealmOf(compileFunction), bindings)
    );
  } else {
    returnValue = compileFunction(
      ["require", "exports", "module", "console", ...scopeNames],
      `"use strict";\n${code}`
    )(...receiver);
  }

  return {
    // Async-CJS modules can replace module.exports after their first await.
    // Keep the public result live until the linker has observed completion.
    get exports() {
      return module.exports as Record<string, unknown>;
    },
    returnValue,
  };
}

/**
 * Execute and extract the default export.
 * Useful for extracting components or other default-exported values.
 *
 * @returns The default export, or throws if none found
 */
export function executeDefault<T = unknown>(code: string, options: ExecuteOptions = {}): T {
  const result = execute(code, options);

  const defaultExport = (result.exports as { default?: unknown }).default;
  if (defaultExport !== undefined) {
    return defaultExport as T;
  }

  // Check if exports itself is the value (module.exports = something)
  if (
    typeof result.exports === "function" ||
    (typeof result.exports === "object" &&
      result.exports !== null &&
      Object.keys(result.exports).length === 0)
  ) {
    // module.exports was set directly to a non-object or empty object
    // In CJS, if you do `module.exports = fn`, the exports object IS the function
  }

  // If exports is a function directly (module.exports = function)
  if (typeof result.exports === "function") {
    return result.exports as T;
  }

  throw new Error(
    "No default export found. Use `export default function MyComponent(...)` or `export default (props) => ...`. " +
    "Named exports like `export function App(...)` are not sufficient — add the `default` keyword."
  );
}
