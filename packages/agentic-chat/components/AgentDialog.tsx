import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, Callout, Dialog, Flex, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { isAgentParticipantType } from "@workspace/agentic-core";
import { useChatContext } from "../context/ChatContext";
import { AgentConfigForm, type AgentConfigDraft } from "./AgentConfigForm";
import { draftForAgent as seedDraftForAgent, draftToConfig } from "./agentConfigDraft";
import { AgentTypeCard } from "./AgentTypeCard";
import { ModelSetupStatus } from "./ModelSetupStatus";
import {
  isModelAgentLaunchable,
  isModelUsable,
  LOCAL_FALLBACK_MODEL_REF,
} from "@workspace/model-catalog/catalog";

export interface AgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, edit this participant's live settings (model read-only). */
  editParticipantId?: string;
}

type Mode = "add" | "switch" | "edit";

function sameDraft(a: AgentConfigDraft, b: AgentConfigDraft): boolean {
  return (
    a.model === b.model &&
    a.thinkingLevel === b.thinkingLevel &&
    a.fastMode === b.fastMode &&
    a.approvalLevel === b.approvalLevel &&
    a.respondPolicy === b.respondPolicy &&
    a.handle === b.handle &&
    a.systemPrompt === b.systemPrompt &&
    (a.respondFrom ?? []).join("\0") === (b.respondFrom ?? []).join("\0")
  );
}

export function AgentDialog({ open, onOpenChange, editParticipantId }: AgentDialogProps) {
  const ctx = useChatContext();
  const {
    messages,
    participants,
    availableAgents = [],
    modelCatalog = null,
    defaultModelRef,
    defaultAgentConfig,
    onSaveDefaults,
    onAddAgent,
    onReplaceAgent,
    onInstallLocalModel,
    onCallMethodResult,
    onOpenLocalModels,
    onOpenLocalModelsLog,
    toolApproval,
  } = ctx;

  const agentParticipants = useMemo(
    () => Object.values(participants).filter((p) => isAgentParticipantType(p.metadata.type)),
    [participants]
  );

  const isSwitch = !editParticipantId && messages.length === 0 && agentParticipants.length === 1;
  const mode: Mode = editParticipantId ? "edit" : isSwitch ? "switch" : "add";
  const targetParticipantId =
    editParticipantId ?? (isSwitch ? agentParticipants[0]?.id : undefined);
  const targetParticipant = targetParticipantId ? participants[targetParticipantId] : undefined;

  // Reactiveness matters only when the channel will hold more than one agent.
  const showReactiveness =
    mode === "add"
      ? agentParticipants.length >= 1
      : mode === "edit" && agentParticipants.length > 1;
  const showHandle = mode === "add" && showReactiveness;

  const otherParticipants = useMemo(
    () =>
      Object.values(participants)
        .filter((p) => p.id !== targetParticipantId)
        .map((p) => ({
          id: p.id,
          label: (p.metadata.handle as string) || (p.metadata.name as string) || p.id,
        })),
    [participants, targetParticipantId]
  );

  const showGallery = mode !== "edit" && availableAgents.length > 1;
  const [agentId, setAgentId] = useState<string | undefined>(availableAgents[0]?.id);
  const [step, setStep] = useState<"type" | "config">(showGallery ? "type" : "config");
  const [draft, setDraft] = useState<AgentConfigDraft>({ model: "" });
  const [draftTouched, setDraftTouched] = useState(false);
  const [modelTouched, setModelTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draftForAgent = useCallback(
    (agent = availableAgents[0]): AgentConfigDraft =>
      seedDraftForAgent(agent, {
        modelCatalog,
        defaultModelRef,
        defaultAgentConfig,
        showReactiveness,
      }),
    [availableAgents, defaultModelRef, defaultAgentConfig, modelCatalog, showReactiveness]
  );

  // Initialize when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setStep(showGallery ? "type" : "config");
    setAgentId(availableAgents[0]?.id);
    setDraftTouched(false);
    setModelTouched(false);

    if (mode === "add") {
      setDraft(draftForAgent());
      return;
    }

    // switch/edit: prefill from the target agent's current settings.
    let cancelled = false;
    setDraft({ model: "", handle: targetParticipant?.metadata.handle as string | undefined });
    void (async () => {
      if (!targetParticipantId) return;
      try {
        const settings = (await onCallMethodResult(
          targetParticipantId,
          "getAgentSettings",
          {}
        )) as {
          model?: { value: string };
          thinkingLevel?: { value: string };
          fastMode?: { value: boolean };
          approvalLevel?: { value: number };
          respondPolicy?: { value: string };
          respondFrom?: { value: string[] };
        } | null;
        if (cancelled || !settings) return;
        setDraft({
          model: settings.model?.value ?? "",
          thinkingLevel: settings.thinkingLevel?.value as AgentConfigDraft["thinkingLevel"],
          fastMode: settings.fastMode?.value ?? false,
          approvalLevel: (toolApproval?.settings.globalFloor ??
            settings.approvalLevel?.value) as AgentConfigDraft["approvalLevel"],
          respondPolicy: settings.respondPolicy?.value as AgentConfigDraft["respondPolicy"],
          respondFrom: settings.respondFrom?.value,
          handle: targetParticipant?.metadata.handle as string | undefined,
        });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || mode !== "add" || draftTouched) return;
    const agent = availableAgents.find((a) => a.id === agentId) ?? availableAgents[0];
    const seeded = draftForAgent(agent);
    if (!seeded.model && !seeded.handle) return;
    setDraft((current) => {
      const next = {
        ...seeded,
        model: modelTouched ? current.model : seeded.model,
      };
      return sameDraft(current, next) ? current : next;
    });
  }, [open, mode, draftTouched, modelTouched, agentId, availableAgents, draftForAgent]);

  const selectedModel = useMemo(
    () => modelCatalog?.models.find((m) => m.ref === draft.model) ?? null,
    [modelCatalog, draft.model]
  );
  // Local runtimes must be installed before launch. Connectable remote models
  // may launch without a credential; the agent parks before provider use and
  // owns the connection request.
  const modelUsable = isModelUsable(selectedModel);
  const modelLaunchable = isModelAgentLaunchable(selectedModel);
  const selectedProviderLabel =
    modelCatalog?.providers.find((provider) => provider.id === selectedModel?.provider)?.label ??
    selectedModel?.provider ??
    "";

  const verb = mode === "switch" ? "Switch" : mode === "edit" ? "Save" : "Add";
  const title =
    mode === "switch" ? "Switch agent" : mode === "edit" ? "Agent settings" : "Add agent";

  const finish = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const config = draftToConfig(draft);
      // Tool permission is channel-wide. Persist it before starting/restarting
      // an agent so the header and every agent enforce the same authoritative
      // value from the first turn.
      if (toolApproval) await toolApproval.onSetFloor(draft.approvalLevel ?? 2);
      if (mode === "add") {
        if (!onAddAgent) throw new Error("Adding agents is not available in this host.");
        onAddAgent(agentId, config);
      } else if (mode === "switch" && targetParticipantId) {
        if (!onReplaceAgent) throw new Error("Agent switching is not available in this host.");
        // Reuse the existing handle for a stable identity.
        config["handle"] = (targetParticipant?.metadata.handle as string) ?? config["handle"];
        await onReplaceAgent(targetParticipantId, agentId, config);
      } else if (mode === "edit" && targetParticipantId) {
        // Apply live settings (model is handled by "Restart with this model").
        if (draft.thinkingLevel) {
          await onCallMethodResult(targetParticipantId, "setThinkingLevel", {
            level: draft.thinkingLevel,
          });
        }
        await onCallMethodResult(targetParticipantId, "setFastMode", {
          enabled: draft.fastMode ?? false,
        });
        if (draft.respondPolicy) {
          await onCallMethodResult(targetParticipantId, "setRespondPolicy", {
            policy: draft.respondPolicy,
            from: draft.respondFrom,
          });
        }
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [
    draft,
    mode,
    agentId,
    targetParticipantId,
    targetParticipant,
    onAddAgent,
    onReplaceAgent,
    onCallMethodResult,
    toolApproval,
    onOpenChange,
  ]);

  const restartWithModel = useCallback(async () => {
    if (!targetParticipantId) return;
    if (!onReplaceAgent) {
      setError("Agent switching is not available in this host.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const config = draftToConfig(draft);
      config["handle"] = (targetParticipant?.metadata.handle as string) ?? config["handle"];
      await onReplaceAgent(targetParticipantId, undefined, config);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [targetParticipantId, draft, targetParticipant, onReplaceAgent, onOpenChange]);

  const setupModel = useCallback(
    async () => {
      if (!selectedModel) return;
      setBusy(true);
      setError(null);
      try {
        const result = await onInstallLocalModel?.(selectedModel.ref);
        if (!result?.ok) {
          setError(result?.error ?? "Local model installation is not available.");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [selectedModel, onInstallLocalModel]
  );

  const canSubmit = !!draft.model && !busy && (mode === "edit" || modelLaunchable);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        style={{ width: "min(460px, calc(100vw - 24px))", maxHeight: "min(85dvh, 680px)" }}
      >
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="3">
          {mode === "switch"
            ? "Replace the current agent before the conversation starts."
            : mode === "edit"
              ? "Tune this agent's behavior. Model changes require a restart."
              : "Add another agent to this conversation."}
        </Dialog.Description>

        {error && (
          <Callout.Root color="red" mb="3" size="1">
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}

        {step === "type" ? (
          <Flex direction="column" gap="2">
            {availableAgents.map((a) => (
              <AgentTypeCard
                key={`${a.id}:${a.className}`}
                agent={a}
                selected={a.id === agentId}
                onSelect={() => {
                  setAgentId(a.id);
                  const next = draftForAgent(a);
                  setDraft((current) => ({
                    ...next,
                    model: modelTouched ? current.model : next.model,
                  }));
                }}
              />
            ))}
            <Flex gap="3" mt="3" justify="end">
              <Dialog.Close>
                <Button variant="soft" color="gray">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button onClick={() => setStep("config")} disabled={!agentId}>
                Continue
              </Button>
            </Flex>
          </Flex>
        ) : (
          <Box>
            <AgentConfigForm
              catalog={modelCatalog}
              value={draft}
              onChange={(next) => {
                setDraftTouched(true);
                if (next.model !== draft.model) setModelTouched(true);
                setDraft(next);
              }}
              modelEditable={mode !== "edit"}
              defaultAgentConfig={defaultAgentConfig}
              onSaveAsDefault={onSaveDefaults}
              showReactiveness={showReactiveness}
              showHandle={showHandle}
              participants={otherParticipants}
              onOpenServerLog={onOpenLocalModelsLog}
            />

            {mode !== "edit" && selectedModel ? (
              <Box mt="3">
                <ModelSetupStatus
                  model={selectedModel}
                  providerLabel={selectedProviderLabel}
                  pending={busy}
                  onSetup={
                    selectedModel.provider === "local" ? () => void setupModel() : undefined
                  }
                  onOpenLocalModels={onOpenLocalModels}
                  onOpenLocalModelLog={
                    onOpenLocalModelsLog && selectedModel.provider === "local"
                      ? () =>
                          onOpenLocalModelsLog(
                            selectedModel.ref === LOCAL_FALLBACK_MODEL_REF ? "utility" : "main"
                          )
                      : undefined
                  }
                />
              </Box>
            ) : null}

            {mode === "edit" && (
              <Box mt="3">
                <Button
                  variant="soft"
                  color="orange"
                  size="1"
                  onClick={restartWithModel}
                  disabled={busy || !draft.model || !modelUsable}
                >
                  Restart with this model
                </Button>
              </Box>
            )}

            <Flex gap="3" mt="4" justify="between" align="center">
              {showGallery ? (
                <Button
                  variant="ghost"
                  color="gray"
                  onClick={() => setStep("type")}
                  disabled={busy}
                >
                  Back
                </Button>
              ) : (
                <span />
              )}
              <Flex gap="3">
                <Dialog.Close>
                  <Button variant="soft" color="gray" disabled={busy}>
                    Cancel
                  </Button>
                </Dialog.Close>
                <Button onClick={finish} disabled={!canSubmit} loading={busy}>
                  {mode === "edit" ? "Save" : verb}
                </Button>
              </Flex>
            </Flex>
            {!modelLaunchable && mode !== "edit" ? (
              <Text size="1" color="gray" as="p" mt="2">
                Finish model setup above before {verb.toLowerCase()}ing this agent.
              </Text>
            ) : null}
          </Box>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}
