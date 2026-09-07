import { Suspense, lazy } from "react";
import { Flex, Spinner, Text } from "@radix-ui/themes";
import { useChatContext } from "../context/ChatContext";

const ChatActionBar = lazy(() =>
  import("./ChatActionBar").then((module) => ({ default: module.ChatActionBar }))
);

export function LazyChatActionBar() {
  const { actionBar } = useChatContext();
  if (!actionBar) return null;

  return (
    <Suspense
      fallback={
        <Flex align="center" gap="2" px="2">
          <Spinner size="1" />
          <Text size="1" color="gray">
            Loading action bar…
          </Text>
        </Flex>
      }
    >
      <ChatActionBar />
    </Suspense>
  );
}
