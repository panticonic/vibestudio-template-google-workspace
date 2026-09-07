import type { CSSProperties, ReactNode } from "react";

export interface ConversationPresentation {
  title: string;
  eyebrow?: string;
  subtitle?: string;
  sigil?: string;
  emptyTitle?: string;
  emptyBody?: string;
  composerPlaceholder?: string;
  palette?: {
    surface?: string;
    card?: string;
    raised?: string;
    border?: string;
    text?: string;
    muted?: string;
    accent?: string;
    rail?: string;
    playerSurface?: string;
    playerSurfaceStrong?: string;
  };
  headingFont?: string;
  bodyFont?: string;
}

export function conversationStyle(
  presentation: ConversationPresentation | undefined,
): CSSProperties | undefined {
  if (!presentation) return undefined;
  const palette = presentation.palette ?? {};
  return {
    ...(palette.surface ? { "--agentic-surface": palette.surface } : {}),
    ...(palette.card ? { "--agentic-surface-card": palette.card } : {}),
    ...(palette.raised ? { "--agentic-surface-raised": palette.raised } : {}),
    ...(palette.border ? { "--agentic-border": palette.border } : {}),
    ...(palette.text ? { "--agentic-text": palette.text } : {}),
    ...(palette.muted ? { "--agentic-text-muted": palette.muted } : {}),
    ...(palette.accent ? { "--agentic-player-accent": palette.accent } : {}),
    ...(palette.rail ? { "--agentic-player-rail": palette.rail } : {}),
    ...(palette.playerSurface
      ? { "--agentic-player-surface": palette.playerSurface }
      : {}),
    ...(palette.playerSurfaceStrong
      ? { "--agentic-player-surface-strong": palette.playerSurfaceStrong }
      : {}),
    ...(presentation.bodyFont ? { fontFamily: presentation.bodyFont } : {}),
  } as CSSProperties;
}

export function ConversationHeader({
  presentation,
}: {
  presentation: ConversationPresentation;
}) {
  return (
    <header className="immersive-conversation-header" data-part="chat-header">
      <span className="immersive-conversation-sigil" aria-hidden="true">
        {presentation.sigil ?? "✦"}
      </span>
      <div>
        {presentation.eyebrow ? <small>{presentation.eyebrow}</small> : null}
        <strong
          style={
            presentation.headingFont
              ? { fontFamily: presentation.headingFont }
              : undefined
          }
        >
          {presentation.title}
        </strong>
        {presentation.subtitle ? <p>{presentation.subtitle}</p> : null}
      </div>
    </header>
  );
}

export function renderConversationEmptyState(
  presentation: ConversationPresentation,
  defaultContent: ReactNode,
  phase: "review" | "agent" | "models" | "ready" | "connecting",
): ReactNode {
  if (phase !== "ready") return defaultContent;
  return (
    <section className="immersive-conversation-empty">
      <span aria-hidden="true">{presentation.sigil ?? "✦"}</span>
      <small>{presentation.eyebrow ?? presentation.title}</small>
      <h2
        style={
          presentation.headingFont
            ? { fontFamily: presentation.headingFont }
            : undefined
        }
      >
        {presentation.emptyTitle ?? "The room is listening"}
      </h2>
      <p>
        {presentation.emptyBody ??
          "Speak naturally. Your companion knows the world and will guide the next step."}
      </p>
    </section>
  );
}
