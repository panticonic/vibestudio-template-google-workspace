import type { ProviderRecord, RetainedCompose } from "../../types.js";

/** Compare the retained RFC Message-ID and Gmail thread identity. */
export function matchesComposeIdentity(compose: RetainedCompose, draft: ProviderRecord): boolean {
  return draft.mimeId === compose.mimeId && draft.threadId === compose.threadId;
}
