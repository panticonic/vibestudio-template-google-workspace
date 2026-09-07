import { Badge, Flex } from "@radix-ui/themes";
import { ArrowDownIcon } from "@radix-ui/react-icons";

interface NewContentIndicatorProps {
  onClick: () => void;
}

export function NewContentIndicator({ onClick }: NewContentIndicatorProps) {
  return (
    <Flex
      justify="center"
      className="new-content-indicator"
      style={{
        position: "absolute",
        bottom: 8,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 10,
      }}
    >
      <Badge
        color="blue"
        size="2"
        style={{ cursor: "pointer", padding: "4px 12px" }}
        onClick={onClick}
        tabIndex={0}
      >
        <Flex align="center" gap="1">
          <ArrowDownIcon />
          New messages
        </Flex>
      </Badge>
    </Flex>
  );
}
