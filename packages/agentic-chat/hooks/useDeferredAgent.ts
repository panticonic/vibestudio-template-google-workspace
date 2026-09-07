import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { isAgentParticipantType } from "@workspace/agentic-core";
import type {
  AgentSubscriptionConfig,
  AvailableAgent,
  ModelCatalog,
} from "@workspace/agentic-core";
import {
  isModelAgentLaunchable,
  type DefaultAgentConfig,
} from "@workspace/model-catalog/catalog";
import type { AttachmentInput, Participant } from "@workspace/pubsub";
import type { MessageTier } from "@workspace/agentic-protocol";
import type {
  ChatInputContextValue,
  ChatMessage,
  ChatParticipantMetadata,
  DeferredAgentState,
  PendingAgent,
  PendingDelivery,
} from "../types";
import type { AgentConfigDraft } from "../components/AgentConfigForm";
import { draftForAgent as seedDraftForAgent, draftToConfig } from "../components/agentConfigDraft";
import { shouldAutoSendInitialPrompt } from "./core/useChatCore";

/**
 * Deferred first-agent flow.
 *
 * On a brand-new chat the host may activate an uncommitted provisional agent
 * for the inline config while the user types. The first send (or an injected
 * initialPrompt) parks the message in a client-side queue and ARMS a claim;
 * a spawn-driver effect issues `onAddAgent` with that exact config, and when
 * the claimed agent joins the roster the queue is flushed LIVE (per item) — so
 * the first message lands as a normal turn to a present agent rather than
 * backlog replay.
 *
 * The whole flow is scoped to OUR spawn (`armed`), so reconnection / rehydration
 * windows (pending agents we did NOT spawn) keep their normal send-immediately
 * path. It is also inert on hosts that can't create agents (no `onAddAgent`).
 */

const FLUSH_RETRY_DELAY_MS = 1_500;
export const AGENT_LAUNCH_WATCHDOG_MS = 45_000;

/** Build the spawn config from the inline draft, dropping the handle: the
 *  first-agent setup never exposes a handle field, so a draft handle is only a
 *  seeded default and must not leak onto the spawned agent — the host derives a
 *  valid handle for the resolved agent type. */
function spawnConfigFromDraft(draft: AgentConfigDraft): AgentSubscriptionConfig {
  const config = draftToConfig(draft);
  delete (config as Record<string, unknown>)["handle"];
  return config;
}

interface UseDeferredAgentParams {
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  pendingAgents: Map<string, PendingAgent>;
  /** Current composer text (read at send time to capture the queued message). */
  input: string;
  /** Clear the composer (text + pending images) after queuing a message. */
  clearComposer: () => void;
  /** Publish queued text to the channel with optimistic backfill (core.publishText). */
  publishText: (
    text: string,
    opts?: {
      attachments?: AttachmentInput[];
      mentions?: string[];
      replyTo?: string;
      metadata?: Record<string, unknown>;
      tier?: MessageTier;
      idempotencyKey?: string;
    }
  ) => Promise<void>;
  /** Title the chat from the first message on the deferred-flush path. */
  maybeSetDefaultTitle: (text: string) => void;
  /** Normal send path, used once an agent is present (or when deferral is off). */
  coreSendMessage: ChatInputContextValue["onSendMessage"];
  onAddAgent?: (agentId?: string, config?: AgentSubscriptionConfig) => void | Promise<unknown>;
  /** Latest uncommitted first-agent intent. `null` asks the host to retire an
   *  existing provisional agent because this draft is not launchable. */
  onPrepareAgent?: (
    agentId: string | undefined,
    config: AgentSubscriptionConfig | null
  ) => Promise<void>;
  availableAgents: AvailableAgent[];
  modelCatalog: ModelCatalog | null;
  defaultModelRef?: string | null;
  /** Saved workspace default agent config — seeds the inline config draft. */
  defaultAgentConfig?: DefaultAgentConfig | null;
  /** Host-owned model readiness for the first agent. */
  firstAgentModelPreflight?: "checking" | "ready" | "selection-required";
  /** True only when the host minted this channel for the current mount. */
  firstAgentChannelIsNew?: boolean;
  /** Injected first message — routed through the SAME pre-send queue (held until
   *  the agent joins, then flushed live) instead of an auto-send-on-connect. */
  initialPrompt?: string;
  forceInitialPrompt?: boolean;
  /** Override the durable deduplication key for an explicitly triggered prompt. */
  initialPromptIdempotencyKey?: string;
  channelName: string;
  /** Live transcript — distinguishes a brand-new chat from a fork/reopen w/ history. */
  messages: ChatMessage[];
  /** True once the initial replay has settled, so `messages` reliably reflects
   *  prior history (NOT mere socket connect). */
  replaySettled: boolean;
}

export function useDeferredAgent(params: UseDeferredAgentParams): {
  deferredAgent: DeferredAgentState | undefined;
  sendMessage: ChatInputContextValue["onSendMessage"];
} {
  const {
    participants,
    pendingAgents,
    input,
    clearComposer,
    publishText,
    maybeSetDefaultTitle,
    coreSendMessage,
    onAddAgent,
    onPrepareAgent,
    availableAgents,
    modelCatalog,
    defaultModelRef,
    defaultAgentConfig,
    firstAgentModelPreflight = "ready",
    firstAgentChannelIsNew = false,
    initialPrompt,
    forceInitialPrompt,
    initialPromptIdempotencyKey,
    channelName,
    messages,
    replaySettled,
  } = params;

  const [queued, setQueued] = useState<PendingDelivery[]>([]);
  const [agentId, setAgentId] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<AgentConfigDraft>({ model: "" });
  // `armed`: committed to spawning OUR first agent (set synchronously on the
  // first held message so the inline setup card doesn't flash back in).
  const [armed, setArmed] = useState(false);
  const [launchFailed, setLaunchFailed] = useState(false);
  const [flushTick, setFlushTick] = useState(0);
  // Entering first-run model setup is an explicit-choice boundary. Provider
  // setup can make the selected model usable, but that availability change
  // must not dismiss the setup surface before the user starts the queued turn.
  const [explicitModelChoiceActive, setExplicitModelChoiceActive] = useState(
    firstAgentModelPreflight === "selection-required"
  );

  const draftTouchedRef = useRef(false);
  const modelTouchedRef = useRef(false);
  const agentTypeTouchedRef = useRef(false); // user explicitly picked an agent type
  // The agent type + config captured at the moment the spawn was armed, so a
  // later auto-seed (or a future editable card) can't change what the first
  // message commits to.
  const spawnIntentRef = useRef<{
    agentId: string | undefined;
    config: AgentSubscriptionConfig;
  } | null>(null);
  const issuedRef = useRef(false); // onAddAgent has been called for this spawn
  const spawnInFlightRef = useRef(false); // the onAddAgent promise is pending
  const flushingRef = useRef(false);
  const flushTimerRef = useRef(0);
  const launchWatchdogRef = useRef(0);
  const everHadAgentRef = useRef(false);
  const initialPromptEnqueuedRef = useRef(false);
  const waitingForModelDiscoveryRef = useRef(false);
  const preparedIntentFingerprintRef = useRef("none");
  const prepareAgentRef = useRef(onPrepareAgent);
  prepareAgentRef.current = onPrepareAgent;

  const agentPresent = useMemo(
    () => Object.values(participants).some((p) => isAgentParticipantType(p.metadata.type)),
    [participants]
  );
  // Latch "an agent has ever been present" so a routine agent departure
  // (idle-stop / disconnect) from an established chat never re-shows the setup
  // card over the live transcript.
  if (agentPresent) everHadAgentRef.current = true;

  const canDefer = !!onAddAgent; // host can manage agents → we can hold + spawn
  const canSpawn = canDefer && availableAgents.length > 0; // can spawn RIGHT NOW
  // An agent is "coming" once WE armed a spawn or a pending badge exists.
  const agentComing = pendingAgents.size > 0 || armed;
  const modelSelectionRequired =
    firstAgentModelPreflight === "selection-required" || explicitModelChoiceActive;
  const modelDiscoveryPending = firstAgentModelPreflight === "checking";
  // Show the inline config card only for a genuinely brand-new chat: no agent
  // present or coming, no history, and none ever seen. An injected initial
  // prompt normally drives the first message itself, except when the host says
  // model selection is required — then the setup card is the preflight that
  // deliberately holds that prompt.
  const setupActive =
    !agentPresent &&
    !agentComing &&
    canDefer &&
    (!initialPrompt || modelSelectionRequired) &&
    // Only once replay has settled is `messages.length === 0` a trustworthy
    // "brand-new chat" signal — this avoids flashing the setup card over an
    // agentless channel that still has history mid-replay.
    replaySettled &&
    messages.length === 0 &&
    !everHadAgentRef.current;
  const launching = !agentPresent && armed;
  const active = setupActive || launching;

  useEffect(() => {
    if (agentPresent || armed) {
      setExplicitModelChoiceActive(false);
    } else if (firstAgentModelPreflight === "selection-required") {
      setExplicitModelChoiceActive(true);
    }
  }, [agentPresent, armed, firstAgentModelPreflight]);

  // Pick the first agent type once the gallery loads.
  useEffect(() => {
    if (agentId !== undefined || availableAgents.length === 0) return;
    setAgentId(availableAgents[0]?.id);
  }, [agentId, availableAgents]);

  // Keep inherited defaults synchronized as the gallery/settings arrive in
  // either order. User edits remain authoritative; if the user touched another
  // field but not the model, a late effective model may still fill that field.
  useEffect(() => {
    if (availableAgents.length === 0 && !modelCatalog && !defaultAgentConfig) return;
    const agent = availableAgents.find((a) => a.id === agentId) ?? availableAgents[0];
    const seeded = seedDraftForAgent(agent, {
      modelCatalog,
      defaultModelRef,
      defaultAgentConfig,
      showReactiveness: false,
    });
    if (!seeded.model && !seeded.handle) return;
    setDraft((current) => {
      if (!draftTouchedRef.current) return seeded;
      if (!modelTouchedRef.current && seeded.model && current.model !== seeded.model) {
        return { ...current, model: seeded.model };
      }
      return current;
    });
  }, [agentId, availableAgents, modelCatalog, defaultModelRef, defaultAgentConfig]);

  const handleSetDraft = useCallback((next: AgentConfigDraft) => {
    draftTouchedRef.current = true;
    setDraft((cur) => {
      if (next.model !== cur.model) modelTouchedRef.current = true;
      return next;
    });
  }, []);

  const handleSetAgentId = useCallback(
    (id: string | undefined) => {
      agentTypeTouchedRef.current = true;
      setAgentId(id);
      const agent = availableAgents.find((a) => a.id === id);
      const seeded = seedDraftForAgent(agent, {
        modelCatalog,
        defaultModelRef,
        defaultAgentConfig,
        showReactiveness: false,
      });
      // Switching type reseeds behavior defaults but keeps a model the user chose.
      setDraft((cur) => ({ ...seeded, model: modelTouchedRef.current ? cur.model : seeded.model }));
    },
    [availableAgents, modelCatalog, defaultModelRef, defaultAgentConfig]
  );

  const cancelQueued = useCallback((id: string) => {
    setQueued((q) => q.filter((m) => m.id !== id));
  }, []);

  const retryLaunch = useCallback(() => {
    issuedRef.current = false;
    setLaunchFailed(false); // re-arms the spawn-driver effect
  }, []);

  // A host can acknowledge the spawn RPC before the worker later reports a
  // build/start error. Fold that signal into the same retriable queue state,
  // and bound the otherwise indefinite "launching" wait.
  useEffect(() => {
    if (!armed || agentPresent || launchFailed) {
      window.clearTimeout(launchWatchdogRef.current);
      return;
    }
    if (Array.from(pendingAgents.values()).some((agent) => agent.status === "error")) {
      setLaunchFailed(true);
      return;
    }
    window.clearTimeout(launchWatchdogRef.current);
    launchWatchdogRef.current = window.setTimeout(() => {
      issuedRef.current = false;
      spawnInFlightRef.current = false;
      setLaunchFailed(true);
    }, AGENT_LAUNCH_WATCHDOG_MS);
    return () => window.clearTimeout(launchWatchdogRef.current);
  }, [armed, agentPresent, launchFailed, pendingAgents]);

  // Stable refs so the wrapped send callback doesn't churn every keystroke.
  const stateRef = useRef({ agentPresent, active, armed, input, agentId, draft });
  stateRef.current = { agentPresent, active, armed, input, agentId, draft };
  // Snapshot of the transcript, read at flush time without churning effect deps.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const queuedRef = useRef(queued);
  queuedRef.current = queued;

  // Optimistically activate the current first-agent intent while the user is
  // composing. The host owns the provisional lease and does not subscribe or
  // persist it yet. Draft changes update this one intent; an unusable/absent
  // intent retires the provisional entity.
  useEffect(() => {
    if (!onPrepareAgent) return;
    const selectedAgent =
      availableAgents.find((agent) => agent.id === agentId) ?? availableAgents[0];
    const latestDraft = draftTouchedRef.current
      ? draft
      : seedDraftForAgent(selectedAgent, {
          modelCatalog,
          defaultModelRef,
          defaultAgentConfig,
          showReactiveness: false,
        });
    const selectedModel = modelCatalog?.models.find((model) => model.ref === latestDraft.model);
    const modelChoiceAllowsPrewarm =
      firstAgentModelPreflight === "ready" ||
      (firstAgentModelPreflight === "selection-required" && modelTouchedRef.current);
    const shouldPrepare =
      !agentPresent &&
      pendingAgents.size === 0 &&
      (firstAgentChannelIsNew || (replaySettled && messages.length === 0)) &&
      !everHadAgentRef.current &&
      availableAgents.length > 0 &&
      modelChoiceAllowsPrewarm &&
      isModelAgentLaunchable(selectedModel);
    const explicitAgentId = agentTypeTouchedRef.current ? agentId : undefined;
    const config = shouldPrepare ? spawnConfigFromDraft(latestDraft) : null;
    const fingerprint = config
      ? canonicalJson({ channelName, agentId: explicitAgentId, config })
      : "none";
    if (preparedIntentFingerprintRef.current === fingerprint) return;
    preparedIntentFingerprintRef.current = fingerprint;
    void onPrepareAgent(explicitAgentId, config).catch((error) => {
      console.warn("[useDeferredAgent] Failed to prepare provisional agent:", error);
    });
  }, [
    onPrepareAgent,
    agentPresent,
    pendingAgents,
    replaySettled,
    messages.length,
    availableAgents,
    agentId,
    draft,
    modelCatalog,
    defaultModelRef,
    defaultAgentConfig,
    firstAgentModelPreflight,
    firstAgentChannelIsNew,
    channelName,
  ]);

  // If this chat surface disappears before claim, release the host-owned lease.
  useEffect(
    () => () => {
      if (preparedIntentFingerprintRef.current === "none") return;
      preparedIntentFingerprintRef.current = "none";
      void prepareAgentRef.current?.(undefined, null).catch((error) => {
        console.warn("[useDeferredAgent] Failed to retire provisional agent:", error);
      });
    },
    []
  );

  const startQueued = useCallback(() => {
    const s = stateRef.current;
    if (s.agentPresent || s.armed || queuedRef.current.length === 0 || !s.draft.model) return;
    const selectedModel = modelCatalog?.models.find((model) => model.ref === s.draft.model);
    if (!isModelAgentLaunchable(selectedModel)) return;
    spawnIntentRef.current = {
      agentId: agentTypeTouchedRef.current ? s.agentId : undefined,
      config: spawnConfigFromDraft(s.draft),
    };
    setExplicitModelChoiceActive(false);
    setArmed(true);
  }, [modelCatalog]);

  const sendMessage = useCallback<ChatInputContextValue["onSendMessage"]>(
    async (attachments, options) => {
      const s = stateRef.current;
      // Agent present and no flush in progress → straight to the normal send.
      // (During an in-flight flush we queue even live sends, so a fresh message
      // can't leapfrog still-queued first messages.)
      if (s.agentPresent && !flushingRef.current) {
        return coreSendMessage(attachments, options);
      }
      // No agent and not our deferred flow (e.g. host can't create agents) →
      // normal send so the message still goes out.
      if (!s.agentPresent && !s.active) {
        return coreSendMessage(attachments, options);
      }
      const text = s.input.trim();
      const hasAttachments = !!attachments?.length;
      if (!text && !hasAttachments) return;
      const item: PendingDelivery = {
        id: crypto.randomUUID(),
        text,
        ...(hasAttachments ? { attachments } : {}),
        ...(options?.mentions && options.mentions.length > 0 ? { mentions: options.mentions } : {}),
        ...(options?.replyTo ? { replyTo: options.replyTo } : {}),
        ...(options?.metadata ? { metadata: options.metadata } : {}),
      };
      setQueued((q) => [...q, item]);
      clearComposer();
      // Commit to spawning our first agent (the driver issues onAddAgent). Only
      // when there's no agent — an in-flight-flush enqueue needs no new agent.
      // Snapshot the type + config now so this message's spawn is locked in.
      if (!s.agentPresent && !s.armed && firstAgentModelPreflight === "ready") {
        spawnIntentRef.current = {
          agentId: agentTypeTouchedRef.current ? s.agentId : undefined,
          config: spawnConfigFromDraft(s.draft),
        };
        setArmed(true);
      } else if (!s.agentPresent && firstAgentModelPreflight === "checking") {
        waitingForModelDiscoveryRef.current = true;
      }
    },
    [coreSendMessage, clearComposer, firstAgentModelPreflight]
  );

  // A first message may arrive while model settings are still loading. Arm only
  // messages specifically held by that discovery wait. A later
  // `selection-required` → `ready` transition must not silently cross the
  // explicit-choice boundary.
  useEffect(() => {
    if (firstAgentModelPreflight !== "ready" || !waitingForModelDiscoveryRef.current) return;
    waitingForModelDiscoveryRef.current = false;
    if (agentPresent || armed || queued.length === 0) return;
    setArmed(true);
  }, [firstAgentModelPreflight, agentPresent, armed, queued.length]);

  // Spawn-driver: issue onAddAgent exactly once, as soon as we're armed AND able
  // to spawn. Re-fires when canSpawn flips true (availableAgents loaded late) or
  // when a failed launch is retried — fixes the "stranded prompt / no agent"
  // races. The async rejection is handled here (onAddAgent may be async).
  useEffect(() => {
    if (agentPresent || launchFailed) return;
    if (!armed || issuedRef.current || spawnInFlightRef.current) return;
    if (queued.length === 0) return; // nothing to deliver → don't spawn
    if (pendingAgents.size > 0) return; // an agent we didn't arm is already coming
    if (!canSpawn || !onAddAgent) return; // can't spawn yet — retry when canSpawn flips
    issuedRef.current = true;
    spawnInFlightRef.current = true;
    // Spawn with the intent captured when the message armed the spawn — NOT the
    // live draft/agentId (which auto-seed or a future editable card could move).
    // A null id lets the host resolve its default (honoring a pinned agentSource).
    const current = stateRef.current;
    const selectedAgent =
      availableAgents.find((agent) => agent.id === current.agentId) ?? availableAgents[0];
    // Injected initial prompts do not pass through sendMessage(), so they have
    // no captured intent yet. Resolve their untouched draft from the latest
    // inputs here to avoid a same-render settings/gallery race, then snapshot it
    // so retries issue exactly the same launch.
    const launchDraft = draftTouchedRef.current
      ? current.draft
      : seedDraftForAgent(selectedAgent, {
          modelCatalog,
          defaultModelRef,
          defaultAgentConfig,
          showReactiveness: false,
        });
    const intent = spawnIntentRef.current ?? {
      agentId: agentTypeTouchedRef.current ? current.agentId : undefined,
      config: spawnConfigFromDraft(launchDraft),
    };
    spawnIntentRef.current = intent;
    void Promise.resolve()
      .then(() => onAddAgent(intent.agentId, intent.config))
      .then(() => {
        spawnInFlightRef.current = false;
      })
      .catch((err) => {
        console.warn("[useDeferredAgent] Failed to launch agent:", err);
        spawnInFlightRef.current = false;
        issuedRef.current = false;
        setLaunchFailed(true);
      });
  }, [
    agentPresent,
    armed,
    queued.length,
    pendingAgents,
    canSpawn,
    onAddAgent,
    launchFailed,
    availableAgents,
    modelCatalog,
    defaultModelRef,
    defaultAgentConfig,
  ]);

  // Abandon: the user cancelled every held message before the agent was even
  // issued → un-arm so the inline setup card returns and nothing spawns.
  useEffect(() => {
    if (!armed || agentPresent || issuedRef.current || spawnInFlightRef.current) return;
    if (queued.length === 0) {
      spawnIntentRef.current = null;
      setArmed(false);
    }
  }, [armed, agentPresent, queued.length]);

  // Join cleanup: once an agent is present our spawn is done — reset the flow so
  // a later (legitimate) re-defer isn't blocked by stale flags.
  useEffect(() => {
    if (!agentPresent) return;
    issuedRef.current = false;
    spawnInFlightRef.current = false;
    spawnIntentRef.current = null;
    if (armed) setArmed(false);
    if (launchFailed) setLaunchFailed(false);
  }, [agentPresent, armed, launchFailed]);

  // Flush the queue LIVE the moment an agent joins — per item, so a delivered
  // message leaves the queue immediately (no double-display with the transcript/
  // Outbox) and a partial failure neither strands delivered items nor re-sends
  // them. A failure backs off before retrying so it can't hot-loop.
  useEffect(() => {
    if (!agentPresent || queued.length === 0 || flushingRef.current) return;
    flushingRef.current = true;
    const batch = [...queued];
    // Title from the first successfully-delivered queued message — only for a
    // brand-new chat (no prior transcript), mirroring sendMessage's normal path.
    const shouldTitleFromBatch = messagesRef.current.length === 0;
    void (async () => {
      try {
        let titled = false;
        for (const item of batch) {
          // The user may remove later queued items while an earlier item is
          // flushing. Re-check before publishing so cancel still means "do not
          // send" until delivery of that specific item begins.
          if (!queuedRef.current.some((m) => m.id === item.id)) continue;
          await publishText(item.text, {
            attachments: item.attachments,
            mentions: item.mentions,
            replyTo: item.replyTo,
            metadata: item.metadata,
            tier: item.tier,
            idempotencyKey: item.idempotencyKey,
          });
          if (shouldTitleFromBatch && !titled && item.text) {
            maybeSetDefaultTitle(item.text);
            titled = true;
          }
          setQueued((q) => q.filter((m) => m.id !== item.id));
        }
        flushingRef.current = false;
      } catch (err) {
        console.warn("[useDeferredAgent] Failed to flush pre-send queue:", err);
        flushTimerRef.current = window.setTimeout(() => {
          flushingRef.current = false;
          setFlushTick((t) => t + 1);
        }, FLUSH_RETRY_DELAY_MS);
      }
    })();
  }, [agentPresent, queued, publishText, maybeSetDefaultTitle, flushTick]);

  useEffect(
    () => () => {
      window.clearTimeout(flushTimerRef.current);
      window.clearTimeout(launchWatchdogRef.current);
    },
    []
  );

  // Route an injected initialPrompt through the SAME queue only when this host
  // can spawn an agent. Otherwise useAgenticChat leaves the prompt on
  // useChatCore's historical auto-send path; this hook must not create a queue
  // that can never flush.
  useEffect(() => {
    if (!canDefer) return;
    if (initialPromptEnqueuedRef.current || !replaySettled) return;
    // An opening prompt belongs to the creation of a channel, not to the
    // lifetime of this React surface. Panel state is durable across unloads,
    // while this hook's refs are not: treating a remount as another opening
    // used to queue the prompt again and arm a second first-agent launch during
    // the roster/rehydration window. The host's channel-creation fact is the
    // authoritative one-shot boundary. `forceInitialPrompt` remains the
    // explicit path for adding a prompt to an already-existing channel (for
    // example a fork), but it waits for that channel's agent and never turns
    // the remount into a first-agent launch.
    if (!firstAgentChannelIsNew && !forceInitialPrompt) {
      initialPromptEnqueuedRef.current = true;
      return;
    }
    if (
      !shouldAutoSendInitialPrompt({
        prompt: initialPrompt,
        // Gate on replay-settled (not socket connect) so prior-history detection
        // is accurate; `shouldAutoSendInitialPrompt` only uses this as readiness.
        connected: replaySettled,
        alreadySent: false,
        hasPriorMessages: messages.length > 0,
        force: forceInitialPrompt,
      })
    ) {
      return;
    }
    initialPromptEnqueuedRef.current = true;
    setQueued((q) => [
      ...q,
      {
        id: crypto.randomUUID(),
        text: initialPrompt as string,
        tier: "secondary",
        idempotencyKey:
          initialPromptIdempotencyKey ?? `initial-prompt:${channelName}`,
      },
    ]);
    // Arm a spawn only for the mount that created the channel. A forced prompt
    // on an existing channel may queue for its rehydrating agent, but must not
    // reinterpret a transiently empty roster as a request for a new one.
    if (
      firstAgentChannelIsNew &&
      !stateRef.current.agentPresent &&
      firstAgentModelPreflight === "ready"
    ) {
      setArmed(true);
    } else if (
      firstAgentChannelIsNew &&
      !stateRef.current.agentPresent &&
      firstAgentModelPreflight === "checking"
    ) {
      waitingForModelDiscoveryRef.current = true;
    }
  }, [
    canDefer,
    replaySettled,
    messages,
    initialPrompt,
    forceInitialPrompt,
    initialPromptIdempotencyKey,
    channelName,
    firstAgentModelPreflight,
    firstAgentChannelIsNew,
  ]);

  const deferredAgent = useMemo<DeferredAgentState | undefined>(() => {
    if (!active && queued.length === 0) return undefined;
    return {
      active,
      setupActive,
      launching,
      launchFailed,
      modelSelectionRequired,
      modelDiscoveryPending,
      startQueued,
      retryLaunch,
      draft,
      setDraft: handleSetDraft,
      agentId,
      setAgentId: handleSetAgentId,
      availableAgents,
      queued,
      cancelQueued,
    };
  }, [
    active,
    setupActive,
    launching,
    launchFailed,
    modelSelectionRequired,
    modelDiscoveryPending,
    startQueued,
    retryLaunch,
    draft,
    handleSetDraft,
    agentId,
    handleSetAgentId,
    availableAgents,
    queued,
    cancelQueued,
  ]);

  return { deferredAgent, sendMessage };
}
