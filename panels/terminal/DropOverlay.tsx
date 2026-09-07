import { Flex, Text } from "@radix-ui/themes";
import { FileIcon } from "@radix-ui/react-icons";

export function DropOverlay(props: { visible: boolean; target: string }) {
  if (!props.visible) return null;
  return (
    <Flex
      align="center"
      justify="center"
      direction="column"
      gap="2"
      style={{
        position: "absolute",
        inset: "var(--space-2)",
        border: "2px dashed var(--accent-8)",
        borderRadius: "var(--radius-3)",
        background: "color-mix(in srgb, var(--accent-3) 80%, transparent)",
        zIndex: 2,
        pointerEvents: "none",
      }}
    >
      <FileIcon width="32" height="32" color="var(--accent-11)" />
      <Text size="3" weight="medium">Drop to paste path</Text>
      <Text size="2" color="gray" truncate style={{ maxWidth: "80%" }}>Saved to {props.target}</Text>
    </Flex>
  );
}
