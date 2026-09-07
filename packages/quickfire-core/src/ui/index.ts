/**
 * `@workspace/quickfire-core/ui` — the shared component tree for the compact
 * agent surfaces, drawn against a per-platform skin.
 *
 * Deliberately separate from the package root: the root is pure model and stays
 * importable from non-React code (the workers that own the service read it), and
 * only a renderer should be pulling React in.
 */

export {
  QuickfireSkinProvider,
  useSkin,
  type QuickfireBoxProps,
  type QuickfireCodeProps,
  type QuickfireDisclosureProps,
  type QuickfireFigureProps,
  type QuickfireIconProps,
  type QuickfireImageProps,
  type QuickfirePressableProps,
  type QuickfireSkin,
  type QuickfireSpace,
  type QuickfireTextProps,
} from "./primitives";
export { Blocks, Inlines, Markdown } from "./Markdown";
export { Transcript, TranscriptCard, type TranscriptProps } from "./Transcript";
export {
  ConversationBody,
  ConversationHeader,
  type ConversationIntent,
  type ConversationProps,
} from "./Conversation";
