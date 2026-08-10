import { failureResult, handleGmailError } from "../errors.js";
import type { GmailChannelState } from "../types.js";
import { missingScopeActionForOperation } from "./operations.js";

export interface GmailErrorPolicyDeps {
  getChannelState: (channelId: string) => GmailChannelState;
  saveChannelState: (state: GmailChannelState) => void;
  publishSetup: (channelId: string) => Promise<void>;
}

/**
 * Convert a thrown GmailApiError into a structured tool result. Auth errors
 * additionally pause polling and surface a reconnect banner on the setup
 * card. Non-Gmail errors are rethrown. Shared by all handler modules so the
 * failure policy cannot drift between them.
 */
export async function failGmailOperation(
  deps: GmailErrorPolicyDeps,
  channelId: string,
  operation: string,
  err: unknown
): Promise<ReturnType<typeof failureResult>> {
  const failure = handleGmailError({ channelId, operation }, err);
  if (!failure) throw err;
  if (failure.kind === "auth") {
    const state = deps.getChannelState(channelId);
    if (state.syncState !== "auth-needed") {
      state.syncState = "auth-needed";
      deps.saveChannelState(state);
      await deps.publishSetup(channelId).catch(() => undefined);
    }
    return failureResult(failure);
  }
  if (failure.kind === "rate-limited") {
    return failureResult(failure);
  }
  if (failure.code === "forbidden") {
    const action = missingScopeActionForOperation(operation);
    if (action) {
      return failureResult({ ...failure, action });
    }
  }
  throw err;
}
