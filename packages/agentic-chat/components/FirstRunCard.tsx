import { Badge, Box, Card, Flex, Heading, Text } from "@radix-ui/themes";
import { CheckCircledIcon, HomeIcon, LockClosedIcon } from "@radix-ui/react-icons";

/**
 * First-run narrative card (design §9, item 9). Shown as the empty-transcript
 * state of a brand-new, model-ready chat. Model discovery and explicit setup
 * have their own surfaces, so this card must never imply setup is still needed.
 * It disappears the
 * moment the first message lands, so it never competes with real content.
 */
export function FirstRunCard() {
  return (
    <Flex align="center" justify="center" style={{ height: "100%", padding: 24 }}>
      <Card size="3" style={{ maxWidth: 460, width: "100%" }}>
        <Flex direction="column" gap="3">
          <Flex align="center" gap="2">
            <HomeIcon width="18" height="18" />
            <Heading size="4">Chat runs on your terms</Heading>
          </Flex>
          <Text size="2" color="gray">
            Your workspace is ready. Send a message and Vibestudio will start its configured agent
            for this conversation.
          </Text>
          <Box>
            <Flex direction="column" gap="2">
              <Feature
                icon={<CheckCircledIcon width="14" height="14" />}
                color="green"
                title="Ready when you are"
                body="Your first message starts the agent automatically. There is no separate setup or launch step."
              />
              <Feature
                icon={<LockClosedIcon width="14" height="14" />}
                color="blue"
                title="Your credentials stay protected"
                body="Provider credentials stay in Vibestudio's credential store. You can switch models from the model picker at any time."
              />
            </Flex>
          </Box>
        </Flex>
      </Card>
    </Flex>
  );
}

function Feature({
  icon,
  color,
  title,
  body,
}: {
  icon: React.ReactNode;
  color: "green" | "blue";
  title: string;
  body: string;
}) {
  return (
    <Flex gap="3" align="start">
      <Badge color={color} variant="soft" size="1" style={{ marginTop: 2, flexShrink: 0 }}>
        {icon}
      </Badge>
      <Box style={{ minWidth: 0 }}>
        <Text size="2" weight="medium" as="p">
          {title}
        </Text>
        <Text size="1" color="gray" as="p">
          {body}
        </Text>
      </Box>
    </Flex>
  );
}
