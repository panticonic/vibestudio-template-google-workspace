import { Box, Button, Dialog, Flex, IconButton, Kbd, Text } from "@radix-ui/themes";
import {
  Cross2Icon,
  PaperPlaneIcon,
  Pencil2Icon,
  PlusIcon,
  RocketIcon,
  TrashIcon,
} from "@radix-ui/react-icons";
import { useEffect, useRef, useState } from "react";
import { useIsMobile } from "@workspace/react/responsive";
import { SCRATCH_BUFFER_MAX_TEXT_BYTES } from "./terminalState.js";
import type { ScratchBuffer } from "./types.js";

const COMMIT_DEBOUNCE_MS = 500;
const MONOSPACE_FAMILY = "JetBrains Mono, Menlo, Consolas, monospace";

export function ScratchOverlay(props: {
  open: boolean;
  buffers: ScratchBuffer[];
  activeBufferId?: string;
  fontFamily?: string;
  hasFocusedSession: boolean;
  onOpenChange(open: boolean): void;
  onNewBuffer(): void;
  onSelectBuffer(bufferId: string): void;
  onEjectBuffer(bufferId: string): void;
  onCommitText(bufferId: string, text: string): void;
  onPaste(bufferId: string, text: string): void;
  onPasteAndRun(bufferId: string, text: string): void;
}) {
  const isMobile = useIsMobile();
  const active = props.activeBufferId
    ? props.buffers.find((buffer) => buffer.bufferId === props.activeBufferId)
    : undefined;
  const [draft, setDraft] = useState(active?.text ?? "");
  const [truncated, setTruncated] = useState(false);
  const draftRef = useRef(draft);
  const activeIdRef = useRef(props.activeBufferId);
  const commitTextRef = useRef(props.onCommitText);
  const commitTimerRef = useRef<number | null>(null);

  function applyDraft(value: string) {
    if (value.length > SCRATCH_BUFFER_MAX_TEXT_BYTES) {
      setDraft(value.slice(0, SCRATCH_BUFFER_MAX_TEXT_BYTES));
      setTruncated(true);
    } else {
      setDraft(value);
      if (truncated) setTruncated(false);
    }
  }

  useEffect(() => {
    commitTextRef.current = props.onCommitText;
  }, [props.onCommitText]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Reseed local draft when the active buffer changes from outside.
  useEffect(() => {
    if (props.activeBufferId === activeIdRef.current) return;
    activeIdRef.current = props.activeBufferId;
    setDraft(active?.text ?? "");
    setTruncated(false);
  }, [props.activeBufferId, active?.text]);

  // Debounced auto-commit while typing.
  useEffect(() => {
    if (!props.open || !props.activeBufferId) return;
    if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = window.setTimeout(() => {
      const id = activeIdRef.current;
      if (id) commitTextRef.current(id, draftRef.current);
    }, COMMIT_DEBOUNCE_MS);
    return () => {
      if (commitTimerRef.current) {
        window.clearTimeout(commitTimerRef.current);
        commitTimerRef.current = null;
      }
    };
  }, [draft, props.open, props.activeBufferId]);

  // Commit on close.
  useEffect(() => {
    if (props.open) return;
    const id = activeIdRef.current;
    if (id) props.onCommitText(id, draftRef.current);
    if (commitTimerRef.current) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    // We only want this when `open` flips to false.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  function commitNow() {
    const id = activeIdRef.current;
    if (!id) return;
    props.onCommitText(id, draftRef.current);
    if (commitTimerRef.current) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
  }

  function handleSelectBuffer(bufferId: string) {
    if (bufferId === props.activeBufferId) return;
    commitNow();
    props.onSelectBuffer(bufferId);
  }

  function handleNewBuffer() {
    commitNow();
    props.onNewBuffer();
  }

  function handlePaste() {
    const id = activeIdRef.current;
    if (!id) return;
    props.onPaste(id, draftRef.current);
  }

  function handlePasteAndRun() {
    const id = activeIdRef.current;
    if (!id) return;
    props.onPasteAndRun(id, draftRef.current);
  }

  const textareaFamily = props.fontFamily || MONOSPACE_FAMILY;
  const canPaste = props.hasFocusedSession && draft.trim().length > 0;

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Content
        maxWidth={isMobile ? "calc(100vw - 16px)" : "760px"}
        style={{
          marginTop: isMobile ? "2dvh" : "8vh",
          padding: 0,
          overflow: "hidden",
          maxHeight: isMobile ? "calc(100dvh - 24px)" : "84dvh",
          display: "flex",
          flexDirection: "column",
        }}
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <Flex
          align="center"
          justify="between"
          px="3"
          py="2"
          style={{ borderBottom: "1px solid var(--gray-5)" }}
        >
          <Flex align="center" gap="2" minWidth="0">
            <Pencil2Icon style={{ color: "var(--accent-10)" }} />
            <Dialog.Title size="2" weight="medium" mb="0">
              Scratch buffers
            </Dialog.Title>
            <Text size="1" color="gray">
              {props.buffers.length} / 50
            </Text>
          </Flex>
          <Flex align="center" gap="1">
            <Button size="1" variant="soft" onClick={handleNewBuffer}>
              <PlusIcon /> New
            </Button>
            <Dialog.Close>
              <IconButton size="1" variant="ghost" aria-label="Close scratch overlay">
                <Cross2Icon />
              </IconButton>
            </Dialog.Close>
          </Flex>
        </Flex>

        <Flex
          direction={isMobile ? "column" : "row"}
          style={{ flex: 1, minHeight: 0, minWidth: 0 }}
        >
          <BufferRail
            buffers={props.buffers}
            activeBufferId={props.activeBufferId}
            isMobile={isMobile}
            onSelect={handleSelectBuffer}
            onEject={props.onEjectBuffer}
          />

          <Box style={{ flex: 1, minHeight: 0, minWidth: 0, padding: "var(--space-3)" }}>
            <textarea
              key={props.activeBufferId}
              autoFocus
              value={draft}
              onChange={(event) => applyDraft(event.target.value)}
              onBlur={commitNow}
              onKeyDown={(event) => {
                const isMod = event.metaKey || event.ctrlKey;
                if (isMod && event.key === "Enter") {
                  event.preventDefault();
                  if (!canPaste) return;
                  if (event.shiftKey) handlePasteAndRun();
                  else handlePaste();
                }
              }}
              placeholder="Draft text here, then paste it into the focused terminal..."
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              style={{
                width: "100%",
                minHeight: isMobile ? "10rem" : "12rem",
                maxHeight: isMobile ? "48dvh" : "56dvh",
                resize: "none",
                fontFamily: textareaFamily,
                fontSize: "13px",
                lineHeight: 1.5,
                padding: "var(--space-3)",
                borderRadius: "var(--radius-3)",
                border: "1px solid var(--gray-6)",
                background: "var(--gray-2)",
                color: "var(--gray-12)",
                outline: "none",
                boxSizing: "border-box",
                fieldSizing: "content",
                tabSize: 2,
              }}
            />
          </Box>
        </Flex>

        <Flex
          align="center"
          justify="between"
          gap="2"
          px="3"
          py="2"
          wrap="wrap"
          style={{ borderTop: "1px solid var(--gray-5)" }}
        >
          <Flex gap="2" wrap="wrap">
            <Text size="1" color="gray">
              <Kbd>{macModifier()}+Enter</Kbd> paste
            </Text>
            <Text size="1" color="gray">
              <Kbd>{macModifier()}+Shift+Enter</Kbd> paste &amp; run
            </Text>
            {!props.hasFocusedSession ? (
              <Text size="1" color="amber">
                Open a terminal to paste into.
              </Text>
            ) : null}
            {truncated ? (
              <Text size="1" color="amber" role="status" aria-live="polite">
                Trimmed to {Math.round(SCRATCH_BUFFER_MAX_TEXT_BYTES / 1000)} KB.
              </Text>
            ) : null}
          </Flex>
          <Flex gap="2">
            <Dialog.Close>
              <Button size="2" variant="soft" color="gray">
                Close
              </Button>
            </Dialog.Close>
            <Button size="2" variant="soft" onClick={handlePaste} disabled={!canPaste}>
              <PaperPlaneIcon /> Paste
            </Button>
            <Button size="2" onClick={handlePasteAndRun} disabled={!canPaste}>
              <RocketIcon /> Paste &amp; Run
            </Button>
          </Flex>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function BufferRail(props: {
  buffers: ScratchBuffer[];
  activeBufferId?: string;
  isMobile: boolean;
  onSelect(bufferId: string): void;
  onEject(bufferId: string): void;
}) {
  const railStyle: React.CSSProperties = props.isMobile
    ? {
        display: "flex",
        flexDirection: "row",
        gap: "var(--space-1)",
        padding: "var(--space-2) var(--space-3)",
        borderBottom: "1px solid var(--gray-5)",
        overflowX: "auto",
        flexShrink: 0,
      }
    : {
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-1)",
        padding: "var(--space-2)",
        borderRight: "1px solid var(--gray-5)",
        width: "180px",
        flexShrink: 0,
        overflowY: "auto",
      };

  if (props.buffers.length === 0) {
    return (
      <div style={railStyle}>
        <Text size="1" color="gray" style={{ padding: "var(--space-2)" }}>
          No buffers yet
        </Text>
      </div>
    );
  }

  return (
    <div style={railStyle}>
      {props.buffers.map((buffer) => (
        <BufferChip
          key={buffer.bufferId}
          buffer={buffer}
          active={buffer.bufferId === props.activeBufferId}
          isMobile={props.isMobile}
          onSelect={() => props.onSelect(buffer.bufferId)}
          onEject={() => props.onEject(buffer.bufferId)}
        />
      ))}
    </div>
  );
}

function BufferChip(props: {
  buffer: ScratchBuffer;
  active: boolean;
  isMobile: boolean;
  onSelect(): void;
  onEject(): void;
}) {
  const preview = firstLineOrPlaceholder(props.buffer.text);
  const bg = props.active ? "var(--accent-4)" : "var(--gray-2)";
  const border = props.active ? "var(--accent-8)" : "var(--gray-5)";
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: props.isMobile ? "row" : "column",
        alignItems: props.isMobile ? "center" : "stretch",
        gap: "var(--space-1)",
        padding: "var(--space-1) var(--space-2)",
        borderRadius: "var(--radius-2)",
        border: `1px solid ${border}`,
        background: bg,
        cursor: "pointer",
        minWidth: props.isMobile ? "10rem" : 0,
        flexShrink: 0,
      }}
      onClick={props.onSelect}
    >
      <Flex direction="column" minWidth="0" style={{ flex: 1, minWidth: 0 }}>
        <Text
          size="1"
          weight={props.active ? "medium" : "regular"}
          truncate
          style={{ fontFamily: MONOSPACE_FAMILY }}
        >
          {preview}
        </Text>
        <Text size="1" color="gray" truncate>
          {relativeTime(props.buffer.updatedAt)}
        </Text>
      </Flex>
      <IconButton
        size="1"
        variant="ghost"
        color="gray"
        aria-label="Remove buffer"
        onClick={(event) => {
          event.stopPropagation();
          if (props.buffer.text.trim() && !window.confirm("Delete this scratch buffer? This cannot be undone.")) return;
          props.onEject();
        }}
        style={{ flexShrink: 0 }}
      >
        <TrashIcon />
      </IconButton>
    </div>
  );
}

function firstLineOrPlaceholder(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "(empty)";
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? trimmed;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function macModifier(): string {
  if (typeof navigator === "undefined") return "Mod";
  return /mac/i.test(navigator.platform) ? "⌘" : "Ctrl+Shift";
}
