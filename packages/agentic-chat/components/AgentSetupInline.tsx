import { useState } from "react";
import { Box, Button, Callout, Card, Flex, Heading, Text } from "@radix-ui/themes";
import { ArrowDownIcon, ExclamationTriangleIcon, LightningBoltIcon } from "@radix-ui/react-icons";
import {
  isModelAgentLaunchable,
  LOCAL_FALLBACK_MODEL_REF,
} from "@workspace/model-catalog/catalog";
import { useChatContext } from "../context/ChatContext";
import { AgentConfigForm } from "./AgentConfigForm";
import { ModelSetupStatus } from "./ModelSetupStatus";

/**
 * Inline first-agent setup — replaces the "Add agent" button on a fresh chat.
 * The agent isn't created yet: these options are *armed* and applied to the
 * agent that's spawned for the first message. When the host has no configured
 * model, this same surface becomes the explicit provider/local-model preflight
 * and keeps the queued message inert until the user confirms a choice.
 */
export function AgentSetupInline() {
  const {
    deferredAgent,
    modelCatalog,
    defaultAgentConfig,
    onSaveDefaults,
    onInstallLocalModel,
    onOpenLocalModels,
    onOpenLocalModelsLog,
  } = useChatContext();
  const [setupPending, setSetupPending] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  if (!deferredAgent) return null;
  const { draft, setDraft, modelSelectionRequired, startQueued, queued } = deferredAgent;
  const selectedModel = modelCatalog?.models.find((model) => model.ref === draft.model) ?? null;
  const selectedProvider =
    modelCatalog?.providers.find((provider) => provider.id === selectedModel?.provider)?.label ??
    selectedModel?.provider ??
    "";
  const needsInstall =
    selectedModel?.provider === "local" &&
    selectedModel.availability.state === "needs-setup" &&
    selectedModel.availability.detail === "not-installed" &&
    !!onInstallLocalModel;
  const canStart = isModelAgentLaunchable(selectedModel);
  const hasInjectedPrompt = queued.some((message) => message.tier === "secondary");
  const showStart = modelSelectionRequired && queued.length > 0;

  const installSelectedLocalModel = async () => {
    if (!selectedModel || selectedModel.provider !== "local" || !onInstallLocalModel) return;
    setSetupPending(true);
    setSetupError(null);
    try {
      const result = await onInstallLocalModel(selectedModel.ref);
      if (!result.ok) setSetupError(result.error ?? `Couldn't install ${selectedModel.name}.`);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error));
    } finally {
      setSetupPending(false);
    }
  };

  return (
    <Box
      className="agent-setup-scroll"
      style={{
        height: "100%",
        width: "100%",
        padding: "var(--space-3)",
        boxSizing: "border-box",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        // Hug the composer; `safe` falls back to top-aligned (scrollable) on
        // short viewports instead of clipping the card.
        justifyContent: "safe flex-end",
      }}
    >
      <Flex direction="column" gap="2" align="center" style={{ width: "min(540px, 100%)" }}>
        <Card
          className="chat-surface-card agent-setup-card"
          size="3"
          variant="surface"
          style={{ width: "100%" }}
        >
          <Flex direction="column" gap="4">
            <Flex align="start" gap="3">
              <Box className="agent-setup-heading-icon">
                <LightningBoltIcon width="17" height="17" />
              </Box>
              <Flex direction="column" gap="1">
                <Heading size="4">
                  {modelSelectionRequired ? "Choose how to run your agent" : "Agent settings"}
                </Heading>
                <Text size="2" color="gray">
                  {modelSelectionRequired
                    ? hasInjectedPrompt
                      ? "Your opening prompt is queued. Choose a model and finish setup before onboarding begins."
                      : "Your message is queued. Choose a model and finish setup before your agent begins."
                    : "Choose the model and autonomy for your first agent."}
                </Text>
              </Flex>
            </Flex>
            {setupError ? (
              <Callout.Root color="red" size="1">
                <Callout.Icon>
                  <ExclamationTriangleIcon />
                </Callout.Icon>
                <Callout.Text>{setupError}</Callout.Text>
              </Callout.Root>
            ) : null}
            <AgentConfigForm
              catalog={modelCatalog ?? null}
              value={draft}
              onChange={(next) => {
                setSetupError(null);
                setDraft(next);
              }}
              modelEditable
              defaultAgentConfig={defaultAgentConfig}
              onSaveAsDefault={onSaveDefaults}
              showReactiveness={false}
              showHandle={false}
              onOpenServerLog={onOpenLocalModelsLog}
            />
            {modelSelectionRequired && selectedModel ? (
              <ModelSetupStatus
                model={selectedModel}
                providerLabel={selectedProvider}
                pending={setupPending}
                onSetup={
                  selectedModel.provider === "local" && onInstallLocalModel
                    ? () => void installSelectedLocalModel()
                    : undefined
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
            ) : null}
            {showStart && canStart && (
              <Button size="2" onClick={startQueued} style={{ width: "100%" }}>
                {selectedModel?.provider === "local" ? "Start with local model" : "Start agent"}
              </Button>
            )}
            {showStart && selectedModel && !canStart && !needsInstall && (
              <Text size="1" color={selectedModel.availability.state === "error" ? "red" : "gray"}>
                {selectedModel.availability.state === "downloading"
                  ? "Start unlocks automatically when the download and installation finish."
                  : selectedModel.availability.state === "starting"
                    ? "Start unlocks when the model reports ready."
                    : selectedModel.availability.state === "needs-setup"
                      ? `Complete ${selectedProvider} setup above, or choose another model.`
                      : "Resolve the model error above, or choose another model."}
              </Text>
            )}
          </Flex>
        </Card>
        {!modelSelectionRequired && (
          <Flex align="center" gap="1">
            <Text size="2" color="gray">
              Nothing to configure — just type a message below to start
            </Text>
            <ArrowDownIcon width="14" height="14" style={{ color: "var(--gray-10)" }} />
          </Flex>
        )}
      </Flex>
    </Box>
  );
}
