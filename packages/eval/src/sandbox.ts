/**
 * Unified sandbox execution engine.
 *
 * Consolidates logic from @workspace/agentic-tools/eval/evalTool.ts and
 * @workspace/tool-ui/src/eval/feedbackComponent.tsx into one module.
 *
 * Two entry points:
 * - executeSandbox(): imperative code execution (eval tool)
 * - compileComponent(): React component compilation (inline_ui, load_action_bar, feedback_custom)
 *
 * Both use the same transform → preload → execute pipeline from @workspace/eval.
 */

import type { ComponentType } from "react";
import { parse } from "acorn";
import { transformCode } from "./transform.js";
import {
  execute,
  executeDefault,
  getAsyncRequire,
  getDefaultRequire,
  unavailableModuleMessage,
  validateRequires,
  preloadRequires,
  defaultCompileFunction,
  type CompileFunction,
} from "./execute.js";
import {
  getMissingPackageDeclarations,
  inferImportsFromPackageJson,
  prepareSourceCode,
  type ExternalRequireContext,
  type LoadSourceFile,
} from "./sourceFiles.js";
import {
  createConsoleCapture,
  formatConsoleEntry,
  formatConsoleOutput,
} from "./consoleCapture.js";
import { getAsyncTracking } from "./asyncTracking.js";
import {
  assertNoPreInjectedImports,
  assertNamedExportsExist,
} from "./importValidation.js";
import { instrumentDeadlineCheckpoints } from "./deadline.js";

// =============================================================================
// Types
// =============================================================================

export interface SandboxImportLoader {
  (
    specifier: string,
    ref: string | undefined,
    externals: string[],
  ): Promise<LibraryModuleArtifact>;
  /** Optional build-backed probe supplied by Vibestudio hosts. */
  resolveWorkspaceImport?: (specifier: string) => Promise<boolean>;
}

export interface LibraryModuleArtifact {
  bundle: string;
  format: "cjs" | "async-cjs";
}

export type SandboxFailureKind = "user-code" | "infrastructure" | "cancelled";

export interface SandboxOptions {
  /** Source syntax (default: "tsx") */
  syntax?: "javascript" | "typescript" | "jsx" | "tsx";
  /** Abort signal used to interrupt async eval work and native calls that honor cancellation. */
  signal?: AbortSignal;
  /**
   * Optional absolute wall deadline for cooperative synchronous checkpoints.
   * The host still supplies `signal` for async cancellation and native-code
   * recovery; this field bounds authored loops and recursion in-process.
   */
  deadline?: { atMs: number; timeoutMs: number };
  /** Packages to build and load before execution.
   *  - Workspace packages: value is "latest" or a git ref (branch/tag/SHA)
   *  - npm packages: value is "npm:<version>" (e.g. "npm:^4.17.21", "npm:latest")
   */
  imports?: Record<string, string>;
  /** Console streaming callback */
  onConsole?: (formatted: string) => void;
  /** Dynamic import loader — keeps this module free of runtime/RPC deps */
  loadImport?: SandboxImportLoader;
  /** File path for this source. Enables relative imports. */
  sourcePath?: string;
  /** Preloaded source files keyed by normalized path. */
  sourceFiles?: Record<string, string>;
  /** Source-file loader for resolving relative imports. */
  loadSourceFile?: LoadSourceFile;
  /** Extra scope variables injected into the sandbox */
  bindings?: Record<string, unknown>;
  /**
   * Per-execution module registry. When provided, loaded imports/requires are stored
   * here instead of the per-isolate global `__vibestudioModuleMap__`. This isolates module
   * state between callers that share one isolate (e.g. multi-tenant EvalDO owners). When
   * absent, falls back to the global map for byte-identical panel behavior.
   */
  moduleMap?: Record<string, unknown>;
  /**
   * Require function paired with `moduleMap`. When provided, the engine resolves `require`
   * calls and CJS bundle loads through this instead of the global `__vibestudioRequire__`.
   * When absent, falls back to `getDefaultRequire()` (the global require).
   */
  require?: (id: string) => unknown;
  /** Realm compiler supplied explicitly by workerd's UnsafeEval-backed host. */
  compileFunction?: CompileFunction;
  /** Keep guest free-name resolution inside an allowlisted, private global scope. */
  confinement?: "private-global";
  /** Freeze a loaded module's direct export namespace before it becomes guest-reachable. */
  freezeModuleNamespace?: <T>(value: T) => T;
  /**
   * Panel runtimes still expose a realm-local lazy loader. A confined EvalDO
   * passes false and routes module loading through closure-held runtime options,
   * so no per-owner loader is ever published on the shared isolate global.
   */
  publishLazyLoaderToGlobal?: boolean;
}

export interface SandboxResult {
  success: boolean;
  /** Formatted console output (final) */
  consoleOutput: string;
  /** Return value (if any) */
  returnValue?: unknown;
  /** Exported values */
  exports?: Record<string, unknown>;
  /** Error message (if failed) */
  error?: string;
  /** Stable failure domain used by durable callers to choose terminal policy. */
  failureKind?: SandboxFailureKind;
  /** Stable machine-readable diagnostic; never inferred from error copy. */
  failureCode?: string;
  /** Structured guest/service failure data preserved for agent-facing diagnostics. */
  errorData?: unknown;
  /** Agent-facing panel operation summary, when panel runtime journaling was active. */
  panelJournalFooter?: string;
}

class SandboxInfrastructureError extends Error {
  readonly code: string;

  constructor(code: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "SandboxInfrastructureError";
    this.code = code;
  }
}

const CORRECTABLE_IMPORT_FAILURE_CODES = new Set([
  "invalid_package_specifier",
  "invalid_package_version",
  "invalid_build_ref",
  "eval_module_execution_conflict",
  "unsupported_package",
  "package_not_found",
  "package_manifest_missing",
  "package_export_not_found",
  "package_export_target_missing",
  // An undeclared package import in a managed system test is authored input,
  // not a package-loader outage. Preserve the typed rejection so the agent can
  // choose an available module or repair its code in the same turn.
  "EUNEXPECTEDTESTPROMPT",
]);

function structuredFailureCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  // Only an RPC-shaped error (it carries an errorKind) publishes its `code` as
  // the structured failure code. A bare Node error code (ENOENT, …) thrown by
  // guest code stays a guest exception, not an invocation failure code.
  const directCode = (error as { code?: unknown }).code;
  const directKind = (error as { errorKind?: unknown }).errorKind;
  if (
    typeof directCode === "string" &&
    directCode.length > 0 &&
    typeof directKind === "string" &&
    directKind.length > 0
  ) {
    return directCode;
  }
  const errorData = (error as { errorData?: unknown }).errorData;
  if (!errorData || typeof errorData !== "object") return undefined;
  const code = (errorData as Record<string, unknown>)["code"];
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function guestFailureCode(error: unknown): string {
  const structured = structuredFailureCode(error);
  if (structured) return structured;
  if (error && typeof error === "object" && (error as { name?: unknown }).name === "TypeError") {
    return "guest_type_error";
  }
  return "guest_execution_failed";
}

function structuredFailureData(error: unknown): unknown | undefined {
  if (!error || typeof error !== "object") return undefined;
  const errorData = (error as { errorData?: unknown }).errorData;
  return errorData === undefined ? undefined : safeSerialize(errorData, 8);
}

function structuredFailureKind(error: unknown): SandboxFailureKind | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = structuredFailureCode(error);
  if (code?.startsWith("DO_SCHEMA_") || code === "DO_MAINTENANCE_IN_PROGRESS") {
    return "infrastructure";
  }
  const errorData = (error as { errorData?: unknown }).errorData;
  if (!errorData || typeof errorData !== "object") return undefined;
  const data = errorData as Record<string, unknown>;
  if (
    data["failureKind"] === "infrastructure" ||
    data["failureKind"] === "user-code"
  ) {
    return data["failureKind"];
  }
  const vcsError = data["vcsError"];
  // createProjects owns every byte of a newly generated scaffold. If its exact,
  // immediate protected push fails the build gate, that is a template/build
  // platform defect, not an exception authored by the eval guest.
  if (
    data["code"] === "scaffold_publication_failed" &&
    vcsError &&
    typeof vcsError === "object" &&
    (vcsError as Record<string, unknown>)["code"] === "BuildGateFailed"
  ) {
    return "infrastructure";
  }
  // An in-band scaffold publication is supposed to remain parked at its review
  // until the user answers. Returning `approval-required` after the presenter
  // has already closed (`pending: false`) means the host failed to consume its
  // own decision. Calling that user code encourages an agent to continue from
  // a half-published workspace, compounding one platform fault into more edits.
  const vcsData =
    vcsError && typeof vcsError === "object"
      ? (vcsError as Record<string, unknown>)["errorData"]
      : undefined;
  const acquisition =
    vcsData && typeof vcsData === "object"
      ? (vcsData as Record<string, unknown>)["acquisition"]
      : undefined;
  const authorityFailure =
    vcsData && typeof vcsData === "object"
      ? (vcsData as Record<string, unknown>)["authorityFailure"]
      : undefined;
  if (
    data["code"] === "scaffold_publication_failed" &&
    vcsError &&
    typeof vcsError === "object" &&
    (vcsError as Record<string, unknown>)["code"] === "EACQUIRE" &&
    acquisition &&
    typeof acquisition === "object" &&
    (acquisition as Record<string, unknown>)["pending"] === false &&
    authorityFailure &&
    typeof authorityFailure === "object" &&
    (authorityFailure as Record<string, unknown>)["reasonCode"] ===
      "approval-required"
  ) {
    return "infrastructure";
  }
  return undefined;
}

async function runInfrastructurePhase<T>(
  code: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (signal?.aborted) throw error;
    const structuredCode = structuredFailureCode(error);
    if (structuredCode && CORRECTABLE_IMPORT_FAILURE_CODES.has(structuredCode))
      throw error;
    if (error instanceof SandboxInfrastructureError) throw error;
    throw new SandboxInfrastructureError(code, error);
  }
}

export interface CompileResult<T> {
  success: boolean;
  /** The compiled component/value */
  Component?: T;
  /** Cache key for cleanup */
  cacheKey?: string;
  /** Error message (if failed) */
  error?: string;
  /** Developer-facing stack for the source-loading/compilation boundary. */
  errorStack?: string;
  /** Runtime diagnostics scoped to this compiled component instance. */
  runtime?: { console: ReturnType<typeof createConsoleCapture> };
}

export interface CompileModuleResult<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  success: boolean;
  module?: T;
  cacheKey?: string;
  error?: string;
}

export interface CompileComponentOptions {
  /** Packages to build and load before compilation. Same semantics as eval imports. */
  imports?: Record<string, string>;
  /** Dynamic import loader — keeps this module free of runtime/RPC deps */
  loadImport?: SandboxImportLoader;
  /** File path for this source. Enables relative imports. */
  sourcePath?: string;
  /** Preloaded source files keyed by normalized path. */
  sourceFiles?: Record<string, string>;
  /** Source-file loader for resolving relative imports. */
  loadSourceFile?: LoadSourceFile;
  /** Capture the component's lexical console with this retained-entry capacity. */
  consoleCapacity?: number;
}

// =============================================================================
// Module Map Helpers
// =============================================================================

function getModuleMap(
  override?: Record<string, unknown>,
): Record<string, unknown> {
  return (
    override ??
    (((globalThis as Record<string, unknown>)["__vibestudioModuleMap__"] ??=
      {}) as Record<string, unknown>)
  );
}

interface LoadedLibraryMetadata {
  bundle: string;
  ref: string;
}

/**
 * Tracks build-loaded modules per registry. Entries without metadata belong to
 * the host, so an authored import can never replace React or another exposed
 * panel module merely because it names the same specifier.
 */
const loadedLibraries = new WeakMap<
  Record<string, unknown>,
  Map<string, LoadedLibraryMetadata>
>();

function loadedLibraryMetadata(
  moduleMap: Record<string, unknown>,
  specifier: string,
): LoadedLibraryMetadata | undefined {
  return loadedLibraries.get(moduleMap)?.get(specifier);
}

function importRefKey(ref: string | undefined): string {
  return ref === undefined || ref === "latest" ? "latest" : ref;
}

/**
 * Load a CJS library bundle into the panel's module map.
 * Skips re-execution if the bundle content is identical to what's already loaded.
 */
async function loadLibraryBundle(
  specifier: string,
  artifact: LibraryModuleArtifact,
  moduleMap: Record<string, unknown>,
  requireFn?: (id: string) => unknown,
  compileFunction: CompileFunction = defaultCompileFunction,
  freezeModuleNamespace?: <T>(value: T) => T,
  loadImport?: SandboxImportLoader,
  confinement?: "private-global",
  ref?: string,
): Promise<void> {
  const refKey = importRefKey(ref);
  const existing = loadedLibraryMetadata(moduleMap, specifier);
  if (
    existing?.bundle === artifact.bundle &&
    moduleMap[specifier] !== undefined
  ) {
    // Two refs may resolve to byte-identical artifacts. The acquired artifact
    // is already active, but remember the newly requested ref so future calls
    // can still make the correct cache decision.
    existing.ref = refKey;
    return;
  }

  const resolvedRequire =
    requireFn ??
    ((globalThis as Record<string, unknown>)["__vibestudioRequire__"] as
      | ((id: string) => unknown)
      | undefined);
  if (!resolvedRequire) throw new Error("__vibestudioRequire__ not available");

  const body =
    artifact.format === "async-cjs"
      ? `return (async () => {\n${artifact.bundle}\n})();`
      : artifact.bundle;
  const controlledImport = async (dependency: string): Promise<unknown> => {
    try {
      return resolvedRequire(dependency);
    } catch (originalError) {
      // Bare packages can be acquired through the same dynamic workspace build
      // service as authored imports. Relative imports must be part of the
      // package artifact; accepting an ambient URL/file loader here would cross
      // the package's reviewed authority boundary.
      if (
        !loadImport ||
        dependency.startsWith(".") ||
        dependency.startsWith("/") ||
        dependency.startsWith("node:") ||
        dependency.includes(":")
      ) {
        throw originalError;
      }
      const dependencyArtifact = await runInfrastructurePhase(
        "package_load_failed",
        () => loadImport(dependency, undefined, Object.keys(moduleMap)),
      );
      await loadLibraryBundle(
        dependency,
        dependencyArtifact,
        moduleMap,
        resolvedRequire,
        compileFunction,
        freezeModuleNamespace,
        loadImport,
        confinement,
        undefined,
      );
      return resolvedRequire(dependency);
    }
  };
  const result = execute(body, {
    require: resolvedRequire,
    compileFunction,
    confinement,
    bindings: { __vibestudioImport: controlledImport },
  });
  await result.returnValue;
  moduleMap[specifier] = freezeModuleNamespace
    ? freezeModuleNamespace(result.exports)
    : result.exports;
  let registry = loadedLibraries.get(moduleMap);
  if (!registry) {
    registry = new Map();
    loadedLibraries.set(moduleMap, registry);
  }
  registry.set(specifier, { bundle: artifact.bundle, ref: refKey });
}

/**
 * Build and load workspace packages into the module map.
 */
async function loadImports(
  imports: Record<string, string>,
  loadImport: SandboxImportLoader,
  moduleMapOverride?: Record<string, unknown>,
  requireFn?: (id: string) => unknown,
  compileFunction?: CompileFunction,
  freezeModuleNamespace?: <T>(value: T) => T,
  confinement?: "private-global",
): Promise<void> {
  const moduleMap = getModuleMap(moduleMapOverride);
  for (const [specifier, refValue] of Object.entries(imports)) {
    const ref = refValue === "latest" ? undefined : refValue;
    const existing = loadedLibraryMetadata(moduleMap, specifier);
    // Host-provided modules (panel exposeModules: react, react/jsx-runtime,
    // @radix-ui/*, …) never go through the build service. Asking it for
    // "react" can even resolve to an unrelated workspace unit via basename
    // matching (workspace/packages/react) and build that instead.
    if (moduleMap[specifier] !== undefined) {
      if (!existing || existing.ref === importRefKey(ref)) continue;
    } else {
      if (installPreloadedModuleAlias(specifier, moduleMap)) continue;
      const loadedFromHost = await runInfrastructurePhase(
        "package_load_failed",
        () => loadLazyHostModule(specifier, moduleMap, moduleMapOverride),
      );
      if (loadedFromHost) continue;
    }
    // Recompute externals each iteration so earlier imports are externalized
    const externals = Object.keys(moduleMap);
    // Building/acquiring the artifact is host infrastructure. Executing the
    // acquired package is authored module behavior and intentionally remains
    // outside this wrapper, so an environment-specific or throwing package can
    // be corrected by the agent instead of terminating the whole turn as an
    // infrastructure outage.
    const artifact = await runInfrastructurePhase("package_load_failed", () =>
      loadImport(specifier, ref, externals),
    );
    await loadLibraryBundle(
      specifier,
      artifact,
      moduleMap,
      requireFn,
      compileFunction,
      freezeModuleNamespace,
      loadImport,
      confinement,
      ref,
    );
  }
}

/**
 * Resolve a module deliberately exposed by the panel host but not fetched yet.
 *
 * Panel bundles register exposed modules as lazy chunk loaders so first paint
 * does not pay for every sandbox dependency. Presence in that loader registry
 * is the authoritative distinction between a host module and a workspace/npm
 * import. Do not probe by calling the async require for arbitrary specifiers:
 * a real exposed-chunk failure must remain an infrastructure error, while an
 * absent loader must fall through to the build service.
 *
 * Explicit per-execution module maps (EvalDO confinement) never consult panel
 * globals; their host modules are injected directly into that private map.
 */
async function loadLazyHostModule(
  specifier: string,
  moduleMap: Record<string, unknown>,
  moduleMapOverride?: Record<string, unknown>,
): Promise<boolean> {
  // executeSandbox resolves the ambient map up front and passes that same
  // object through its helpers. Treat only a genuinely private map as a
  // confinement boundary; object identity with the ambient registry is the
  // unambiguous distinction.
  if (moduleMapOverride && moduleMapOverride !== getModuleMap()) return false;
  const globals = globalThis as Record<string, unknown>;
  const loaders = globals["__vibestudioModuleLoaders__"];
  const nativeSpecifiers = globals["__vibestudioNativeImportSpecifiers__"];
  const hasGeneratedLoader =
    !!loaders &&
    typeof loaders === "object" &&
    typeof (loaders as Record<string, unknown>)[specifier] === "function";
  const hasNativeImport =
    nativeSpecifiers instanceof Set && nativeSpecifiers.has(specifier);
  if (!hasGeneratedLoader && !hasNativeImport) return false;

  const asyncRequire = getAsyncRequire();
  if (!asyncRequire) {
    throw new Error(
      `Lazy host module ${specifier} has no async module runtime`,
    );
  }
  const loaded = await asyncRequire(specifier);
  if (moduleMap[specifier] === undefined) moduleMap[specifier] = loaded;
  return true;
}

function installPreloadedModuleAlias(
  specifier: string,
  moduleMap: Record<string, unknown>,
): boolean {
  const candidates: string[] = [];
  const flatScoped = specifier.match(/^@workspace-([^/]+)$/u);
  if (flatScoped) candidates.push(`@workspace/${flatScoped[1]}`);
  const flatBare = specifier.match(/^workspace-([^/]+)$/u);
  if (flatBare) candidates.push(`@workspace/${flatBare[1]}`);
  for (const candidate of candidates) {
    if (moduleMap[candidate] !== undefined) {
      moduleMap[specifier] = moduleMap[candidate];
      return true;
    }
  }
  return false;
}

function installLazyImportLoader(
  loadImport: SandboxOptions["loadImport"] | undefined,
  moduleMapOverride?: Record<string, unknown>,
  requireFn?: (id: string) => unknown,
  compileFunction?: CompileFunction,
): (() => void) | null {
  if (!loadImport) return null;
  const globals = globalThis as Record<string, unknown>;
  const previous = globals["__vibestudioLoadImport__"];
  // NOTE: __vibestudioLoadImport__ is a per-isolate global, but it is NOT eval's import path:
  // eval'd `await import(x)` is compiled by sucrase to `require(x)`, which resolves through
  // the per-object `require`/moduleMap above (and its specifier auto-loads into that map) —
  // fully isolated. This global is only read by the runtime's CDP-client lazy loader
  // (`cdpAutomation.ts`). The closure captures this run's moduleMap/requireFn; the shared slot
  // means two concurrent cross-object runs could clobber it, but it only loads the stateless
  // CDP-client module, so there is no cross-owner data leak.
  globals["__vibestudioLoadImport__"] = async (
    specifier: string,
    refValue?: string,
  ) => {
    const moduleMap = getModuleMap(moduleMapOverride);
    const ref = refValue === "latest" ? undefined : refValue;
    const existing = loadedLibraryMetadata(moduleMap, specifier);
    if (
      moduleMap[specifier] !== undefined &&
      (!existing || existing.ref === importRefKey(ref))
    ) {
      return moduleMap[specifier];
    }
    const artifact = await runInfrastructurePhase("package_load_failed", () =>
      loadImport(specifier, ref, Object.keys(moduleMap)),
    );
    await loadLibraryBundle(
      specifier,
      artifact,
      moduleMap,
      requireFn,
      compileFunction,
      undefined,
      loadImport,
      undefined,
      ref,
    );
    return moduleMap[specifier];
  };
  return () => {
    if (previous === undefined) delete globals["__vibestudioLoadImport__"];
    else globals["__vibestudioLoadImport__"] = previous;
  };
}

async function inferSandboxImports(
  missing: string[],
  loadImport: SandboxImportLoader,
  context: {
    importerPath?: string;
    loadSourceFile?: LoadSourceFile;
    explicitImports?: Record<string, string>;
  },
): Promise<Record<string, string>> {
  const inferred = await inferImportsFromPackageJson(missing, context);
  if (!loadImport.resolveWorkspaceImport) return inferred;

  // Scoped @workspace/@vibestudio packages and declared package.json deps are
  // already covered above. Probe the remaining bare specifiers against the
  // workspace graph so unscoped panels/workers/packages get the same ergonomic
  // auto-import behavior. A false result remains an npm-package error with the
  // existing explicit `imports: { pkg: "npm:..." }` guidance.
  const unresolved = missing.filter(
    (specifier) =>
      inferred[specifier] === undefined &&
      !specifier.startsWith("node:") &&
      !specifier.startsWith("cloudflare:"),
  );
  const resolutions = await Promise.all(
    unresolved.map(async (specifier) => ({
      specifier,
      resolved: await loadImport.resolveWorkspaceImport!(specifier),
    })),
  );
  for (const { specifier, resolved } of resolutions) {
    if (resolved) inferred[specifier] = "latest";
  }
  return inferred;
}

async function ensureRequires(
  requires: string[],
  options: {
    loadImport?: SandboxImportLoader;
    loadSourceFile?: LoadSourceFile;
    sourcePath?: string;
    imports?: Record<string, string>;
    moduleMap?: Record<string, unknown>;
    require?: (id: string) => unknown;
    compileFunction?: CompileFunction;
    freezeModuleNamespace?: <T>(value: T) => T;
    confinement?: "private-global";
  } = {},
  context?: ExternalRequireContext,
): Promise<void> {
  if (requires.length === 0) return;
  const requireFn = options.require ?? getDefaultRequire();
  if (!requireFn)
    throw new Error(
      "__vibestudioRequire__ not available. Build may be outdated.",
    );

  let validation = validateRequires(requires, requireFn);
  if (!validation.valid && options.loadImport) {
    const moduleMap = getModuleMap(options.moduleMap);
    const missing = requires.filter((r) => !moduleMap[r]);
    const inferredImports = await inferSandboxImports(
      missing,
      options.loadImport,
      {
        importerPath: context?.importerPath ?? options.sourcePath,
        loadSourceFile: options.loadSourceFile,
        explicitImports: options.imports,
      },
    );

    if (Object.keys(inferredImports).length > 0) {
      await loadImports(
        inferredImports,
        options.loadImport,
        options.moduleMap,
        options.require,
        options.compileFunction,
        options.freezeModuleNamespace,
        options.confinement,
      );
      validation = validateRequires(requires, requireFn);
    }
  }

  if (!validation.valid) {
    const preload = await preloadRequires(requires);
    if (preload.success) return;
    validation = validateRequires(requires, requireFn);
  }

  if (!validation.valid) {
    const missingModules = requires.filter(
      (r) => !getModuleMap(options.moduleMap)[r],
    );
    const missingDeclarations = await getMissingPackageDeclarations(
      missingModules,
      {
        importerPath: context?.importerPath ?? options.sourcePath,
        loadSourceFile: options.loadSourceFile,
        explicitImports: options.imports,
      },
    );
    if (missingDeclarations.length > 0) {
      throw new Error(
        `Package import not declared for file-loaded source: ${missingDeclarations.join("; ")}. Add it to package.json dependencies or pass the imports parameter.`,
      );
    }
    throw new Error(
      validation.error ?? `Module "${validation.missingModule}" not available`,
    );
  }
}

// =============================================================================
// Serialization
// =============================================================================

/**
 * Safely serialize a value for JSON transmission.
 * Handles circular references, functions, symbols, and other non-serializable types.
 */
function safeSerialize(value: unknown, maxDepth = 10): unknown {
  const seen = new WeakSet<object>();

  function serialize(val: unknown, depth: number): unknown {
    if (val === null || val === undefined) return val;
    if (
      typeof val === "string" ||
      typeof val === "number" ||
      typeof val === "boolean"
    )
      return val;
    if (typeof val === "function")
      return `[Function: ${val.name || "anonymous"}]`;
    if (typeof val === "symbol") return val.toString();
    if (typeof val === "bigint") return val.toString();
    if (typeof val !== "object") return String(val);
    if (depth > maxDepth) return "[Max depth exceeded]";
    if (seen.has(val)) return "[Circular]";
    seen.add(val);
    if (val instanceof Date) return val.toISOString();
    if (val instanceof RegExp) return val.toString();
    if (val instanceof Error)
      return { name: val.name, message: val.message, stack: val.stack };
    if (val instanceof Map)
      return {
        __type: "Map",
        entries: serialize(Array.from(val.entries()), depth + 1),
      };
    if (val instanceof Set)
      return {
        __type: "Set",
        values: serialize(Array.from(val.values()), depth + 1),
      };
    if (ArrayBuffer.isView(val) || val instanceof ArrayBuffer)
      return `[${val.constructor.name}]`;
    if (Array.isArray(val))
      return val.map((item) => serialize(item, depth + 1));
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(val)) {
      try {
        result[key] = serialize(
          (val as Record<string, unknown>)[key],
          depth + 1,
        );
      } catch {
        result[key] = "[Unserializable]";
      }
    }
    return result;
  }

  return serialize(value, 0);
}

function wrapForTopLevelAwait(code: string): string {
  return `return (async () => {\n${code}\n})()`;
}

/**
 * Eval is a notebook/REPL surface, so a final expression is its completion
 * value. Apply this after TypeScript/JSX and import transforms: Acorn then sees
 * plain JavaScript, and source ranges let us preserve every preceding byte
 * without regex-guessing where an expression begins.
 */
function returnTrailingExpression(code: string): string {
  let program: {
    body: Array<{
      type: string;
      start: number;
      end: number;
      expression?: { start: number; end: number };
    }>;
  };
  try {
    program = parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
    }) as typeof program;
  } catch {
    // The normal execution compiler owns syntax diagnostics. Completion-value
    // detection must never replace a more useful parse/transform error.
    return code;
  }
  const statement = program.body.at(-1);
  const expression =
    statement?.type === "ExpressionStatement"
      ? statement.expression
      : undefined;
  if (!statement || !expression) return code;
  return (
    code.slice(0, statement.start) +
    `return (${code.slice(expression.start, expression.end)});` +
    code.slice(statement.end)
  );
}

/**
 * Model/tool transports occasionally leave JSON-style whitespace escapes in
 * executable code (for example `afterCommit,\\n afterPush`). Such escapes are
 * invalid outside literals. Repair only code-state escapes; strings, template
 * text, comments, and regular expressions retain their bytes.
 */
function repairEscapedWhitespaceOutsideLiterals(code: string): string {
  type Mode =
    | "code"
    | "single"
    | "double"
    | "template"
    | "line-comment"
    | "block-comment"
    | "regex";
  let mode: Mode = "code";
  let escaped = false;
  let regexClass = false;
  let previousSignificant = "";
  let output = "";

  const regexCanStartAfter = (char: string): boolean =>
    char === "" || "([{,:;=!?&|+-*%^~<>".includes(char);

  for (let index = 0; index < code.length; index++) {
    const char = code[index]!;
    const next = code[index + 1];

    if (mode === "line-comment") {
      output += char;
      if (char === "\n" || char === "\r") mode = "code";
      continue;
    }
    if (mode === "block-comment") {
      output += char;
      if (char === "*" && next === "/") {
        output += next;
        index++;
        mode = "code";
      }
      continue;
    }
    if (mode !== "code") {
      output += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (mode === "regex") {
        if (char === "[") regexClass = true;
        else if (char === "]") regexClass = false;
        else if (char === "/" && !regexClass) mode = "code";
      } else if (
        (mode === "single" && char === "'") ||
        (mode === "double" && char === '"') ||
        (mode === "template" && char === "`")
      ) {
        mode = "code";
      }
      continue;
    }

    if (char === "/" && next === "/") {
      output += "//";
      index++;
      mode = "line-comment";
      continue;
    }
    if (char === "/" && next === "*") {
      output += "/*";
      index++;
      mode = "block-comment";
      continue;
    }
    if (char === "'") mode = "single";
    else if (char === '"') mode = "double";
    else if (char === "`") mode = "template";
    else if (char === "/" && regexCanStartAfter(previousSignificant)) {
      mode = "regex";
      regexClass = false;
    } else if (
      char === "\\" &&
      (next === "n" || next === "r" || next === "t")
    ) {
      if (next === "r" && code[index + 2] === "\\" && code[index + 3] === "n") {
        output += "\n";
        index += 3;
      } else {
        output += next === "t" ? " " : "\n";
        index++;
      }
      continue;
    }

    output += char;
    if (!/\s/u.test(char)) previousSignificant = char;
  }
  return output;
}

/**
 * Eval is REPL-like: a trailing async IIFE is an implicit result, not detached
 * background work. Awaiting it makes errors/output visible and prevents agents
 * from retrying a still-running mutation because the tool returned `(no output)`.
 * Explicit `void (async ... )()` remains the opt-in detached form.
 */
function awaitTrailingAsyncIife(code: string): string {
  const starts = [...code.matchAll(/^\(async\s*\(\s*\)\s*=>/gmu)];
  const start = starts.at(-1)?.index;
  if (start === undefined) return code;
  const suffix = code.slice(start).trim();
  if (!/\}\s*\)\s*\(\s*\)\s*;?$/u.test(suffix)) return code;
  return `${code.slice(0, start)}return await ${code.slice(start)}`;
}

/** Return a final top-level object literal like a notebook/REPL result. */
function returnTrailingObjectLiteral(code: string): string {
  type Mode =
    | "code"
    | "single"
    | "double"
    | "template"
    | "line-comment"
    | "block-comment"
    | "regex";
  let mode: Mode = "code";
  let escaped = false;
  let regexClass = false;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let lineStart = 0;
  let candidate = -1;
  let previousSignificant = "";
  const regexCanStartAfter = (char: string): boolean =>
    char === "" || "([{,:;=!?&|+-*%^~<>".includes(char);

  for (let index = 0; index < code.length; index++) {
    const char = code[index]!;
    const next = code[index + 1];
    if (mode === "line-comment") {
      if (char === "\n" || char === "\r") {
        mode = "code";
        lineStart = index + 1;
      }
      continue;
    }
    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        index++;
        mode = "code";
      }
      continue;
    }
    if (mode !== "code") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (mode === "regex") {
        if (char === "[") regexClass = true;
        else if (char === "]") regexClass = false;
        else if (char === "/" && !regexClass) mode = "code";
      } else if (
        (mode === "single" && char === "'") ||
        (mode === "double" && char === '"') ||
        (mode === "template" && char === "`")
      ) {
        mode = "code";
      }
      continue;
    }
    if (char === "\n" || char === "\r") {
      lineStart = index + 1;
      continue;
    }
    if (char === "/" && next === "/") {
      index++;
      mode = "line-comment";
      continue;
    }
    if (char === "/" && next === "*") {
      index++;
      mode = "block-comment";
      continue;
    }
    if (char === "'") mode = "single";
    else if (char === '"') mode = "double";
    else if (char === "`") mode = "template";
    else if (char === "/" && regexCanStartAfter(previousSignificant)) {
      mode = "regex";
      regexClass = false;
    } else if (char === "(") parens++;
    else if (char === ")") parens = Math.max(0, parens - 1);
    else if (char === "[") brackets++;
    else if (char === "]") brackets = Math.max(0, brackets - 1);
    else if (char === "{") {
      if (
        parens === 0 &&
        brackets === 0 &&
        braces === 0 &&
        code.slice(lineStart, index).trim() === ""
      ) {
        candidate = index;
      }
      braces++;
    } else if (char === "}") braces = Math.max(0, braces - 1);
    if (!/\s/u.test(char)) previousSignificant = char;
  }

  if (candidate < 0 || parens !== 0 || brackets !== 0 || braces !== 0)
    return code;
  const prefix = code.slice(0, candidate);
  if (prefix.trim() && !prefix.trimEnd().endsWith(";")) return code;
  const suffix = code.slice(candidate).trim().replace(/;\s*$/u, "");
  if (!suffix.startsWith("{") || !suffix.endsWith("}") || !/[:,]/u.test(suffix))
    return code;
  return `${prefix}return (${suffix});`;
}

function normalizeAgentEvalCode(
  code: string,
  repairMissingCallParens = false,
): string {
  const portableCode = repairEscapedWhitespaceOutsideLiterals(
    liftPortableNodeFsSyncCalls(repairLeakedJsonEnvelopeSuffix(code)),
  );
  return returnTrailingObjectLiteral(
    awaitTrailingAsyncIife(
      repairMissingCallParens
        ? repairMissingCallParensBeforeSemicolon(portableCode)
        : portableCode,
    ),
  );
}

const PORTABLE_FS_SYNC_METHODS: Record<string, string> = {
  accessSync: "access",
  appendFileSync: "appendFile",
  chmodSync: "chmod",
  copyFileSync: "copyFile",
  existsSync: "exists",
  lstatSync: "lstat",
  mkdirSync: "mkdir",
  readFileSync: "readFile",
  readdirSync: "readdir",
  readlinkSync: "readlink",
  realpathSync: "realpath",
  renameSync: "rename",
  rmSync: "rm",
  rmdirSync: "rmdir",
  statSync: "stat",
  symlinkSync: "symlink",
  truncateSync: "truncate",
  unlinkSync: "unlink",
  utimesSync: "utimes",
  writeFileSync: "writeFile",
};

/**
 * Eval runs in an async workerd and cannot perform synchronous host I/O. For a
 * direct default/namespace `node:fs` import, lift supported `*Sync(...)` calls
 * to the equivalent awaited context-fs operation. This preserves the familiar
 * Node snippet while keeping all paths owner-scoped by the EvalDO facade.
 */
function liftPortableNodeFsSyncCalls(code: string): string {
  const aliases = new Set<string>();
  const importPattern =
    /\bimport\s+(?:(?:\*\s+as\s+)?([A-Za-z_$][\w$]*))\s+from\s+["'](?:node:)?fs["']/gu;
  for (const match of code.matchAll(importPattern)) {
    if (match[1]) aliases.add(match[1]);
  }
  const requirePattern =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["'](?:node:)?fs["']\s*\)/gu;
  for (const match of code.matchAll(requirePattern)) {
    if (match[1]) aliases.add(match[1]);
  }
  if (aliases.size === 0) return code;

  // `await` is only valid in the eval's outer async body. Never inject it into
  // a nested synchronous function/arrow body: doing so turns otherwise valid
  // user code into a compile-time SyntaxError. Nested code can use the async fs
  // methods explicitly, as it would against any promise-backed filesystem.
  const nestedFunctionRanges = findNestedFunctionBodyRanges(code);
  const aliasPattern = [...aliases].map(escapeRegExp).join("|");
  const methodPattern = Object.keys(PORTABLE_FS_SYNC_METHODS)
    .map(escapeRegExp)
    .join("|");
  const call = new RegExp(
    `\\b(${aliasPattern})\\s*\\.\\s*(${methodPattern})\\s*\\(`,
    "gu",
  );
  return code.replace(
    call,
    (source, alias: string, syncName: string, offset: number) => {
      if (
        nestedFunctionRanges.some(
          ([start, end]) => offset >= start && offset < end,
        )
      )
        return source;
      return `await ${alias}.${PORTABLE_FS_SYNC_METHODS[syncName]}(`;
    },
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Locate ordinary function and block-arrow bodies well enough to protect
 * their source ranges from top-level async lifting. The matcher is deliberately
 * conservative: a false-positive merely leaves a sync call untouched; it can
 * never inject invalid `await` into nested code. */
function findNestedFunctionBodyRanges(code: string): Array<[number, number]> {
  const starts = [
    ...code.matchAll(/\b(?:async\s+)?function\b[^{}]*\{/gu),
    ...code.matchAll(
      /(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*(?::[^={};]+)?=>\s*\{/gu,
    ),
  ]
    .map((match) => (match.index ?? 0) + match[0].lastIndexOf("{"))
    .sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const start of starts) {
    const end = findBalancedBraceEnd(code, start);
    if (end !== null) ranges.push([start, end]);
  }
  ranges.push(...findExpressionArrowRanges(code));
  return ranges;
}

/** Conservatively protect expression-bodied arrows from top-level `await`
 * lifting. A false positive only leaves a sync call untouched; a false
 * negative would produce invalid JavaScript, so uncertain ranges extend to the
 * next top-level statement boundary. */
function findExpressionArrowRanges(code: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const arrowPattern = /=>\s*/gu;
  for (const match of code.matchAll(arrowPattern)) {
    const start = (match.index ?? 0) + match[0].length;
    if (code[start] === "{") continue;
    let parens = 0;
    let brackets = 0;
    let braces = 0;
    let mode:
      | "code"
      | "single"
      | "double"
      | "template"
      | "line-comment"
      | "block-comment" = "code";
    let escaped = false;
    let end = code.length;
    for (let index = start; index < code.length; index++) {
      const char = code[index]!;
      const next = code[index + 1];
      if (mode === "line-comment") {
        if (char === "\n") {
          end = index;
          break;
        }
        continue;
      }
      if (mode === "block-comment") {
        if (char === "*" && next === "/") {
          mode = "code";
          index++;
        }
        continue;
      }
      if (mode !== "code") {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (
          (mode === "single" && char === "'") ||
          (mode === "double" && char === '"') ||
          (mode === "template" && char === "`")
        ) {
          mode = "code";
        }
        continue;
      }
      if (char === "/" && next === "/") {
        mode = "line-comment";
        index++;
      } else if (char === "/" && next === "*") {
        mode = "block-comment";
        index++;
      } else if (char === "'") mode = "single";
      else if (char === '"') mode = "double";
      else if (char === "`") mode = "template";
      else if (char === "(") parens++;
      else if (char === ")") {
        if (parens === 0) {
          end = index;
          break;
        }
        parens--;
      } else if (char === "[") brackets++;
      else if (char === "]") {
        if (brackets === 0) {
          end = index;
          break;
        }
        brackets--;
      } else if (char === "{") braces++;
      else if (char === "}") {
        if (braces === 0) {
          end = index;
          break;
        }
        braces--;
      } else if (
        parens === 0 &&
        brackets === 0 &&
        braces === 0 &&
        (char === ";" || char === "," || char === "\n")
      ) {
        end = index;
        break;
      }
    }
    ranges.push([start, end]);
  }
  return ranges;
}

function findBalancedBraceEnd(code: string, start: number): number | null {
  let depth = 0;
  let mode:
    | "code"
    | "single"
    | "double"
    | "template"
    | "line-comment"
    | "block-comment" = "code";
  let escaped = false;
  for (let index = start; index < code.length; index++) {
    const char = code[index]!;
    const next = code[index + 1];
    if (mode === "line-comment") {
      if (char === "\n") mode = "code";
      continue;
    }
    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        mode = "code";
        index++;
      }
      continue;
    }
    if (mode !== "code") {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (
        (mode === "single" && char === "'") ||
        (mode === "double" && char === '"') ||
        (mode === "template" && char === "`")
      ) {
        mode = "code";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      mode = "line-comment";
      index++;
    } else if (char === "/" && next === "*") {
      mode = "block-comment";
      index++;
    } else if (char === "'") mode = "single";
    else if (char === '"') mode = "double";
    else if (char === "`") mode = "template";
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index + 1;
  }
  return null;
}

/**
 * A model occasionally closes the surrounding tool-call JSON inside the code
 * string, leaving an otherwise complete program followed by a standalone
 * `"}` line. That byte sequence cannot terminate any valid JavaScript program,
 * so removing it is a conservative transport repair rather than source
 * rewriting.
 */
function repairLeakedJsonEnvelopeSuffix(code: string): string {
  return code.replace(/\n\s*"\}\s*$/u, "");
}

/** Repair an unmatched call parenthesis at a line-ending semicolon. */
function repairMissingCallParensBeforeSemicolon(code: string): string {
  const lineRepaired = code
    .split("\n")
    .map((line) => {
      const semicolon = line.match(/^(.*);(\s*(?:\/\/.*)?)$/u);
      if (!semicolon) return line;
      const body = semicolon[1]!;
      if (/^\s*(?:for|while|if|switch|catch|with)\s*\(/u.test(body))
        return line;
      if (!/[\w$.)\]]\s*\(/u.test(body)) return line;

      let mode: "code" | "single" | "double" | "template" = "code";
      let escaped = false;
      let parens = 0;
      let braces = 0;
      let brackets = 0;
      for (const char of body) {
        if (mode !== "code") {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (
            (mode === "single" && char === "'") ||
            (mode === "double" && char === '"') ||
            (mode === "template" && char === "`")
          ) {
            mode = "code";
          }
          continue;
        }
        if (char === "'") mode = "single";
        else if (char === '"') mode = "double";
        else if (char === "`") mode = "template";
        else if (char === "(") parens++;
        else if (char === ")") parens--;
        else if (char === "{") braces++;
        else if (char === "}") braces--;
        else if (char === "[") brackets++;
        else if (char === "]") brackets--;
      }
      if (parens < 1 || parens > 3 || braces !== 0 || brackets !== 0)
        return line;
      return `${body}${")".repeat(parens)};${semicolon[2] ?? ""}`;
    })
    .join("\n");

  // The same model slip often spans several lines, so the opening call and
  // the statement-ending semicolon are not visible to the line-local repair
  // above. Track delimiters across code state and close only a top-level
  // statement whose braces/brackets are balanced. The repaired program still
  // has to pass the real compiler before it can execute.
  type Mode =
    | "code"
    | "single"
    | "double"
    | "template"
    | "line-comment"
    | "block-comment";
  let mode: Mode = "code";
  let escaped = false;
  let parens = 0;
  let braces = 0;
  let brackets = 0;
  let lineStart = 0;
  let output = "";
  for (let index = 0; index < lineRepaired.length; index += 1) {
    const char = lineRepaired[index]!;
    const next = lineRepaired[index + 1];
    if (mode === "line-comment") {
      output += char;
      if (char === "\n" || char === "\r") {
        mode = "code";
        lineStart = index + 1;
      }
      continue;
    }
    if (mode === "block-comment") {
      output += char;
      if (char === "*" && next === "/") {
        output += next;
        index += 1;
        mode = "code";
      }
      continue;
    }
    if (mode !== "code") {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (
        (mode === "single" && char === "'") ||
        (mode === "double" && char === '"') ||
        (mode === "template" && char === "`")
      ) {
        mode = "code";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      output += "//";
      index += 1;
      mode = "line-comment";
      continue;
    }
    if (char === "/" && next === "*") {
      output += "/*";
      index += 1;
      mode = "block-comment";
      continue;
    }
    if (char === "'") mode = "single";
    else if (char === '"') mode = "double";
    else if (char === "`") mode = "template";
    else if (char === "(") parens += 1;
    else if (char === ")") parens = Math.max(0, parens - 1);
    else if (char === "{") braces += 1;
    else if (char === "}") braces = Math.max(0, braces - 1);
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets = Math.max(0, brackets - 1);

    if (
      char === ";" &&
      parens >= 1 &&
      parens <= 3 &&
      braces === 0 &&
      brackets === 0 &&
      !/^\s*(?:for|while|if|switch|catch|with)\s*\(/u.test(
        lineRepaired.slice(lineStart, index),
      )
    ) {
      output += ")".repeat(parens);
      parens = 0;
    }
    output += char;
    if (char === "\n" || char === "\r") lineStart = index + 1;
  }
  return output;
}

function isPromise(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

function createAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const message =
    typeof reason === "string" && reason.length > 0
      ? reason
      : "Eval interrupted";
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError(signal);
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// =============================================================================
// executeSandbox
// =============================================================================

/**
 * Unified imperative execution pipeline.
 *
 * 1. Transform code (Sucrase)
 * 2. Load dynamic imports via loadImport callback
 * 3. Preload requires
 * 4. Wrap for top-level await
 * 5. Set up console capture with streaming
 * 6. Set up async tracking
 * 7. Execute with scope bindings
 * 8. Wait for async operations
 * 9. Safe-serialize return value
 */
export async function executeSandbox(
  code: string,
  options: SandboxOptions = {},
): Promise<SandboxResult> {
  const { syntax = "tsx", bindings = {} } = options;
  const { signal } = options;
  let deactivateDeadline: (() => void) | null = null;

  // Per-execution module registry + require. When the caller passes a `moduleMap`/`require`
  // (e.g. multi-tenant EvalDO, one map per owner), module state is isolated to that map.
  // Otherwise fall back to the per-isolate globals for byte-identical panel behavior.
  const moduleMap = options.moduleMap ?? getModuleMap();
  const requireFn = options.require ?? getDefaultRequire();

  const tracking = getAsyncTracking();
  const trackingContext = tracking?.start();

  const capture = createConsoleCapture();
  let restoreLazyImportLoader: (() => void) | null = null;

  // Pause tracking around onConsole so any promises created by the callback
  // (e.g. ctx.stream()) are not tracked by waitAll.
  const unsubscribe = capture.onEntry((entry) => {
    const formatted = formatConsoleEntry(entry);
    if (tracking && trackingContext) {
      tracking.pause(trackingContext);
      try {
        options.onConsole?.(formatted);
      } finally {
        tracking.resume(trackingContext);
      }
    } else {
      options.onConsole?.(formatted);
    }
  });

  try {
    throwIfAborted(signal);
    let normalizedCode = normalizeAgentEvalCode(code);
    // (#1) Fail loudly if pre-injected globals are imported from the runtime.
    const ambientCompatModule = moduleMap["@workspace/runtime"];
    const ambientCompatExports =
      ambientCompatModule && typeof ambientCompatModule === "object"
        ? (ambientCompatModule as Record<string, unknown>)
        : null;
    try {
      assertNoPreInjectedImports(normalizedCode, ambientCompatExports);
    } catch (originalError) {
      const repairedCode = normalizeAgentEvalCode(code, true);
      if (repairedCode === normalizedCode) throw originalError;
      try {
        assertNoPreInjectedImports(repairedCode, ambientCompatExports);
        normalizedCode = repairedCode;
      } catch {
        throw originalError;
      }
    }
    if (options.publishLazyLoaderToGlobal !== false) {
      restoreLazyImportLoader = installLazyImportLoader(
        options.loadImport,
        moduleMap,
        requireFn,
        options.compileFunction,
      );
    }

    // Load on-demand imports
    if (options.imports && Object.keys(options.imports).length > 0) {
      if (!options.loadImport) {
        throw new Error(
          "loadImport callback required when imports are specified",
        );
      }
      await withAbort(
        loadImports(
          options.imports!,
          options.loadImport!,
          moduleMap,
          requireFn,
          options.compileFunction,
          options.freezeModuleNamespace,
          options.confinement,
        ),
        signal,
      );
    }

    const prepare = (source: string) =>
      withAbort(
        prepareSourceCode(
          source,
          {
            syntax,
            sourcePath: options.sourcePath,
            sourceFiles: options.sourceFiles,
            loadSourceFile: options.loadSourceFile,
            moduleMap,
            require: requireFn,
            compileFunction: options.compileFunction,
            confinement: options.confinement,
            freezeModuleNamespace: options.freezeModuleNamespace,
          },
          (requires, context) =>
            ensureRequires(
              requires,
              {
                loadImport: options.loadImport,
                loadSourceFile: options.loadSourceFile,
                sourcePath: options.sourcePath,
                imports: options.imports,
                moduleMap,
                require: requireFn,
                compileFunction: options.compileFunction,
                freezeModuleNamespace: options.freezeModuleNamespace,
                confinement: options.confinement,
              },
              context,
            ),
        ),
        signal,
      );
    const prepareAndTransform = async (source: string) => {
      const prepared = await prepare(source);
      throwIfAborted(signal);
      const transformed = await withAbort(
        transformCode(prepared.code, { syntax }),
        signal,
      );
      return { prepared, transformed };
    };
    let built: Awaited<ReturnType<typeof prepareAndTransform>>;
    try {
      built = await prepareAndTransform(normalizedCode);
    } catch (originalError) {
      // The missing-call-parenthesis heuristic is intentionally a parse-error
      // fallback. Never rewrite source that already parses: valid regex literals
      // and other JavaScript punctuation must remain byte-for-byte meaningful.
      const repairedCode = normalizeAgentEvalCode(code, true);
      if (repairedCode === normalizedCode) throw originalError;
      try {
        built = await prepareAndTransform(repairedCode);
        normalizedCode = repairedCode;
      } catch {
        throw originalError;
      }
    }
    throwIfAborted(signal);
    const { transformed } = built;
    const completionAwareCode = returnTrailingExpression(transformed.code);
    const deadlineInstrumented = options.deadline
      ? instrumentDeadlineCheckpoints(completionAwareCode)
      : null;
    const executableCode = deadlineInstrumented?.code ?? completionAwareCode;
    let executionBindings = bindings;
    if (deadlineInstrumented && options.deadline) {
      const now = Date.now.bind(Date);
      let active = true;
      const { atMs, timeoutMs } = options.deadline;
      const checkpoint = () => {
        if (active && now() >= atMs)
          throw new Error(`eval timed out after ${timeoutMs}ms`);
      };
      executionBindings = {
        ...bindings,
        [deadlineInstrumented.checkpointName]: checkpoint,
      };
      deactivateDeadline = () => {
        active = false;
      };
    }

    // Validate requires
    if (!requireFn) {
      return {
        success: false,
        consoleOutput: "",
        error: "__vibestudioRequire__ not available. Build may be outdated.",
        failureKind: "infrastructure",
        failureCode: "module_runtime_unavailable",
      };
    }

    let validation = validateRequires(transformed.requires, requireFn);
    if (!validation.valid && options.loadImport) {
      throwIfAborted(signal);
      // Auto-resolve: build missing workspace packages on-demand
      const missingModules = transformed.requires.filter((r) => !moduleMap[r]);
      const autoImports = await withAbort(
        inferSandboxImports(missingModules, options.loadImport, {
          importerPath: options.sourcePath,
          loadSourceFile: options.loadSourceFile,
          explicitImports: options.imports,
        }),
        signal,
      );
      if (Object.keys(autoImports).length > 0) {
        throwIfAborted(signal);
        options.onConsole?.(
          `[eval] Auto-loading: ${Object.keys(autoImports).join(", ")}...`,
        );
        await withAbort(
          loadImports(
            autoImports,
            options.loadImport!,
            moduleMap,
            requireFn,
            options.compileFunction,
            options.freezeModuleNamespace,
            options.confinement,
          ),
          signal,
        );
        validation = validateRequires(transformed.requires, requireFn);
      }
    }
    throwIfAborted(signal);
    if (!validation.valid) {
      const preload = await withAbort(
        preloadRequires(transformed.requires),
        signal,
      );
      if (preload.success)
        validation = validateRequires(transformed.requires, requireFn);
    }
    throwIfAborted(signal);
    if (!validation.valid) {
      const missing = validation.missingModule!;
      if (missing.startsWith("node:")) {
        return {
          success: false,
          consoleOutput: "",
          error: unavailableModuleMessage(missing),
          failureKind: "user-code",
          failureCode: "unsupported_node_module",
        };
      }
      const available = Object.keys(moduleMap);
      const missingModules = transformed.requires.filter((r) => !moduleMap[r]);
      // For npm packages, suggest the imports parameter
      const suggestedImports = Object.fromEntries(
        missingModules.map((m) => [
          m,
          m.startsWith("@workspace") || m.startsWith("@vibestudio/")
            ? "latest"
            : "npm:latest",
        ]),
      );
      const missingDeclarations = await withAbort(
        getMissingPackageDeclarations(missingModules, {
          importerPath: options.sourcePath,
          loadSourceFile: options.loadSourceFile,
          explicitImports: options.imports,
        }),
        signal,
      );
      const packageHint =
        missingDeclarations.length > 0
          ? `\nPackage context: ${missingDeclarations.join("; ")}.`
          : "";
      return {
        success: false,
        consoleOutput: "",
        error: `Module "${missing}" not available.${packageHint} For npm packages, add the imports parameter:\n  imports: ${JSON.stringify(suggestedImports)}\nCurrently loaded: ${available.join(", ")}`,
        failureKind: "user-code",
        failureCode: "module_not_available",
      };
    }

    // (#2) Now that workspace modules are loaded, fail loudly on imports of
    // names they do not export (instead of a silent `undefined`).
    assertNamedExportsExist(
      normalizedCode,
      (specifier) => moduleMap[specifier],
    );

    // Enter tracking context
    if (tracking && trackingContext) {
      tracking.enter(trackingContext);
    }

    const runtimeModule = transformed.requires.includes("@workspace/runtime")
      ? tryRequireRuntimeModule(requireFn)
      : null;
    const journal = createRuntimeJournal(runtimeModule);
    const runUserCode = async () => {
      throwIfAborted(signal);
      const wrapped = wrapForTopLevelAwait(executableCode);
      let result: ReturnType<typeof execute>;
      try {
        result = execute(wrapped, {
          console: capture.proxy,
          bindings: executionBindings,
          require: requireFn,
          compileFunction: options.compileFunction,
          confinement: options.confinement,
        });
      } finally {
        tracking?.exit();
      }

      // The top-level result is the eval's terminal. Observe it before waiting
      // for incidental tracked work: if user code has already rejected, an
      // unrelated in-flight promise must not keep the invocation open forever.
      // Successful runs still drain all tracked work below. No wall-clock limit
      // is imposed; pending primary work finishes only by completion, error, or
      // explicit user interruption.
      throwIfAborted(signal);
      let returnValue = result.returnValue;
      if (isPromise(returnValue)) {
        returnValue = await withAbort(returnValue, signal);
      }
      throwIfAborted(signal);
      if (tracking && trackingContext) {
        await withAbort(tracking.waitAll(trackingContext), signal);
      }
      throwIfAborted(signal);
      return {
        safeReturnValue: safeSerialize(
          returnValue ?? result.exports["default"],
        ),
        exports: result.exports,
      };
    };

    const execution = journal
      ? await runtimeModule.journal.with(journal, runUserCode)
      : await runUserCode();
    throwIfAborted(signal);
    let panelJournalFooter: string | undefined;
    if (journal) {
      try {
        panelJournalFooter = await renderPanelJournalFooter(journal);
      } catch (error) {
        capture.proxy.warn(
          "[eval] Failed to render the panel journal footer:",
          error,
        );
      }
    }
    return {
      success: true,
      consoleOutput: formatConsoleOutput(capture.getEntries()),
      returnValue: execution.safeReturnValue,
      exports: execution.exports,
      panelJournalFooter,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    const errorData = structuredFailureData(err);
    // Typed application failures already carry bounded recovery data. Repeating
    // their transport stack in the primary agent surface obscures that recovery;
    // keep stacks for unstructured exceptions where they remain diagnostic.
    const consoleEntries = capture.getEntries();
    const debugInfo =
      errorStack && errorData === undefined
        ? `\n[eval] Error stack: ${errorStack}`
        : "";
    return {
      success: false,
      consoleOutput: formatConsoleOutput(consoleEntries) + debugInfo,
      error: errorMessage,
      failureKind:
        err instanceof SandboxInfrastructureError
          ? "infrastructure"
          : signal?.aborted
            ? "cancelled"
            : (structuredFailureKind(err) ?? "user-code"),
      failureCode:
        err instanceof SandboxInfrastructureError
          ? err.code
          : signal?.aborted
            ? "eval_cancelled"
            : guestFailureCode(err),
      ...(errorData === undefined ? {} : { errorData }),
    };
  } finally {
    deactivateDeadline?.();
    restoreLazyImportLoader?.();
    unsubscribe();
    if (tracking && trackingContext) {
      tracking.stop(trackingContext);
    }
  }
}

function tryRequireRuntimeModule(
  requireFn: (id: string) => unknown,
): any | null {
  try {
    return requireFn("@workspace/runtime") as any;
  } catch {
    return null;
  }
}

function createRuntimeJournal(runtimeModule: any): any | null {
  if (
    typeof runtimeModule?.journal?.Journal !== "function" ||
    typeof runtimeModule?.journal?.with !== "function"
  ) {
    return null;
  }
  return new runtimeModule.journal.Journal();
}

async function renderPanelJournalFooter(
  journal: any,
): Promise<string | undefined> {
  const entries = Array.isArray(journal?.entries) ? journal.entries : [];
  if (entries.length === 0) return undefined;
  const operations = entries.map((entry: any) => {
    switch (entry.type) {
      case "open":
        return `opened ${entry.source} -> #${entry.id}`;
      case "reload":
        return `reloaded #${entry.id}`;
      case "close":
        return `closed #${entry.id}`;
      case "stateArgs.set":
        return `set stateArgs on #${entry.id}`;
      default:
        return String(entry.type ?? "panel operation");
    }
  });
  return [
    "[panel] Operations:",
    ...operations.map((line: string) => `- ${line}`),
  ].join("\n");
}

// =============================================================================
// compileComponent
// =============================================================================

/**
 * Compile TSX code into a React component.
 *
 * Used for persistent (inline_ui/action bar) and transient (feedback_custom)
 * components.
 * The when-to-compile decision is made by the caller; callers store the result
 * in their own state (React useState / Map) to avoid recompilation on re-render.
 */
export async function compileComponent<
  T = ComponentType<Record<string, unknown>>,
>(
  code: string,
  options: CompileComponentOptions = {},
): Promise<CompileResult<T>> {
  // When requested, the compiled component closes over this injected console
  // for its complete render/event lifecycle. Callers choose the bound because
  // only callers which present the diagnostic should retain it.
  const consoleCapture =
    options.consoleCapacity !== undefined
      ? createConsoleCapture({ capacity: options.consoleCapacity })
      : undefined;
  try {
    if (options.imports && Object.keys(options.imports).length > 0) {
      if (!options.loadImport) {
        throw new Error(
          "loadImport callback required when imports are specified",
        );
      }
      await loadImports(options.imports, options.loadImport);
    }

    const prepared = await prepareSourceCode(
      code,
      {
        syntax: "tsx",
        sourcePath: options.sourcePath,
        sourceFiles: options.sourceFiles,
        loadSourceFile: options.loadSourceFile,
      },
      (requires, context) =>
        ensureRequires(
          requires,
          {
            loadImport: options.loadImport,
            loadSourceFile: options.loadSourceFile,
            sourcePath: options.sourcePath,
            imports: options.imports,
          },
          context,
        ),
    );

    const transformed = await transformCode(prepared.code, { syntax: "tsx" });

    await ensureRequires(
      transformed.requires.filter(
        (specifier) => !prepared.localModuleIds.has(specifier),
      ),
      {
        loadImport: options.loadImport,
        loadSourceFile: options.loadSourceFile,
        sourcePath: options.sourcePath,
        imports: options.imports,
      },
    );

    const cacheKey = transformed.code;
    const Component = executeDefault<T>(
      cacheKey,
      consoleCapture ? { console: consoleCapture.proxy } : {},
    );
    return {
      success: true,
      Component,
      cacheKey,
      ...(consoleCapture ? { runtime: { console: consoleCapture } } : {}),
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof Error && err.stack ? { errorStack: err.stack } : {}),
      ...(consoleCapture ? { runtime: { console: consoleCapture } } : {}),
    };
  }
}

/**
 * Compile TSX code and return the complete CommonJS module exports object.
 *
 * Custom message type modules use named exports (`reduce`, `Pill`, `schema`) in
 * addition to their default component, so callers need the full module rather
 * than just the default export.
 */
export async function compileModule<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  code: string,
  options: CompileComponentOptions = {},
): Promise<CompileModuleResult<T>> {
  try {
    if (options.imports && Object.keys(options.imports).length > 0) {
      if (!options.loadImport) {
        throw new Error(
          "loadImport callback required when imports are specified",
        );
      }
      await loadImports(options.imports, options.loadImport);
    }

    const prepared = await prepareSourceCode(
      code,
      {
        syntax: "tsx",
        sourcePath: options.sourcePath,
        sourceFiles: options.sourceFiles,
        loadSourceFile: options.loadSourceFile,
      },
      (requires, context) =>
        ensureRequires(
          requires,
          {
            loadImport: options.loadImport,
            loadSourceFile: options.loadSourceFile,
            sourcePath: options.sourcePath,
            imports: options.imports,
          },
          context,
        ),
    );

    const transformed = await transformCode(prepared.code, { syntax: "tsx" });

    await ensureRequires(
      transformed.requires.filter(
        (specifier) => !prepared.localModuleIds.has(specifier),
      ),
      {
        loadImport: options.loadImport,
        loadSourceFile: options.loadSourceFile,
        sourcePath: options.sourcePath,
        imports: options.imports,
      },
    );

    const cacheKey = transformed.code;
    const result = execute(cacheKey);
    return { success: true, module: result.exports as T, cacheKey };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
