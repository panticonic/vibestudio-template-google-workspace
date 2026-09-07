/**
 * @workspace/testkit — in-system E2E testing, orchestration, supervision and
 * profiling SDK for userland code (packages, panels, workers, DOs).
 *
 * Designed for eval one-shots: small composable calls, compact serializable
 * results. Convention: full run results go to `scope`, eval returns
 * `summarize(result)`.
 */

// Runner + assertions
export { suite, runSuites, activeTestContext, Suite } from "./run.js";
export type {
  TestContext,
  TestOptions,
  SuiteOptions,
  TestCaseResult,
  SuiteRunResult,
  RunOptions,
} from "./run.js";
export { expect, fail, deepEqual, TestAssertionError } from "./expect.js";

// Reporting + persistence
export { summarize, saveRun, listRuns, loadRun } from "./report.js";
export type { RunSummary, SavedRunRef } from "./report.js";

// Panel automation
export {
  openPanel,
  withPanel,
  waitFor,
  waitForText,
  panelText,
  setViewport,
  clearViewport,
  audit,
  evalInPanel,
} from "./panels.js";
export type { OpenPanelOptions, ViewportSpec, PanelAudit } from "./panels.js";

// Raw CDP
export { rawCdpSession, withCdpSession } from "./cdp.js";
export type { RawCdpSession } from "./cdp.js";

// Worker/DO orchestration + inspection
export { listUnits, unitDiagnostics, callDO, ensureWorker, restartUnit } from "./workers.js";
export type { CompactUnitStatus, UnitDiagnostics } from "./workers.js";

// Supervision
export { Supervisor, supervise } from "./supervise.js";
export type { SupervisionReport, SupervisionFinding } from "./supervise.js";

// Profiling
export { profilePanel, startPanelProfile, heapSnapshot, topFunctions } from "./profile.js";
export { listProfiles, readProfile, saveProfile } from "./profiles-store.js";
export type { ProfileRef } from "./profiles-store.js";
export { flameTreeFromProfile } from "./profile-core.js";
export type { FlameNode, V8Profile } from "./profile-core.js";

// Driver DO (workspace-panel CDP + driver-side profiling). Importing this
// module registers the workspace-panel session route in cdp.ts.
export { driverProfilePanel, driverHeapSnapshot, driverPing } from "./driver.js";

// Workerd profiling (V8 inspector via the approval-gated server bridge)
export {
  listWorkerdTargets,
  workerdInspectorSession,
  profileWorkerd,
  profileDO,
} from "./workerd-profile.js";
export type { WorkerdTarget } from "./workerd-profile.js";

// Bounded wall/resource/build/startup profiling over canonical host services.
export {
  hostPerformanceSnapshot,
  profileHost,
  profileBuild,
  electronPerformanceSnapshot,
  readStartupProfile,
  profilePanelInteraction,
  profilePanelReload,
  summarizeHostSpan,
} from "./performance.js";
export type {
  ElectronProcessPerformanceSnapshot,
  HostSpanProfile,
  HostSpanSummary,
} from "./performance.js";
