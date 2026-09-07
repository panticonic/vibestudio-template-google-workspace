import { Badge, Flex, Tooltip } from "@radix-ui/themes";
import type { PubSubClient } from "@workspace/pubsub";
import type { ChatParticipantMetadata } from "../types";
import { useChannelSignals } from "../hooks/useChannelSignals";

export interface SignalPillsProps {
  client: PubSubClient<ChatParticipantMetadata> | null;
}

function formatSignalType(contentType: string | undefined): string {
  if (!contentType) return "signal";
  if (contentType.startsWith("notify:")) return contentType.slice("notify:".length);
  if (contentType.startsWith("vibestudio-ext-")) return contentType.slice("vibestudio-ext-".length);
  return contentType;
}

function formatSignalContent(content: string): string {
  const trimmed = content.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 72) return trimmed;
  return `${trimmed.slice(0, 69)}...`;
}

export function SignalPills({ client }: SignalPillsProps) {
  const signals = useChannelSignals(client, { maxSignals: 4, ttlMs: 7000 });

  if (signals.length === 0) return null;

  return (
    <Flex
      align="center"
      gap="1"
      wrap="wrap"
      px="3"
      pt="1"
      style={{ minHeight: 24, flexShrink: 0 }}
    >
      {signals.map((signal) => {
        const typeLabel = formatSignalType(signal.contentType);
        const contentLabel = formatSignalContent(signal.content);
        const label = contentLabel ? `${typeLabel}: ${contentLabel}` : typeLabel;

        return (
          <Tooltip key={signal.id} content={label}>
            <Badge
              color="gray"
              variant="soft"
              radius="full"
              size="1"
              style={{
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {label}
            </Badge>
          </Tooltip>
        );
      })}
    </Flex>
  );
}
