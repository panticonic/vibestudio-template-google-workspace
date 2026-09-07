/**
 * Portable authoring helpers — pure, target-independent utilities that are
 * IDENTICAL on panel · worker · eval. Both runtime barrels (`panel/index.ts`,
 * `worker/index.ts`) `export * from "./portable.js"` instead of re-declaring
 * these scattered re-exports, so "portable" is a single declared contract rather
 * than a per-barrel accident.
 *
 * Everything here is side-effect-free / SSR-safe (verified): pure
 * string/path/context/link helpers, the zod schema lib, the contract-definition
 * helper, and the gateway fetch factory. NO panel globals, DOM, or RPC
 * singletons.
 */

import { helpfulNamespace } from "./helpfulNamespace.js";
import { Journal, withJournal, currentJournal } from "./journal.js";

// Contract / schema authoring tools
export * as Rpc from "../core/rpc.js";
export { z } from "../core/zod.js";
export { defineContract } from "../core/defineContract.js";

// Pure context-id / path helpers
export { parseContextId, isValidContextId, getInstanceId } from "../core/context.js";
export { normalizePath, getFileName, resolvePath } from "./pathUtils.js";

// Panel-link builder (SSR-guarded) + gateway fetch factory
export { buildPanelLink, buildPanelDeepLink, buildPanelShareLink } from "../core/panelLinks.js";
export type { BuildPanelLinkOptions } from "../core/panelLinks.js";
export { createGatewayFetch } from "./gatewayFetch.js";
export type { GatewayFetch, GatewayFetchConfig } from "./gatewayFetch.js";

// Canonical panel lifecycle contract and the structured error thrown by
// readiness-bearing panel operations.
export { PanelOperationError } from "@vibestudio/shared/panel/observation";
export type {
  PanelDiagnosticPacket,
  PanelFailureCode,
  PanelFailureProvenance,
  PanelFailureStage,
  PanelHostObservation,
  PanelObservation,
  PanelRuntimeFailure,
  PanelRuntimePhase,
  PanelSnapshotObservation,
} from "@vibestudio/shared/panel/observation";

// Pure panel-operation journaling (target-independent) under the `journal`
// namespace — available identically on panel · worker · eval via the barrels.
export type { PanelJournalEntry } from "./journal.js";
export const journal = helpfulNamespace("journal", {
  Journal,
  with: withJournal,
  current: currentJournal,
});
