/**
 * What to offer someone staring at an empty conversation.
 *
 * The venue's whole proposition — "this agent can see the panel you are looking
 * at" — is invisible in a blank compose box. These are its actual capabilities,
 * written as the questions people arrive with, and shared so the desktop
 * overlay and the mobile sheet teach the same thing.
 *
 * Panel-aware because a web page and a workspace panel are asked different
 * questions, and offering "why is this page slow" over a task board is worse
 * than offering nothing.
 */

import type { QuickfireSuggestion } from "./model";

export interface OpenerContext {
  /** Title of the bound panel, when there is one. */
  title?: string | null;
  /** A browser panel is a page; anything else is a workspace surface. */
  kind?: "browser" | "workspace" | null;
}

export function suggestedOpeners(context: OpenerContext): QuickfireSuggestion[] {
  if (context.kind === "browser") {
    return [
      {
        id: "explain",
        label: "What is this page?",
        prompt: "What is this page, and what is the main thing on it?",
      },
      {
        id: "screenshot",
        label: "Show me what it looks like",
        prompt: "Take a screenshot of this page and describe what stands out.",
      },
      {
        id: "console",
        label: "Any errors?",
        prompt: "Check this page's console for warnings and errors, and explain anything serious.",
      },
    ];
  }
  const subject = context.title ? `“${context.title}”` : "this panel";
  return [
    {
      id: "explain",
      label: "What is this panel doing?",
      prompt: `Describe what ${subject} is showing right now and what state it is in.`,
    },
    {
      id: "console",
      label: "Any errors?",
      prompt: `Check ${subject}'s console for warnings and errors, and explain anything serious.`,
    },
    {
      id: "screenshot",
      label: "Screenshot it",
      prompt: `Take a screenshot of ${subject} and tell me what looks wrong.`,
    },
  ];
}
