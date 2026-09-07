import { Flex, Spinner, Text } from "@radix-ui/themes";

export type ChatStartupPhase = "conversation" | "models" | "agent" | "review";

const PHASES = ["Conversation", "Model", "Agent"] as const;

const COPY: Record<
  ChatStartupPhase,
  { title: string; detail: string; activeStep: number | null }
> = {
  conversation: {
    title: "Loading your conversation",
    detail: "Joining the workspace and restoring messages",
    activeStep: 0,
  },
  models: {
    title: "Preparing model choices",
    detail: "Checking the models available for this workspace",
    activeStep: 1,
  },
  agent: {
    title: "Preparing your agent",
    detail: "Connecting the agent to this conversation",
    activeStep: 2,
  },
  review: {
    title: "Waiting for workspace review",
    detail: "Approve the workspace setup to continue",
    activeStep: null,
  },
};

export function ChatStartupStatus({
  phase,
  detail,
}: {
  phase: ChatStartupPhase;
  detail?: string;
}) {
  const copy = COPY[phase];
  const activeStep = copy.activeStep;
  return (
    <Flex
      role="status"
      aria-live="polite"
      align="center"
      justify="center"
      className="chat-startup-status-root"
    >
      <Flex
        direction="column"
        align="center"
        className="chat-startup-status-card"
      >
        <Flex
          align="center"
          justify="center"
          className="chat-startup-status-glyph"
        >
          <Spinner size="2" />
        </Flex>
        <Text size="3" weight="medium" className="chat-startup-status-title">
          {copy.title}
        </Text>
        <Text
          color="gray"
          size="2"
          align="center"
          className="chat-startup-status-detail"
        >
          {detail ?? copy.detail}
        </Text>
        {activeStep !== null ? (
          <Flex
            align="center"
            justify="center"
            gap="2"
            className="chat-startup-status-steps"
            aria-hidden="true"
          >
            {PHASES.map((label, index) => (
              <Flex
                key={label}
                align="center"
                gap="1"
                className="chat-startup-status-step"
              >
                <span
                  className={`chat-startup-status-dot${
                    index < activeStep
                      ? " is-complete"
                      : index === activeStep
                        ? " is-active"
                        : ""
                  }`}
                />
                <Text
                  size="1"
                  color={index === activeStep ? undefined : "gray"}
                >
                  {label}
                </Text>
              </Flex>
            ))}
          </Flex>
        ) : null}
      </Flex>
    </Flex>
  );
}
