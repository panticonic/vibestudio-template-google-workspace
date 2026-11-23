export type SetupPhase =
  | "needs-setup"
  | "ready-to-connect"
  | "connected"
  | "verified"
  | "error";
export type SetupScope = "gmail" | "workspace";
export type SetupBrowser = "here" | "external";
export type SetupRoute =
  | "configure-desktop"
  | "review-consent"
  | "verify-connection"
  | "recover-authorization"
  | "gmail-ready"
  | "workspace-ready"
  | "review-missing-permissions"
  | "account-owner"
  | "permissions-owner";
export type SetupCheckpoint = {
  id: string;
  profileId: string;
  phase: SetupPhase;
  coverage: "none" | "gmail" | "drive" | "workspace";
  durable: boolean;
  /** An explicit no-warning value survives the panel's JSON merge-patch semantics. */
  warning: "declined" | "revoked" | "unavailable" | "session-only" | "none";
};
export type SetupAction =
  | { kind: "scope"; scope: SetupScope }
  | { kind: "browser"; opening: SetupBrowser }
  | { kind: "viewport"; width: 320 | 390 | 1280 }
  | { kind: "reload" };
export type SetupObservation = {
  id: string;
  profile: string;
  current: SetupCheckpoint;
  history: SetupCheckpoint[];
  scope: SetupScope;
  opening: SetupBrowser | null;
  guidance: "gmail" | "workspace" | "unknown";
  marker: string;
  warningVisible: boolean;
  launchEnabled: boolean;
  accountOwner: boolean;
  permissionsOwner: boolean;
  enabledControls: string[];
  width: number;
  overflow: boolean;
};
export type SetupDecision = {
  route: SetupRoute;
  requestedScope: SetupScope;
  currentId: string;
  priorIds: string[];
  launchEnabled: boolean;
  note: string;
};
export type SetupHandoff = {
  decision: SetupDecision;
  observation: string;
};
export type OpenGoogleSetupReport = {
  decision: SetupDecision;
  handoff: SetupHandoff | null;
};
