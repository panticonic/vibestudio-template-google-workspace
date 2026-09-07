import { Badge, Flex, Kbd, Text } from "@radix-ui/themes";
import { LightningBoltIcon } from "@radix-ui/react-icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTouchDevice } from "@workspace/react/responsive";
import { CommandPalette, type CommandItem } from "@workspace/ui/command";
import { commandTargetForEnter, type CommandRunTarget } from "./commandLauncherModel.js";
import { loadCommandSuggestions, type CommandSuggestion } from "./commandSources.js";

/**
 * Terminal command launcher, built on the shared `CommandPalette` primitive.
 * The primitive owns the modal shell, search field, arrow-key nav, sectioned
 * results and Enter-to-run; the terminal-specific parts — run targets and the
 * split-shortcut legend — ride in each item's `trailing` and the `footer`.
 */
export function CommandLauncher(props: {
  open: boolean;
  cwd?: string;
  history: string[];
  onOpenChange(open: boolean): void;
  onRun(command: string, target: CommandRunTarget): Promise<void>;
  onBuiltin(action: string): void;
}) {
  const { open, cwd, history, onRun, onBuiltin, onOpenChange } = props;
  const touch = useTouchDevice();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([]);

  useEffect(() => {
    if (!open) return;
    void loadCommandSuggestions({ query, cwd, history }).then(setSuggestions);
  }, [open, query, cwd, history]);

  // Reset the query each time the launcher opens.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const accept = useCallback(
    async (suggestion: CommandSuggestion, target: CommandRunTarget) => {
      if (suggestion.kind === "builtin") onBuiltin(suggestion.action);
      else await onRun(suggestion.command, target);
      onOpenChange(false);
      setQuery("");
    },
    [onRun, onBuiltin, onOpenChange]
  );

  const items = useMemo<CommandItem<CommandSuggestion>[]>(
    () =>
      suggestions.map((suggestion) => ({
        id: suggestion.id,
        label: suggestion.label,
        hint: suggestion.subtitle,
        section: sectionLabel(suggestion.kind),
        value: suggestion,
        // On touch there's no hover/arrow to make a row "active", so reveal the
        // target chips unconditionally there — otherwise mobile is stuck on the
        // default target.
        trailing: ({ active }) =>
          canChooseRunTarget(suggestion) && (active || touch) ? (
            <Flex gap="1" flexShrink="0">
              <TargetChip
                label="Here"
                color="gray"
                onPick={() => void accept(suggestion, "here")}
              />
              <TargetChip
                label="Right"
                color="blue"
                onPick={() => void accept(suggestion, "splitRight")}
              />
              <TargetChip
                label="Down"
                color="amber"
                onPick={() => void accept(suggestion, "splitDown")}
              />
            </Flex>
          ) : (
            <Badge
              size="1"
              variant={active ? "solid" : "soft"}
              color={targetBadgeColor(suggestion)}
              style={{ opacity: active ? 1 : 0.72 }}
            >
              {targetLabel(suggestion)}
            </Badge>
          ),
      })),
    [suggestions, accept, touch]
  );

  return (
    <CommandPalette<CommandSuggestion>
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      items={items}
      placeholder="Run command or action"
      searchIcon={<LightningBoltIcon />}
      emptyMessage="No commands found"
      onSelect={(item, modifiers) => {
        const suggestion = item.value;
        if (!suggestion) return;
        const key = asKeyEvent(modifiers);
        const target = canChooseRunTarget(suggestion)
          ? commandTargetForEnter(key)
          : suggestionDefaultTarget(suggestion);
        void accept(suggestion, target);
      }}
      footer={
        <Flex align="center" gap="3" wrap="wrap">
          <Text size="1" color="gray">
            <Kbd>Enter</Kbd> run here
          </Text>
          <Text size="1" color="gray">
            <Kbd>Shift Enter</Kbd> split down
          </Text>
          <Text size="1" color="gray">
            <Kbd>Ctrl/Cmd Enter</Kbd> split right
          </Text>
        </Flex>
      }
    />
  );
}

/** Adapt the palette's modifier snapshot to the keyboard-event shape the model helpers expect. */
function asKeyEvent(modifiers: {
  mod: boolean;
  shift: boolean;
}): Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey"> {
  return { ctrlKey: modifiers.mod, metaKey: false, shiftKey: modifiers.shift };
}

function suggestionDefaultTarget(suggestion: CommandSuggestion): CommandRunTarget {
  return "defaultTarget" in suggestion && suggestion.defaultTarget
    ? suggestion.defaultTarget
    : "splitRight";
}

function TargetChip(props: {
  label: string;
  color: "gray" | "blue" | "green" | "amber";
  onPick(): void;
}) {
  return (
    <button
      // mousedown (not click) so we beat — and stop — the row's own mousedown
      // handler, which would otherwise run the default target and close first.
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onPick();
      }}
      style={{ border: 0, padding: 0, background: "transparent", cursor: "pointer" }}
    >
      <Badge size="1" variant="soft" color={props.color}>
        {props.label}
      </Badge>
    </button>
  );
}

function canChooseRunTarget(suggestion: CommandSuggestion): boolean {
  return suggestion.kind === "recent" || suggestion.kind === "project" || suggestion.kind === "raw";
}

function targetLabel(suggestion: CommandSuggestion): string {
  if (suggestion.kind === "builtin") return "Action";
  const target = suggestionDefaultTarget(suggestion);
  if (target === "here") return "Here";
  if (target === "splitDown") return "Split down";
  return "Split right";
}

function targetBadgeColor(suggestion: CommandSuggestion): "gray" | "blue" | "green" | "amber" {
  if (suggestion.kind === "builtin") return "gray";
  const target = suggestionDefaultTarget(suggestion);
  if (target === "here") return "gray";
  if (target === "splitDown") return "amber";
  return "blue";
}

function sectionLabel(kind: CommandSuggestion["kind"]): string {
  if (kind === "recent") return "Recent";
  if (kind === "project") return "Project commands";
  if (kind === "builtin") return "Builtins";
  return "Run as command";
}
