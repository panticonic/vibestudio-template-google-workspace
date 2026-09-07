/**
 * FeedbackContainer - Wrapper for feedback UI components.
 *
 * Sizes to content naturally with a max-height cap. Provides error boundary,
 * dismiss button, consistent styling, and scrollable content area.
 * Draggable top edge for manual resizing when needed.
 */

import { type ReactNode } from "react";
import { SurfaceFrame } from "./SurfaceFrame";

export interface FeedbackContainerProps {
  /** The feedback component to render */
  children: ReactNode;
  /** Called when user clicks the X button */
  onDismiss?: () => void;
  /** Called when the component throws during render */
  onError: (error: Error) => void;
  /** Title displayed in the container header (default: "Agent requires input") */
  title?: string;
  /** Maximum height as fraction of viewport (default: 0.5) */
  maxHeightFraction?: number;
  /** Minimum height when resizing (default: 100px) */
  minHeight?: number;
}

export function FeedbackContainer({
  children,
  onDismiss,
  onError,
  title = "Agent requires input",
  maxHeightFraction = 0.5,
  minHeight = 100,
}: FeedbackContainerProps) {
  return (
    <SurfaceFrame
      title={title}
      tone="blue"
      resizable
      maxHeightFraction={maxHeightFraction}
      minHeight={minHeight}
      onDismiss={onDismiss}
      onError={onError}
    >
      {children}
    </SurfaceFrame>
  );
}
