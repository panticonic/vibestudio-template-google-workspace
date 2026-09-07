// Transform TS/TSX/JSX to CommonJS
export { EVAL_ENGINE_HOST_CONTRACT_VERSION } from "@vibestudio/service-schemas/evalEngine";

export { transformCode } from "./transform.js";
export type { TransformOptions, TransformResult } from "./transform.js";

// Execute transformed code
export {
  execute,
  executeDefault,
  validateRequires,
  preloadRequires,
  getDefaultRequire,
  getAsyncRequire,
  getPreloadModules,
} from "./execute.js";
export type { ExecuteOptions, ExecuteResult, ValidateRequiresResult, PreloadRequiresResult } from "./execute.js";

// Console capture for streaming
export {
  createConsoleCapture,
  formatConsoleEntry,
  formatConsoleOutput,
} from "./consoleCapture.js";
export type { ConsoleCapture, ConsoleEntry } from "./consoleCapture.js";

// Async tracking (unified API for panels and workers)
export { getAsyncTracking } from "./asyncTracking.js";
export type { TrackingContext, AsyncTrackingAPI } from "./asyncTracking.js";

// Unified sandbox execution engine
export {
  executeSandbox,
  compileComponent,
  compileModule,
} from "./sandbox.js";
export type {
  SandboxImportLoader,
  SandboxOptions,
  SandboxResult,
  CompileResult,
  CompileModuleResult,
  CompileComponentOptions,
} from "./sandbox.js";

export {
  loadSourceFileBundle,
  normalizeSourcePath,
  prepareSourceCode,
} from "./sourceFiles.js";
export type {
  LoadSourceFile,
  PreparedSource,
  SourceFileBundle,
  SourceFileOptions,
} from "./sourceFiles.js";

// REPL scope — persistent scope across eval calls
export { ScopeManager } from "./scope.js";
export type { ScopesApi, HydrateResult } from "./scope.js";
export { SqlScopePersistence, SqlScopeRowBackend, SCOPE_TABLE } from "./sqlScopePersistence.js";
export type { SqlLike } from "./sqlScopePersistence.js";
export { ScopePersistenceAdapter } from "./scopePersistenceAdapter.js";
export type { ScopeBlobBackend, ScopeRowBackend } from "./scopePersistenceAdapter.js";
export type {
  ScopePersistence,
  ScopeEntry,
  ScopeListEntry,
} from "./scopePersistence.js";
export { serializeScope, deserializeScope } from "./scopeSerialize.js";
export type { SerializedScope } from "./scopeSerialize.js";
