import { Suspense, lazy } from "react";
import { Flex, Spinner, Text } from "@radix-ui/themes";
import { useChatContext } from "../context/ChatContext";

const ChatFeedbackArea = lazy(() =>
  import("./ChatFeedbackArea").then((module) => ({ default: module.ChatFeedbackArea }))
);

export function LazyChatFeedbackArea() {
  const { activeFeedbacks } = useChatContext();
  if (activeFeedbacks.size === 0) return null;

  return (
    <Suspense
      fallback={
        <Flex align="center" gap="2" px="2">
          <Spinner size="1" />
          <Text size="1" color="gray">
            Loading response form…
          </Text>
        </Flex>
      }
    >
      <ChatFeedbackArea />
    </Suspense>
  );
}
