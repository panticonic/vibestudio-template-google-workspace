import {
  Badge,
  Box,
  Button,
  Card,
  Flex,
  IconButton,
  Spinner,
  Text,
} from "@radix-ui/themes";
import {
  Cross2Icon,
  ExclamationTriangleIcon,
  ImageIcon,
  LightningBoltIcon,
  ReloadIcon,
} from "@radix-ui/react-icons";
import { isModelAgentLaunchable } from "@workspace/model-catalog/catalog";
import { useChatContext } from "../context/ChatContext";

/**
 * Pre-send delivery queue — the messages the user sent before any agent existed.
 * They are held client-side (unsent) and flush LIVE once the spawned agent joins
 * the roster. A spinner + plain-language line explain the wait ("Launching
 * agent…"); if the launch fails, an error + Retry replaces the spinner. Each
 * item can be removed before it is delivered. Sits just above the composer, in
 * the slot the post-join Outbox uses (the two are never both non-empty).
 */
export function PendingDeliveryQueue() {
  const { deferredAgent, modelCatalog } = useChatContext();
  if (!deferredAgent || deferredAgent.queued.length === 0) return null;
  const {
    queued,
    launching,
    launchFailed,
    modelSelectionRequired,
    modelDiscoveryPending,
    retryLaunch,
    cancelQueued,
    draft,
  } = deferredAgent;
  const awaitingModelChoice =
    modelSelectionRequired && !launching && !launchFailed;
  const selectedModel = modelCatalog?.models.find(
    (model) => model.ref === draft.model,
  );
  const setupMessage =
    selectedModel?.availability.state === "downloading"
      ? `Installing ${selectedModel.name} — this sends when setup finishes.`
      : selectedModel?.availability.state === "starting"
        ? `Preparing ${selectedModel.name} — this sends when it is ready.`
        : selectedModel?.availability.state === "needs-setup" &&
            selectedModel.provider === "local"
          ? "Finish local model installation above — this stays queued."
          : isModelAgentLaunchable(selectedModel)
            ? `${selectedModel?.name ?? "Your model"} is ready — start your agent above.`
            : "Choose a model above — this sends when your agent starts.";

  return (
    <Box
      flexShrink="0"
      className="pending-delivery-root"
      data-testid="pending-delivery-queue"
    >
      <Card
        className={`chat-surface-card pending-delivery-card${launchFailed ? " pending-delivery-card-failed" : ""}`}
        size="1"
        variant="surface"
      >
        <Flex
          align="center"
          justify="between"
          gap="2"
          className="pending-delivery-header"
        >
          <Flex
            align="center"
            gap="2"
            style={{ minWidth: 0 }}
            role="status"
            aria-live="polite"
          >
            {launchFailed ? (
              <>
                <ExclamationTriangleIcon
                  style={{ color: "var(--red-9)", flexShrink: 0 }}
                />
                <Text size="1" color="red" weight="medium" truncate>
                  Couldn't start your agent — these send once it's running.
                </Text>
              </>
            ) : modelDiscoveryPending ? (
              <>
                <Spinner size="1" />
                <Text size="1" color="gray" weight="medium" truncate>
                  Preparing model settings — your message will stay queued.
                </Text>
              </>
            ) : awaitingModelChoice ? (
              <>
                <LightningBoltIcon
                  style={{ color: "var(--accent-9)", flexShrink: 0 }}
                />
                <Text size="1" color="gray" weight="medium" truncate>
                  {setupMessage}
                </Text>
              </>
            ) : (
              <>
                <Spinner size="1" />
                <Text size="1" color="gray" weight="medium" truncate>
                  {launching
                    ? "Your first message will send when the agent is ready"
                    : "Your first message is waiting for an agent"}
                </Text>
              </>
            )}
          </Flex>
          {launchFailed && (
            <Button
              size="1"
              variant="soft"
              color="red"
              className="app-touch-target"
              onClick={retryLaunch}
            >
              <ReloadIcon />
              Retry
            </Button>
          )}
        </Flex>
        <Flex
          direction="column"
          gap="1"
          mt="2"
          role="list"
          aria-label="Messages waiting for your agent"
          className="pending-delivery-list"
        >
          {queued.map((m) => {
            const attachmentCount = m.attachments?.length ?? 0;
            return (
              <Flex
                key={m.id}
                role="listitem"
                align="center"
                justify="between"
                gap="2"
                className="pending-delivery-item"
              >
                <Flex align="center" gap="2" style={{ minWidth: 0 }}>
                  {m.tier === "secondary" && (
                    <Badge
                      size="1"
                      variant="soft"
                      color="gray"
                      style={{ flexShrink: 0 }}
                    >
                      First message
                    </Badge>
                  )}
                  {attachmentCount > 0 && (
                    <ImageIcon
                      style={{ flexShrink: 0, color: "var(--gray-9)" }}
                    />
                  )}
                  <Text size="2" truncate className="pending-delivery-text">
                    {m.text ||
                      (attachmentCount > 0
                        ? `${attachmentCount} image${attachmentCount > 1 ? "s" : ""}`
                        : "")}
                  </Text>
                </Flex>
                <IconButton
                  size="1"
                  variant="ghost"
                  color="gray"
                  className="app-touch-target"
                  aria-label="Remove queued message"
                  title="Remove before it sends"
                  onClick={() => cancelQueued(m.id)}
                >
                  <Cross2Icon />
                </IconButton>
              </Flex>
            );
          })}
        </Flex>
      </Card>
    </Box>
  );
}
