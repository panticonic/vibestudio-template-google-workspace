/**
 * Deterministic id scheme (WS1 §1.5). Every envelopeId and effectId is a pure
 * function of stable coordinates — `crypto.randomUUID()` is banned in this
 * package. Ids are scoped to log lineage (Stage-0 fork-aware idempotency
 * makes post-fork divergence on the same id legal).
 */

export const ids = {
  turnId(channelId: string, triggerEnvelopeId: string, actorId: string): string {
    // Actor-scoped: the responding agent's participant id is part of the turn
    // identity, so two agents reacting to the SAME trigger in the SAME channel
    // derive distinct turnIds (and thus distinct message/effect ids) instead of
    // colliding on the shared per-channel log. Stable per (channel, trigger,
    // actor) ⇒ deterministic replay is preserved per agent.
    return `t:${channelId}:${triggerEnvelopeId}:${actorId}`;
  },

  messageId(turnId: string, modelCallCount: number): string {
    return `m:${turnId}:${modelCallCount}`;
  },

  attemptId(messageId: string): string {
    return `att:${messageId}`;
  },

  transportCallId(invocationId: string): string {
    return `tc:${invocationId}`;
  },

  approvalId(invocationId: string): string {
    return `approval:${invocationId}`;
  },

  credKey(channelId: string, providerId: string): string {
    return `cred:${channelId}:${providerId}`;
  },

  // envelope ids -------------------------------------------------------------

  recvUserMessage(channelId: string, channelEnvelopeId: string): string {
    return `recv:${channelId}:${channelEnvelopeId}`;
  },

  /** A promoted after-turn message's private recv copy. A NEW deterministic id
   *  (not the arrival recv id) so `alreadyIngested`/store dedup never rejects
   *  the promotion. `n` is the promotion seq. */
  recvPromoted(sourceMessageId: string, n: number): string {
    return `recv:promoted:${sourceMessageId}:${n}`;
  },

  /** Private trajectory copy of an edit mutation. `n` disambiguates repeated
   *  edits of the same message. */
  messageEdited(sourceMessageId: string, n: number): string {
    return `msg:${sourceMessageId}:edited:${n}`;
  },

  /** Private trajectory copy of a retract mutation. */
  messageRetracted(sourceMessageId: string, n: number): string {
    return `msg:${sourceMessageId}:retracted:${n}`;
  },

  turnOpened(turnId: string): string {
    return `turn:${turnId}:opened`;
  },

  turnClosed(turnId: string): string {
    return `turn:${turnId}:closed`;
  },

  turnWaiting(turnId: string, n: number): string {
    return `turn:${turnId}:waiting:${n}`;
  },

  messageStarted(messageId: string): string {
    return `msg:${messageId}:started`;
  },

  /** completed OR failed — exactly one wins per lineage. */
  messageTerminal(messageId: string): string {
    return `msg:${messageId}:terminal`;
  },

  invocationStart(invocationId: string): string {
    return `inv:${invocationId}:start`;
  },

  /** completed|failed|cancelled|abandoned — one wins per lineage. */
  invocationTerminal(invocationId: string): string {
    return `inv:${invocationId}:terminal`;
  },

  invocationOutput(invocationId: string, n: number): string {
    return `inv:${invocationId}:output:${n}`;
  },

  approvalRequested(approvalId: string): string {
    return `appr:${approvalId}:requested`;
  },

  approvalResolved(approvalId: string): string {
    return `appr:${approvalId}:resolved`;
  },

  systemEvent(scope: string, detailKind: string, n?: number): string {
    return n === undefined ? `sys:${scope}:${detailKind}` : `sys:${scope}:${detailKind}:${n}`;
  },

  /** A hard interruption is identified by both the turn and its semantic
   *  reason. Different lifecycle intents can race before an in-flight model
   *  call settles (for example, a user interrupt followed by channel
   *  retirement); they are distinct journal facts and must not share an id.
   *  URI encoding keeps arbitrary reason text delimiter-safe and reversible. */
  interruptEvent(turnId: string, reason: string): string {
    return `sys:${turnId}:interrupt:${encodeURIComponent(reason)}`;
  },

  compaction(turnId: string, n: number): string {
    return `sys:compaction:${turnId}:${n}`;
  },

  configChange(patchHash: string, n: number): string {
    return `sys:config:${patchHash}:${n}`;
  },

  promptArtifactsRequested(triggerEnvelopeId: string): string {
    return `sys:prompt-artifacts:${encodeURIComponent(triggerEnvelopeId)}:requested`;
  },

  promptArtifactsTerminal(triggerEnvelopeId: string): string {
    return `sys:prompt-artifacts:${encodeURIComponent(triggerEnvelopeId)}:terminal`;
  },

  // effect ids ----------------------------------------------------------------

  modelEffect(messageId: string): string {
    return `model:${messageId}`;
  },

  invocationEffect(invocationId: string): string {
    return `inv:${invocationId}`;
  },

  approvalFormEffect(approvalId: string): string {
    return `form:${approvalId}`;
  },

  credentialWaitEffect(credKey: string): string {
    return `credwait:${credKey}`;
  },

  promptArtifactsEffect(triggerEnvelopeId: string): string {
    return `prompt-artifacts:${encodeURIComponent(triggerEnvelopeId)}`;
  },
};

/** Tiny deterministic hash for config-patch ids (FNV-1a over JSON). */
export function patchHash(value: unknown): string {
  const text = JSON.stringify(value) ?? "null";
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
