import {
  execute,
  getDefaultRequire,
  preloadRequires,
  unavailableModuleMessage,
  type CompileFunction,
  type ExecuteOptions,
} from "./execute.js";
import { transformCode, type TransformOptions } from "./transform.js";

export type LoadSourceFile = (path: string) => Promise<string>;

export interface SourceFileBundle {
  entryPath: string;
  files: Record<string, string>;
  resolutions: Record<string, string>;
}

export interface SourceFileOptions {
  sourcePath?: string;
  sourceFiles?: Record<string, string>;
  loadSourceFile?: LoadSourceFile;
  /**
   * Per-execution module registry for local modules. When provided, compiled local modules
   * are stored here instead of the per-isolate global `__vibestudioModuleMap__` (isolates
   * multi-tenant callers sharing an isolate). Falls back to the global map when absent.
   */
  moduleMap?: Record<string, unknown>;
  /** Require paired with `moduleMap`; falls back to `getDefaultRequire()` when absent. */
  require?: (id: string) => unknown;
  /** Compiler paired with the execution realm; required where `new Function` is unavailable. */
  compileFunction?: CompileFunction;
  /** Resolve local-module free names through the same private guest global as the entry module. */
  confinement?: ExecuteOptions["confinement"];
  /** Freeze each local module's direct export namespace before publishing it through the module map. */
  freezeModuleNamespace?: <T>(value: T) => T;
}

export interface PreparedSource {
  code: string;
  entryPath?: string;
  sourceFiles?: Record<string, string>;
  localModuleIds: Set<string>;
}

export interface ExternalRequireContext {
  importerPath?: string;
}

type EnsureExternalRequires = (
  requires: string[],
  context?: ExternalRequireContext
) => Promise<void>;

const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];
const INDEX_FILES = EXTENSIONS.map((ext) => `/index${ext}`);

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function hasKnownExtension(filePath: string): boolean {
  return EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

export function normalizeSourcePath(filePath: string, baseDir?: string): string {
  const raw = filePath.replace(/\\/g, "/").trim();
  const combined = baseDir && isRelativeSpecifier(raw) ? `${baseDir}/${raw}` : raw;
  const absolute = combined.startsWith("/");
  const parts: string[] = [];
  for (const part of combined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!absolute) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  const normalized = parts.join("/");
  return absolute ? `/${normalized}` : normalized;
}

function dirname(filePath: string): string {
  const normalized = normalizeSourcePath(filePath);
  const index = normalized.lastIndexOf("/");
  if (index < 0) return "";
  if (index === 0) return "/";
  return normalized.slice(0, index);
}

function parentDir(dirPath: string): string | null {
  const normalized = normalizeSourcePath(dirPath);
  if (!normalized || normalized === "/") return null;
  const index = normalized.lastIndexOf("/");
  if (index < 0) return "";
  if (index === 0) return "/";
  return normalized.slice(0, index);
}

/**
 * Bound for the package.json/tsconfig.json walk-ups below. A workspace unit's
 * config lives at its OWN repo root (`<section>/<unit>/`, e.g. `panels/chat`,
 * `skills/foo`) — a multi-segment path. Container-section roots (`skills/`,
 * `panels/`) and the workspace root (`""`/`/`) are single-segment-or-empty and
 * NEVER hold a unit config, so ascending into them only probes paths that
 * structurally can't exist: wasted reads plus a noisy fs "repo does not exist"
 * warning per miss (e.g. probing `skills/tsconfig.json` while resolving from a
 * docs-only skill). The walk therefore stops once `dir` is no longer inside a
 * unit. (Flat content sections like `meta` hold no code/tsconfig, so excluding
 * single-segment roots loses nothing the eval resolver needs.)
 */
function isInsideWorkspaceUnit(dir: string): boolean {
  return dir.includes("/");
}

// TS/NodeNext lets a `.js`/`.jsx` specifier point at a `.ts`/`.tsx` source.
// Map a written JS extension to the source extensions to try, in priority order.
const SOURCE_EXTENSION_FALLBACKS: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".js"],
  ".jsx": [".tsx", ".jsx"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
};

function candidatePaths(specifier: string, importerPath?: string): string[] {
  const base = normalizeSourcePath(specifier, importerPath ? dirname(importerPath) : undefined);
  // A written `.js`/`.jsx` (etc.) extension should also resolve its `.ts`/`.tsx`
  // source sibling, so authors can use the standard TS import convention.
  for (const [written, fallbacks] of Object.entries(SOURCE_EXTENSION_FALLBACKS)) {
    if (base.endsWith(written)) {
      const stem = base.slice(0, base.length - written.length);
      return fallbacks.map((ext) => `${stem}${ext}`);
    }
  }
  if (hasKnownExtension(base)) return [base];
  return [
    base,
    ...EXTENSIONS.map((ext) => `${base}${ext}`),
    ...INDEX_FILES.map((suffix) => `${base}${suffix}`),
  ];
}

export function findRelativeSpecifiers(code: string): string[] {
  const patterns = [
    /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g,
    /\brequire\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
  ];
  const specifiers: string[] = [];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return Array.from(new Set(specifiers));
}

export function getPackageSpecifier(specifier: string): string | null {
  if (
    !specifier ||
    isRelativeSpecifier(specifier) ||
    specifier.startsWith("/") ||
    specifier.startsWith("#")
  ) {
    return null;
  }
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return parts[0] ?? null;
}

interface PackageJsonShape {
  imports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface TsConfigShape {
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

function getPackageDependencyVersion(
  pkg: PackageJsonShape,
  packageName: string
): string | undefined {
  return (
    pkg.dependencies?.[packageName] ??
    pkg.peerDependencies?.[packageName] ??
    pkg.optionalDependencies?.[packageName]
  );
}

function normalizeDependencyRef(
  specifier: string,
  version: string | undefined
): string | undefined {
  if (specifier.startsWith("@workspace") || specifier.startsWith("@vibestudio/")) {
    if (!version || version.startsWith("workspace:")) return "latest";
    return version;
  }
  if (!version) return undefined;
  if (version.startsWith("npm:")) return version;
  if (version.startsWith("workspace:")) return "latest";
  if (/^(file|link|portal|patch):/.test(version)) return undefined;
  return `npm:${version}`;
}

export async function findNearestPackageJson(
  sourcePath: string | undefined,
  loadSourceFile: LoadSourceFile | undefined
): Promise<{ path: string; dir: string; packageJson: PackageJsonShape } | null> {
  if (!sourcePath || !loadSourceFile) return null;
  let dir: string | null = dirname(sourcePath);

  while (dir !== null && isInsideWorkspaceUnit(dir)) {
    const packagePath = normalizeSourcePath(`${dir}/package.json`);
    try {
      const raw = await loadSourceFile(packagePath);
      return { path: packagePath, dir, packageJson: JSON.parse(raw) as PackageJsonShape };
    } catch {
      dir = parentDir(dir);
    }
  }

  return null;
}

async function findNearestTsConfig(
  sourcePath: string | undefined,
  loadSourceFile: LoadSourceFile | undefined
): Promise<{ path: string; dir: string; tsconfig: TsConfigShape } | null> {
  if (!sourcePath || !loadSourceFile) return null;
  let dir: string | null = dirname(sourcePath);

  while (dir !== null && isInsideWorkspaceUnit(dir)) {
    const tsconfigPath = normalizeSourcePath(`${dir}/tsconfig.json`);
    try {
      const raw = await loadSourceFile(tsconfigPath);
      return { path: tsconfigPath, dir, tsconfig: JSON.parse(raw) as TsConfigShape };
    } catch {
      dir = parentDir(dir);
    }
  }

  return null;
}

export async function inferImportsFromPackageJson(
  specifiers: string[],
  context: {
    importerPath?: string;
    loadSourceFile?: LoadSourceFile;
    explicitImports?: Record<string, string>;
  }
): Promise<Record<string, string>> {
  const inferred: Record<string, string> = {};
  const packageJson = await findNearestPackageJson(context.importerPath, context.loadSourceFile);

  for (const specifier of specifiers) {
    const packageName = getPackageSpecifier(specifier);
    if (!packageName) continue;
    const explicitRef =
      context.explicitImports?.[specifier] ?? context.explicitImports?.[packageName];
    if (explicitRef) {
      inferred[specifier] = explicitRef;
      continue;
    }

    const version = packageJson
      ? getPackageDependencyVersion(packageJson.packageJson, packageName)
      : undefined;
    const ref = normalizeDependencyRef(specifier, version);
    if (ref) inferred[specifier] = ref;
  }

  return inferred;
}

export async function getMissingPackageDeclarations(
  specifiers: string[],
  context: {
    importerPath?: string;
    loadSourceFile?: LoadSourceFile;
    explicitImports?: Record<string, string>;
  }
): Promise<string[]> {
  const packageJson = await findNearestPackageJson(context.importerPath, context.loadSourceFile);
  if (!packageJson) return [];
  const missing: string[] = [];
  for (const specifier of specifiers) {
    const packageName = getPackageSpecifier(specifier);
    if (!packageName) continue;
    if (context.explicitImports?.[specifier] || context.explicitImports?.[packageName]) continue;
    if (!getPackageDependencyVersion(packageJson.packageJson, packageName)) {
      missing.push(`${specifier} (package ${packageName}) is not declared in ${packageJson.path}`);
    }
  }
  return missing;
}

function extractConditionalTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === "string");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      extractConditionalTarget(record["browser"]) ??
      extractConditionalTarget(record["import"]) ??
      extractConditionalTarget(record["default"])
    );
  }
  return undefined;
}

function applyPattern(pattern: string, target: string, specifier: string): string | null {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier ? target : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
  return target.replace("*", matched);
}

function resolveConfigPath(baseDir: string, target: string): string {
  if (target === ".") return normalizeSourcePath(baseDir);
  if (target.startsWith("/")) return normalizeSourcePath(target);
  return normalizeSourcePath(target.startsWith(".") ? target : `./${target}`, baseDir);
}

async function localAliasCandidates(
  specifier: string,
  importerPath: string | undefined,
  loadSourceFile?: LoadSourceFile
): Promise<string[]> {
  if (!importerPath || !loadSourceFile) return [];
  const candidates: string[] = [];

  if (specifier.startsWith("#")) {
    const packageJson = await findNearestPackageJson(importerPath, loadSourceFile);
    if (packageJson?.packageJson.imports) {
      for (const [pattern, value] of Object.entries(packageJson.packageJson.imports)) {
        const target = extractConditionalTarget(value);
        if (!target) continue;
        const applied = applyPattern(pattern, target, specifier);
        if (!applied || !applied.startsWith(".")) continue;
        candidates.push(...candidatePaths(resolveConfigPath(packageJson.dir, applied)));
      }
    }
  }

  const tsconfig = await findNearestTsConfig(importerPath, loadSourceFile);
  const paths = tsconfig?.tsconfig.compilerOptions?.paths;
  if (tsconfig && paths) {
    const baseUrl = resolveConfigPath(
      tsconfig.dir,
      tsconfig.tsconfig.compilerOptions?.baseUrl ?? "."
    );
    for (const [pattern, targets] of Object.entries(paths)) {
      for (const target of targets) {
        const applied = applyPattern(pattern, target, specifier);
        if (!applied) continue;
        candidates.push(...candidatePaths(resolveConfigPath(baseUrl, applied)));
      }
    }
  }

  return Array.from(new Set(candidates));
}

export function findStaticSpecifiers(code: string): string[] {
  const patterns = [
    // Skip whole-statement type-only imports/exports (`import type ... from`,
    // `export type ... from`) — they are erased by the transform and must not
    // be fetched. Inline `import { type X, Y }` still matches (module is loaded).
    /\b(?:import|export)\s+(?!type[\s{])(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const specifiers: string[] = [];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return Array.from(new Set(specifiers));
}

async function resolveSourceFile(
  specifier: string,
  importerPath: string | undefined,
  files: Map<string, string>,
  loadSourceFile?: LoadSourceFile,
  resolutions?: Map<string, string>
): Promise<{ path: string; code: string }> {
  const candidates = !importerPath
    ? candidatePaths(specifier)
    : isRelativeSpecifier(specifier)
      ? candidatePaths(specifier, importerPath)
      : await localAliasCandidates(specifier, importerPath, loadSourceFile);
  if (candidates.length === 0) {
    throw new Error(
      `Specifier "${specifier}" does not resolve to a source file from ${importerPath ?? "<inline source>"}`
    );
  }
  for (const candidate of candidates) {
    const normalized = normalizeSourcePath(candidate);
    const existing = files.get(normalized);
    if (existing !== undefined) {
      if (resolutions && importerPath) resolutions.set(`${importerPath}\n${specifier}`, normalized);
      return { path: normalized, code: existing };
    }
  }

  if (!loadSourceFile) {
    throw new Error(
      `Relative import "${specifier}" could not be resolved from ${importerPath ?? "<inline source>"}`
    );
  }

  const errors: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeSourcePath(candidate);
    try {
      const code = await loadSourceFile(normalized);
      files.set(normalized, code);
      if (resolutions && importerPath) resolutions.set(`${importerPath}\n${specifier}`, normalized);
      return { path: normalized, code };
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  throw new Error(
    `Relative import "${specifier}" could not be resolved from ${importerPath ?? "<inline source>"}. ` +
      `Tried: ${candidates.map((candidate) => normalizeSourcePath(candidate)).join(", ")}. ${errors[errors.length - 1] ?? ""}`.trim()
  );
}

async function tryResolveSourceFile(
  specifier: string,
  importerPath: string,
  files: Map<string, string>,
  loadSourceFile: LoadSourceFile | undefined,
  resolutions: Map<string, string>
): Promise<{ path: string; code: string } | null> {
  if (!isRelativeSpecifier(specifier) && !specifier.startsWith("#")) {
    const aliasCandidates = await localAliasCandidates(specifier, importerPath, loadSourceFile);
    if (aliasCandidates.length === 0) return null;
  }
  try {
    return await resolveSourceFile(specifier, importerPath, files, loadSourceFile, resolutions);
  } catch (err) {
    if (isRelativeSpecifier(specifier)) throw err;
    return null;
  }
}

export async function loadSourceFileBundle(
  entryPath: string,
  loadSourceFile: LoadSourceFile,
  entryCode?: string
): Promise<SourceFileBundle> {
  const files = new Map<string, string>();
  const resolutions = new Map<string, string>();
  const first = await resolveSourceFile(entryPath, undefined, files, async (path) =>
    path === normalizeSourcePath(entryPath) && entryCode !== undefined
      ? entryCode
      : loadSourceFile(path)
  );
  const visiting = new Set<string>();

  async function visit(filePath: string): Promise<void> {
    const normalized = normalizeSourcePath(filePath);
    if (visiting.has(normalized)) return;
    visiting.add(normalized);
    const code = files.get(normalized);
    if (code === undefined) throw new Error(`Source file missing from bundle: ${normalized}`);
    for (const specifier of findStaticSpecifiers(code)) {
      const resolved = await tryResolveSourceFile(
        specifier,
        normalized,
        files,
        loadSourceFile,
        resolutions
      );
      if (resolved) await visit(resolved.path);
    }
  }

  await visit(first.path);
  return {
    entryPath: first.path,
    files: Object.fromEntries(files),
    resolutions: Object.fromEntries(resolutions),
  };
}

function rewriteRelativeSpecifiers(
  code: string,
  importerPath: string,
  resolutions: Map<string, string>
): string {
  function resolve(specifier: string): string {
    return resolutions.get(`${importerPath}\n${specifier}`) ?? specifier;
  }

  return code
    .replace(
      /(\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'])([^"']+)(["'])/g,
      (_match, prefix: string, specifier: string, suffix: string) =>
        `${prefix}${resolve(specifier)}${suffix}`
    )
    .replace(
      /(\brequire\(\s*["'])([^"']+)(["']\s*\))/g,
      (_match, prefix: string, specifier: string, suffix: string) =>
        `${prefix}${resolve(specifier)}${suffix}`
    );
}

async function defaultEnsureExternalRequires(requires: string[]): Promise<void> {
  const external = requires.filter(Boolean);
  if (external.length === 0) return;
  const unavailableNodeBuiltIn = external.find((specifier) => specifier.startsWith("node:"));
  if (unavailableNodeBuiltIn) {
    throw new Error(unavailableModuleMessage(unavailableNodeBuiltIn));
  }
  const preload = await preloadRequires(external);
  if (!preload.success) {
    if (preload.failedModule?.startsWith("node:")) {
      throw new Error(unavailableModuleMessage(preload.failedModule));
    }
    throw new Error(preload.error ?? `Module "${preload.failedModule}" not available`);
  }
}

async function loadLocalModules(
  entryPath: string,
  files: Map<string, string>,
  resolutions: Map<string, string>,
  syntax: TransformOptions["syntax"],
  ensureExternalRequires: EnsureExternalRequires,
  execution: Pick<
    SourceFileOptions,
    "moduleMap" | "require" | "compileFunction" | "confinement" | "freezeModuleNamespace"
  >
): Promise<void> {
  const localModuleIds = new Set(files.keys());
  const loadedContent = new Map<string, string>();
  const loading = new Set<string>();
  const moduleMap =
    execution.moduleMap ??
    (((globalThis as Record<string, unknown>)["__vibestudioModuleMap__"] ??= {}) as Record<
      string,
      unknown
    >);
  const requireFn = execution.require ?? getDefaultRequire();
  if (!requireFn) throw new Error("__vibestudioRequire__ not available. Build may be outdated.");

  async function loadModule(filePath: string): Promise<void> {
    const normalized = normalizeSourcePath(filePath);
    if (normalized === entryPath) return;
    if (loading.has(normalized)) return;

    const code = files.get(normalized);
    if (code === undefined) throw new Error(`Source file missing from bundle: ${normalized}`);

    const rewritten = rewriteRelativeSpecifiers(code, normalized, resolutions);
    if (loadedContent.get(normalized) === rewritten && moduleMap[normalized]) return;

    loading.add(normalized);
    try {
      for (const specifier of findStaticSpecifiers(code)) {
        const resolvedPath = resolutions.get(`${normalized}\n${specifier}`);
        if (resolvedPath) await loadModule(resolvedPath);
      }

      const transformed = await transformCode(rewritten, { syntax });
      const externalRequires = transformed.requires.filter(
        (specifier) => !localModuleIds.has(specifier)
      );
      await ensureExternalRequires(externalRequires, { importerPath: normalized });

      const result = execute(transformed.code, {
        require: requireFn,
        compileFunction: execution.compileFunction,
        confinement: execution.confinement,
      });
      moduleMap[normalized] = execution.freezeModuleNamespace
        ? execution.freezeModuleNamespace(result.exports)
        : result.exports;
      loadedContent.set(normalized, rewritten);
    } finally {
      loading.delete(normalized);
    }
  }

  for (const specifier of findStaticSpecifiers(files.get(entryPath) ?? "")) {
    const resolvedPath = resolutions.get(`${entryPath}\n${specifier}`);
    if (resolvedPath) await loadModule(resolvedPath);
  }
}

export async function prepareSourceCode(
  code: string,
  options: SourceFileOptions & { syntax: TransformOptions["syntax"] },
  ensureExternalRequires: EnsureExternalRequires = defaultEnsureExternalRequires
): Promise<PreparedSource> {
  if (!options.sourcePath) {
    return { code, localModuleIds: new Set() };
  }

  const normalizedFiles = new Map<string, string>();
  for (const [filePath, fileCode] of Object.entries(options.sourceFiles ?? {})) {
    normalizedFiles.set(normalizeSourcePath(filePath), fileCode);
  }

  const bundle = await loadSourceFileBundle(
    options.sourcePath,
    async (filePath) => {
      const normalized = normalizeSourcePath(filePath);
      const existing = normalizedFiles.get(normalized);
      if (existing !== undefined) return existing;
      if (!options.loadSourceFile) {
        throw new Error(`Source file not present in embedded file bundle: ${normalized}`);
      }
      return options.loadSourceFile(normalized);
    },
    code
  );

  const files = new Map<string, string>();
  for (const [filePath, fileCode] of Object.entries(bundle.files)) {
    files.set(normalizeSourcePath(filePath), fileCode);
  }
  const resolutions = new Map(Object.entries(bundle.resolutions));
  const localModuleIds = new Set(files.keys());
  await loadLocalModules(
    bundle.entryPath,
    files,
    resolutions,
    options.syntax,
    ensureExternalRequires,
    options
  );

  return {
    code: rewriteRelativeSpecifiers(
      files.get(bundle.entryPath) ?? code,
      bundle.entryPath,
      resolutions
    ),
    entryPath: bundle.entryPath,
    sourceFiles: Object.fromEntries(files),
    localModuleIds,
  };
}
