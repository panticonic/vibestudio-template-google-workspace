/**
 * Internal panel diagnostics — NOT part of the public `@workspace/runtime`
 * surface. The panel host shell / error boundary and first-party "shell" panels
 * import these from `@workspace/runtime/internal/diagnostics`; ordinary userland
 * panels should not need them.
 *
 * (Moved off the public barrel as part of the runtime-surface harmonization:
 * these are error-boundary/RPC-recovery wiring, not portable runtime features.)
 */

export { recoveryCoordinator } from "../panel/transport.js";
export {
  buildPanelRenderErrorPrompt,
  installPanelErrorDiagnosticLauncher,
  openPanelErrorDiagnosticChat,
} from "../panel/errorDebugChat.js";
export type {
  PanelErrorDiagnosticChatResult,
  PanelErrorDiagnosticLauncher,
  PanelRenderErrorDiagnosticRequest,
} from "../panel/errorDebugChat.js";
