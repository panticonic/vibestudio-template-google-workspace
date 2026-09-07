/**
 * useAccountProfiles — live `user:<userId>` → account-profile projection
 * (WP6 §6).
 *
 * Channel state stores only the STABLE human identity (`id: user:<userId>`);
 * everything mutable (handle, displayName, color, avatar) resolves live from
 * the host's `account.resolveProfiles` RPC — the host reads the shared
 * identity DB and projects it down; userland never opens the DB (INV-2). So an
 * `hubControl.updateProfile` re-renders every roster badge and transcript actor
 * WITHOUT any roster rewrite: components just re-resolve.
 *
 * The plain `resolveAccountProfiles` fetcher is exported as a clean seam for
 * other consumers of the same projection (e.g. the WP8 presence agent).
 */

import { useEffect, useMemo, useRef, useState } from "react";

/** Prefix of channel-stamped human participant ids (WP6 §4). */
export const USER_PARTICIPANT_PREFIX = "user:";

/** `user:<userId>` → `<userId>`, or null for non-human participant ids. */
export function userIdFromParticipantId(participantId: string): string | null {
  return participantId.startsWith(USER_PARTICIPANT_PREFIX)
    ? participantId.slice(USER_PARTICIPANT_PREFIX.length)
    : null;
}

/** Live profile projection returned by the host's `account` service. */
export interface AccountProfile {
  userId: string;
  handle: string;
  displayName: string;
  /** Hex tint for handle/presence rendering. */
  color?: string;
  /** Inline `data:` URI avatar (WP0 §3.8). */
  avatar?: string;
  /** Revoked accounts still resolve so historical attribution renders. */
  revoked?: boolean;
}

/** The minimal RPC shape needed (matches `ChatSandboxValue.rpc` / panel RPC). */
export interface AccountRpc {
  call(targetId: string, method: string, args: unknown[]): Promise<unknown>;
}

/**
 * Batch-resolve userIds to live profiles via the host RPC. Unknown ids are
 * absent from the result. Seam shared with non-React consumers (presence).
 */
export async function resolveAccountProfiles(
  rpc: AccountRpc,
  userIds: readonly string[]
): Promise<Map<string, AccountProfile>> {
  const profiles = new Map<string, AccountProfile>();
  if (userIds.length === 0) return profiles;
  const result = (await rpc.call("main", "account.resolveProfiles", [[...userIds]])) as Record<
    string,
    AccountProfile
  > | null;
  for (const [userId, profile] of Object.entries(result ?? {})) {
    profiles.set(userId, profile);
  }
  return profiles;
}

/** Re-poll cadence: profile edits are rare and the read is a local SQLite hit. */
const PROFILE_REFRESH_INTERVAL_MS = 30_000;

/**
 * Resolve the account profiles behind any `user:`-prefixed ids in
 * `participantIds`. Non-human ids are ignored. Refetches when the id set
 * changes and on a slow poll, so a profile edit propagates without channel
 * traffic. Returns a map keyed by BOTH `user:<userId>` and bare `<userId>` for
 * convenient lookup from participant rows and message sender ids.
 */
export function useAccountProfiles(
  rpc: AccountRpc | undefined,
  participantIds: readonly string[]
): Map<string, AccountProfile> {
  const [profiles, setProfiles] = useState<Map<string, AccountProfile>>(new Map());

  // Stable, order-insensitive key so effect re-runs track the SET of user ids.
  const userIdsKey = useMemo(() => {
    const ids = [
      ...new Set(
        participantIds
          .map((id) => userIdFromParticipantId(id))
          .filter((id): id is string => id !== null)
      ),
    ].sort();
    return ids.join("\n");
  }, [participantIds]);

  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  useEffect(() => {
    const userIds = userIdsKey ? userIdsKey.split("\n") : [];
    if (userIds.length === 0 || !rpcRef.current) {
      setProfiles((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      const currentRpc = rpcRef.current;
      if (!currentRpc) return;
      try {
        const resolved = await resolveAccountProfiles(currentRpc, userIds);
        if (cancelled) return;
        const next = new Map<string, AccountProfile>();
        for (const [userId, profile] of resolved) {
          next.set(userId, profile);
          next.set(`${USER_PARTICIPANT_PREFIX}${userId}`, profile);
        }
        setProfiles(next);
      } catch (err) {
        // Rendering falls back to channel-carried metadata; never throw in UI.
        console.warn("[useAccountProfiles] Failed to resolve profiles:", err);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), PROFILE_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [userIdsKey]);

  return profiles;
}
