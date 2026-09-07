/**
 * The primitive contract the shared overlay components draw against.
 *
 * `apps/shell/SKILL.md` says desktop and mobile share presentation *rules*, not
 * renderer components — and that rule produced two hand-written transcripts that
 * drifted apart in every detail that mattered (one showed a tool's failure text,
 * the other did not; one glued a notice's detail into its heading; both wrote
 * their own Markdown walker, their own relative-time function and their own
 * disclosure behaviour).
 *
 * This is the narrow waist that lets the *components* be shared too without
 * pretending a WebContentsView and a React Native sheet are the same runtime:
 * the shared tree never names a `div`, a `View`, a colour or a font. It composes
 * a handful of semantic primitives, and each client supplies them in its own
 * idiom — CSS classes over DOM nodes on desktop, StyleSheet objects over React
 * Native views on mobile. Adding a platform means writing one skin, not a second
 * transcript.
 */

import {
  createContext,
  useContext,
  type ComponentType,
  type ReactNode,
} from "react";
import type { QuickfireGlyph, QuickfireTone } from "../cards";

/** Spacing step. Concrete values belong to the skin, not to shared code. */
export type QuickfireSpace = "none" | "xs" | "sm" | "md" | "lg";

export interface QuickfireBoxProps {
  children?: ReactNode;
  /** Space between children. */
  gap?: QuickfireSpace;
  /** Inner padding. */
  pad?: QuickfireSpace;
  /** Lay children out horizontally, wrapping when they do not fit. */
  row?: boolean;
  /** Container treatment. `answer` is the primary agent response; `rail` is supporting context. */
  surface?: "none" | "answer" | "card" | "sunken" | "outline" | "rail";
  tone?: QuickfireTone;
  align?: "start" | "center" | "baseline";
  /** Take the remaining space on the main axis. */
  grow?: boolean;
  /** Occupy a complete line inside a wrapping row. */
  full?: boolean;
  /** Collapse to the content width until disclosed content needs the row. */
  fit?: boolean;
  /** Scroll internally rather than growing past the surface. */
  scroll?: boolean;
  testId?: string;
  /** Announced by screen readers when the box is a live region. */
  live?: boolean;
  /** Ring this box in its tone — "this is the one you came here for". */
  emphasis?: boolean;
  /**
   * Secondary controls: present, but not competing with the content until the
   * pointer is on the card. Platforms without hover ignore it and show them.
   */
  hover?: boolean;
}

export interface QuickfireTextProps {
  children?: ReactNode;
  variant?:
    | "body"
    | "strong"
    | "emphasis"
    | "strike"
    | "heading"
    | "label"
    | "caption"
    | "code";
  tone?: QuickfireTone | "muted";
  /** Truncate to a single line — headings and metadata only, never content. */
  clamp?: boolean;
  /** Long-press/drag to select. Details and code are always selectable. */
  selectable?: boolean;
  testId?: string;
}

export interface QuickfirePressableProps {
  children?: ReactNode;
  onPress: () => void;
  /** Accessible name. Required: every control here is reachable without sight. */
  label: string;
  /**
   * `quiet` is an *inline* control — a link inside running prose. A skin must
   * render it with something legal inside its own text flow (a `<Text onPress>`
   * on React Native, an `<a>` on the web); wrapping a block element around it
   * breaks the paragraph it sits in.
   */
  variant?: "ghost" | "quiet" | "primary";
  /**
   * Set when the press opens an external destination. A skin whose platform has
   * a native link element should render one — the desktop overlay is a separate
   * WebContents whose new-window handling is the host's, and an anchor is how
   * that path is reached.
   */
  href?: string;
  tone?: QuickfireTone;
  disabled?: boolean;
  testId?: string;
}

export interface QuickfireIconProps {
  name: QuickfireGlyph;
  tone?: QuickfireTone | "muted";
  size?: "sm" | "md";
}

export interface QuickfireDisclosureProps {
  /** Collapsed line. Kept short; the payload lives in `children`. */
  summary: ReactNode;
  children: ReactNode;
  /** Open on first render — used for reasoning that is still streaming. */
  defaultOpen?: boolean;
  tone?: QuickfireTone;
  label: string;
  testId?: string;
}

export interface QuickfireCodeProps {
  text: string;
  language?: string | null;
  /** A short label above the block: "Input", "Output", a filename. */
  caption?: string | null;
}

export interface QuickfireImageProps {
  src: string;
  alt: string;
}

export interface QuickfireFigureProps {
  src: string;
  alt: string;
  /** Shown under the picture: dimensions and size. */
  caption?: string;
}

/**
 * One client's rendering of the primitives, plus the two host capabilities the
 * shared tree needs and cannot have: opening a URL, and copying text.
 */
export interface QuickfireSkin {
  Box: ComponentType<QuickfireBoxProps>;
  Text: ComponentType<QuickfireTextProps>;
  Pressable: ComponentType<QuickfirePressableProps>;
  Icon: ComponentType<QuickfireIconProps>;
  Spinner: ComponentType<{ tone?: QuickfireTone }>;
  Divider: ComponentType<Record<string, never>>;
  /**
   * A hard line break inside running text. Optional: a skin whose text flow
   * already honours "\n" (React Native) leaves it out, and the renderer emits
   * the newline directly. DOM collapses newlines, so the web skin supplies one.
   */
  Break?: ComponentType<Record<string, never>>;
  /** Small trailing chip. */
  Pill: ComponentType<{ children?: ReactNode; tone?: QuickfireTone }>;
  Disclosure: ComponentType<QuickfireDisclosureProps>;
  Code: ComponentType<QuickfireCodeProps>;
  /**
   * *Inline* image, inside running prose. Optional: a skin whose text flow
   * cannot host one (React Native) leaves it out and the renderer falls back to
   * the alt text, which is never dropped either way.
   */
  Image?: ComponentType<QuickfireImageProps>;
  /**
   * *Block* image — a screenshot a tool returned. Every skin can draw one of
   * these, because it never sits inside a paragraph.
   */
  Figure: ComponentType<QuickfireFigureProps>;
  /** The live-text cursor on a streaming reply. */
  Caret: ComponentType<Record<string, never>>;
  openUrl?: (href: string) => void;
  copy?: (text: string) => void;
}

const SkinContext = createContext<QuickfireSkin | null>(null);

export const QuickfireSkinProvider = SkinContext.Provider;

export function useSkin(): QuickfireSkin {
  const skin = useContext(SkinContext);
  if (!skin) {
    throw new Error(
      "Quickfire surfaces must be rendered inside a QuickfireSkinProvider",
    );
  }
  return skin;
}
