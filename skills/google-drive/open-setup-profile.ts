import type { GoogleOnboardingStatus } from "@workspace-skills/google-workspace";
import {
  GOOGLE_DRIVE_SCOPES,
  GOOGLE_GMAIL_SCOPES,
  GOOGLE_WORKSPACE_BROAD_SCOPES,
} from "@workspace/google-workspace/providers";
import type { SetupCheckpoint, SetupHandoff } from "./setupGoal/types.js";

export type OwnedSetupProfile = {
  profileId: string;
  label: string;
  current: SetupCheckpoint;
  history: SetupCheckpoint[];
  handoff?: SetupHandoff;
};

export const setupCredentialId = (profileId: string) =>
  `disposable-setup-${profileId}`;

export function readOwnedOnboarding(
  profile: OwnedSetupProfile,
): GoogleOnboardingStatus {
  const { current, profileId } = profile;
  if (!profileId || current.profileId !== profileId)
    throw new Error("The welcome profile is unavailable");
  if (current.warning === "unavailable")
    throw new Error("Current setup confirmation is unavailable");
  const scopes = {
    none: [],
    gmail: GOOGLE_GMAIL_SCOPES,
    drive: GOOGLE_DRIVE_SCOPES,
    workspace: GOOGLE_WORKSPACE_BROAD_SCOPES,
  }[current.coverage];
  const connected =
    current.phase === "verified" || current.phase === "connected";
  return {
    stage: current.phase,
    configured: current.phase !== "needs-setup",
    readyToConnect: current.phase === "ready-to-connect",
    connected,
    ...(connected && {
      credentialId: setupCredentialId(profileId),
      email: `${profileId}@setup.example.test`,
    }),
    credentials: [],
    ...(current.phase === "verified" && {
      verification: { valid: true, scopes: [...scopes] },
    }),
    nextActions: [],
    warnings:
      current.warning === "session-only"
        ? ["This Google Workspace credential has no stored refresh token."]
        : [],
    ...(current.warning === "revoked" && {
      error: "The retained authorization was revoked.",
    }),
    ...(current.warning === "declined" && {
      warnings: ["The last consent attempt was declined."],
    }),
  };
}
