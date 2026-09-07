import { Button, Flex, IconButton, Text, TextField } from "@radix-ui/themes";
import { ArrowDownIcon, ArrowUpIcon, Cross2Icon } from "@radix-ui/react-icons";
import { findKeyAction } from "./findModel.js";

export function FindBar(props: {
  value: string;
  caseSensitive: boolean;
  regex: boolean;
  status: string;
  onChange(value: string): void;
  onCaseSensitiveChange(value: boolean): void;
  onRegexChange(value: boolean): void;
  onNext(): void;
  onPrevious(): void;
  onUseSelection(): void;
  onClose(): void;
}) {
  return (
    <Flex align="center" gap="2" p="2" style={{ borderTop: "1px solid var(--gray-5)", background: "var(--gray-2)" }}>
      <TextField.Root
        value={props.value}
        autoFocus
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          const action = findKeyAction(event.nativeEvent);
          if (action === "none") return;
          event.preventDefault();
          if (action === "close") props.onClose();
          else if (action === "previous") props.onPrevious();
          else {
            props.onNext();
          }
        }}
        placeholder="Find"
        style={{ flex: 1 }}
      />
      <Text size="1" color={props.status === "No matches" ? "red" : "gray"}>{props.status}</Text>
      <Button size="1" variant={props.caseSensitive ? "solid" : "soft"} onClick={() => props.onCaseSensitiveChange(!props.caseSensitive)}>Aa</Button>
      <Button size="1" variant={props.regex ? "solid" : "soft"} onClick={() => props.onRegexChange(!props.regex)}>.*</Button>
      <IconButton size="1" variant="ghost" aria-label="Previous match" onClick={props.onPrevious}><ArrowUpIcon /></IconButton>
      <IconButton size="1" variant="ghost" aria-label="Next match" onClick={props.onNext}><ArrowDownIcon /></IconButton>
      <Button size="1" variant="soft" onClick={props.onUseSelection}>Use selection</Button>
      <IconButton size="1" variant="ghost" aria-label="Close find" onClick={props.onClose}><Cross2Icon /></IconButton>
    </Flex>
  );
}
