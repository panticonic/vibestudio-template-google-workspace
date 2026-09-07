import {
  Button,
  Flex,
  IconButton,
  Popover,
  ScrollArea,
  Select,
  Text,
  TextField,
} from "@radix-ui/themes";
import { GearIcon } from "@radix-ui/react-icons";
import { useIsMobile } from "@workspace/react/responsive";
import {
  actionLabel,
  defaultKeybindings,
  displayChord,
  eventToChord,
  validateKeybindingOverrides,
  type KeybindingAction,
  type KeybindingOverrides,
} from "./keybindings.js";

export function Settings(props: {
  open: boolean;
  panelTitle: string;
  fontSize: number;
  fontFamily: string;
  scrollbackBytes: number;
  themeOverride: "auto" | "light" | "dark";
  pasteMode: "path" | "dataUri" | "both";
  imagePasteRelative: boolean;
  keybindings: KeybindingOverrides;
  onOpenChange(open: boolean): void;
  onChange(
    next: Partial<{
      panelTitle: string;
      fontSize: number;
      fontFamily: string;
      scrollbackBytes: number;
      themeOverride: "auto" | "light" | "dark";
      pasteMode: "path" | "dataUri" | "both";
      imagePasteRelative: boolean;
      keybindings: KeybindingOverrides;
    }>
  ): void;
}) {
  const isMobile = useIsMobile();
  const keybindingIssues = validateKeybindingOverrides(props.keybindings);
  const issuesByAction = new Map(keybindingIssues.map((issue) => [issue.action, issue.message]));

  return (
    <Popover.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Popover.Trigger>
        <IconButton size="1" variant="ghost" aria-label="Terminal settings">
          <GearIcon />
        </IconButton>
      </Popover.Trigger>
      <Popover.Content
        width={isMobile ? "calc(100vw - 24px)" : "22rem"}
        style={{ maxHeight: "calc(100dvh - 24px)", overflow: "auto" }}
      >
        <Flex direction="column" gap="3">
          <Text size="2" weight="medium">
            Terminal settings
          </Text>
          <Flex direction="column" gap="1">
            <Text size="1" color="gray">
              Panel name
            </Text>
            <TextField.Root
              size="2"
              value={props.panelTitle}
              maxLength={80}
              placeholder="Terminal"
              aria-label="Panel name"
              onChange={(event) => props.onChange({ panelTitle: event.target.value })}
            />
            <Text size="1" color="gray">
              Shown in your panel list. Terminal sessions keep their own names.
            </Text>
          </Flex>
          <Flex direction="column" gap="1">
            <Text size="1" color="gray">
              Font size
            </Text>
            <Flex align="center" gap="2">
              <Button
                size="1"
                variant="soft"
                onClick={() => props.onChange({ fontSize: Math.max(9, props.fontSize - 1) })}
              >
                -
              </Button>
              <TextField.Root
                size="2"
                type="number"
                min={9}
                max={24}
                value={String(props.fontSize)}
                onChange={(event) =>
                  props.onChange({
                    fontSize: clamp(Number(event.target.value), 9, 24, props.fontSize),
                  })
                }
              />
              <Button
                size="1"
                variant="soft"
                onClick={() => props.onChange({ fontSize: Math.min(24, props.fontSize + 1) })}
              >
                +
              </Button>
            </Flex>
          </Flex>
          <Flex direction="column" gap="1">
            <Text size="1" color="gray">
              Font family
            </Text>
            <TextField.Root
              size="2"
              value={props.fontFamily}
              onChange={(event) => props.onChange({ fontFamily: event.target.value })}
            />
          </Flex>
          <Flex direction="column" gap="1">
            <Text size="1" color="gray">
              Scrollback
            </Text>
            <Select.Root
              value={String(props.scrollbackBytes)}
              onValueChange={(value) => props.onChange({ scrollbackBytes: Number(value) })}
            >
              <Select.Trigger />
              <Select.Content>
                <Select.Item value={String(256 * 1024)}>256 KB</Select.Item>
                <Select.Item value={String(1024 * 1024)}>1 MB</Select.Item>
                <Select.Item value={String(4 * 1024 * 1024)}>4 MB</Select.Item>
                <Select.Item value={String(8 * 1024 * 1024)}>8 MB</Select.Item>
              </Select.Content>
            </Select.Root>
          </Flex>
          <Flex direction="column" gap="1">
            <Text size="1" color="gray">
              Theme
            </Text>
            <Select.Root
              value={props.themeOverride}
              onValueChange={(value) =>
                props.onChange({ themeOverride: value as "auto" | "light" | "dark" })
              }
            >
              <Select.Trigger />
              <Select.Content>
                <Select.Item value="auto">Auto</Select.Item>
                <Select.Item value="light">Light</Select.Item>
                <Select.Item value="dark">Dark</Select.Item>
              </Select.Content>
            </Select.Root>
          </Flex>
          <Flex direction="column" gap="1">
            <Text size="1" color="gray">
              Paste files as
            </Text>
            <Select.Root
              value={props.pasteMode}
              onValueChange={(value) =>
                props.onChange({ pasteMode: value as "path" | "dataUri" | "both" })
              }
            >
              <Select.Trigger />
              <Select.Content>
                <Select.Item value="path">Path</Select.Item>
                <Select.Item value="dataUri">Data URI</Select.Item>
                <Select.Item value="both">Both</Select.Item>
              </Select.Content>
            </Select.Root>
          </Flex>
          <Button
            size="1"
            variant={props.imagePasteRelative ? "solid" : "soft"}
            onClick={() => props.onChange({ imagePasteRelative: !props.imagePasteRelative })}
          >
            Relative file paths
          </Button>
          <Flex direction="column" gap="2">
            <Flex align="center" justify="between">
              <Text size="1" color="gray">
                Keybindings
              </Text>
              <Button size="1" variant="ghost" onClick={() => props.onChange({ keybindings: {} })}>
                Reset
              </Button>
            </Flex>
            <ScrollArea type="auto" scrollbars="vertical" style={{ maxHeight: "15rem" }}>
              <Flex direction="column" gap="2" pr="2">
                {keybindingActions.map((action) => {
                  const issue = issuesByAction.get(action);
                  return (
                    <Flex key={action} direction="column" gap="1">
                      <Flex
                        align={isMobile ? "stretch" : "center"}
                        direction={isMobile ? "column" : "row"}
                        gap="2"
                      >
                        <Text
                          size="1"
                          color="gray"
                          style={isMobile ? undefined : { width: "8rem" }}
                        >
                          {actionLabel(action)}
                        </Text>
                        <TextField.Root
                          size="1"
                          value={displayChord(
                            props.keybindings[action] ?? defaultKeybindings[action]
                          ).join("+")}
                          placeholder={displayChord(defaultKeybindings[action]).join("+")}
                          color={issue ? "red" : undefined}
                          readOnly
                          onKeyDown={(event) => {
                            if (event.key === "Tab") return;
                            event.preventDefault();
                            event.stopPropagation();
                            if (event.key === "Backspace" || event.key === "Delete") {
                              props.onChange({
                                keybindings: updateKeybindingOverride(
                                  props.keybindings,
                                  action,
                                  ""
                                ),
                              });
                              return;
                            }
                            if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
                            props.onChange({
                              keybindings: updateKeybindingOverride(
                                props.keybindings,
                                action,
                                eventToChord(event.nativeEvent)
                              ),
                            });
                          }}
                          aria-label={`${actionLabel(action)} shortcut. Press a key combination to change it.`}
                          style={{ flex: 1 }}
                        />
                      </Flex>
                      {issue ? (
                        <Text size="1" color="red">
                          {issue}
                        </Text>
                      ) : null}
                    </Flex>
                  );
                })}
              </Flex>
            </ScrollArea>
          </Flex>
        </Flex>
      </Popover.Content>
    </Popover.Root>
  );
}

const keybindingActions = Object.keys(defaultKeybindings) as KeybindingAction[];

function updateKeybindingOverride(
  current: KeybindingOverrides,
  action: KeybindingAction,
  value: string
): KeybindingOverrides {
  const next = { ...current };
  if (!value || value === defaultKeybindings[action]) {
    const { [action]: _removed, ...rest } = next;
    return rest;
  }
  next[action] = value;
  return next;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
