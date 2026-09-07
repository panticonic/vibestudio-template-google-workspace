/**
 * Tool Permissions Dropdown
 *
 * Header dropdown for configuring the channel-global tool approval level.
 */

import { Button, DropdownMenu, Flex, Text } from "@radix-ui/themes";
import { LockClosedIcon } from "@radix-ui/react-icons";
import { APPROVAL_LEVELS, type ToolApprovalSettings, type ApprovalLevel } from "@workspace/tool-ui";

interface ToolPermissionsDropdownProps {
  settings: ToolApprovalSettings;
  onSetFloor: (level: ApprovalLevel) => Promise<void>;
  variant?: "button" | "submenu";
}

export function ToolPermissionsDropdown({
  settings,
  onSetFloor,
  variant = "button",
}: ToolPermissionsDropdownProps) {
  // Determine icon color based on floor level
  const iconColor =
    settings.globalFloor === 2 ? "orange" : settings.globalFloor === 1 ? "green" : "blue";

  const content = (
    <>
      <DropdownMenu.Label>Tool Permission Level</DropdownMenu.Label>
      {([0, 1, 2] as const).map((level) => (
        <DropdownMenu.CheckboxItem
          key={level}
          checked={settings.globalFloor === level}
          onCheckedChange={() => {
            void onSetFloor(level).catch((error: unknown) => {
              console.error("[ToolPermissionsDropdown] Failed to update permission level:", error);
            });
          }}
        >
          <Flex direction="column" gap="1">
            <Text size="2" weight={settings.globalFloor === level ? "bold" : "regular"}>
              {APPROVAL_LEVELS[level].label}
            </Text>
            <Text size="1" color="gray">
              {APPROVAL_LEVELS[level].shortDesc}
            </Text>
          </Flex>
        </DropdownMenu.CheckboxItem>
      ))}
    </>
  );

  if (variant === "submenu") {
    return (
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger>
          Autonomy: {APPROVAL_LEVELS[settings.globalFloor as keyof typeof APPROVAL_LEVELS]?.label}
        </DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent style={{ minWidth: 220 }}>{content}</DropdownMenu.SubContent>
      </DropdownMenu.Sub>
    );
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Button variant="soft" size="1" color={iconColor}>
          <LockClosedIcon />
          <Text size="1">
            {APPROVAL_LEVELS[settings.globalFloor as keyof typeof APPROVAL_LEVELS]?.label}
          </Text>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content style={{ minWidth: 220 }}>{content}</DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
