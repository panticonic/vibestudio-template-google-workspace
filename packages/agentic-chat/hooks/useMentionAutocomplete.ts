import { useCallback, useMemo, useState } from "react";
import type { Participant } from "@workspace/pubsub";
import type { ChatParticipantMetadata } from "../types";
import type { AccountProfile } from "./useAccountProfiles";

const HANDLE_CHARS = /^[A-Za-z0-9_.-]*$/;
const EMPTY_PROFILES: ReadonlyMap<string, AccountProfile> = new Map();

export interface MentionCandidate {
  participantId: string;
  handle: string;
  name: string;
  type: string;
}

export interface MentionAutocompleteState {
  open: boolean;
  query: string;
  selectedIndex: number;
  candidates: MentionCandidate[];
  triggerStart: number;
  caretPosition: { left: number; top: number } | null;
  setSelectedIndex: (index: number) => void;
  updateFromTextArea: (textArea: HTMLTextAreaElement, text: string) => void;
  close: () => void;
}

export function useMentionAutocomplete(
  roster: Record<string, Participant<ChatParticipantMetadata>>,
  /** This client's own participant id — excluded from candidates (you can't
   *  @-mention the chat panel itself). */
  selfId?: string | null,
  profiles: ReadonlyMap<string, AccountProfile> = EMPTY_PROFILES
): MentionAutocompleteState {
  const [query, setQuery] = useState("");
  const [triggerStart, setTriggerStart] = useState(-1);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [caretPosition, setCaretPosition] = useState<{ left: number; top: number } | null>(null);

  const candidates = useMemo(() => {
    const q = query.toLowerCase();
    return Object.entries(roster)
      .flatMap(([participantId, participant]): MentionCandidate[] => {
        if (selfId && participantId === selfId) return []; // never mention self
        const profile = profiles.get(participantId);
        const handle = profile?.handle ?? participant.metadata.handle;
        if (!handle) return [];
        const name = profile?.displayName ?? participant.metadata.name ?? handle;
        const type = profile ? "user" : (participant.metadata.type ?? "unknown");
        if (q && !handle.toLowerCase().includes(q) && !name.toLowerCase().includes(q)) return [];
        return [{ participantId, handle, name, type }];
      })
      .sort((a, b) => a.handle.localeCompare(b.handle))
      .slice(0, 8);
  }, [profiles, query, roster, selfId]);

  const close = useCallback(() => {
    setTriggerStart(-1);
    setQuery("");
    setSelectedIndex(0);
    setCaretPosition(null);
  }, []);

  const updateFromTextArea = useCallback(
    (textArea: HTMLTextAreaElement, text: string) => {
      const caret = textArea.selectionStart ?? text.length;
      const beforeCaret = text.slice(0, caret);
      const at = beforeCaret.lastIndexOf("@");
      if (at < 0) {
        close();
        return;
      }
      const prefix = at === 0 ? "" : (beforeCaret[at - 1] ?? "");
      const token = beforeCaret.slice(at + 1);
      if ((prefix && !/[\s([{]/.test(prefix)) || token.includes(" ") || !HANDLE_CHARS.test(token)) {
        close();
        return;
      }
      setTriggerStart(at);
      setQuery(token);
      setSelectedIndex(0);
      // Viewport coordinates: the popover renders in a portal with
      // position:fixed so no ancestor overflow clipping can cut it off.
      const local = measureCaretPosition(textArea, at);
      const rect = textArea.getBoundingClientRect();
      setCaretPosition({ left: rect.left + local.left, top: rect.top + local.top });
    },
    [close]
  );

  return {
    open: triggerStart >= 0 && candidates.length > 0,
    query,
    selectedIndex: Math.min(selectedIndex, Math.max(0, candidates.length - 1)),
    candidates,
    triggerStart,
    caretPosition,
    setSelectedIndex,
    updateFromTextArea,
    close,
  };
}

function measureCaretPosition(
  textArea: HTMLTextAreaElement,
  caretIndex: number
): { left: number; top: number } {
  const style = window.getComputedStyle(textArea);
  const mirror = document.createElement("div");
  const span = document.createElement("span");
  const properties = [
    "boxSizing",
    "width",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "letterSpacing",
    "lineHeight",
    "textTransform",
    "wordSpacing",
  ] as const;

  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  for (const property of properties) {
    mirror.style[property] = style[property];
  }

  mirror.textContent = textArea.value.slice(0, caretIndex);
  span.textContent = textArea.value.slice(caretIndex, caretIndex + 1) || ".";
  mirror.appendChild(span);
  document.body.appendChild(mirror);
  const left = span.offsetLeft - textArea.scrollLeft;
  const top = span.offsetTop - textArea.scrollTop;
  mirror.remove();
  return { left, top };
}
