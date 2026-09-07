/**
 * ErrorBoundary - Generic error boundary for feedback components.
 *
 * Catches rendering errors, notifies the parent via callback,
 * and displays a visible error message instead of silently rendering nothing.
 */

import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Called when an error is caught - parent should remove this component */
  onError: (error: Error) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, errorMessage: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, errorMessage: error.message };
  }

  componentDidCatch(error: Error): void {
    this.props.onError(error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: 6,
            background: "var(--intent-error-surface, var(--red-a3))",
            border: "1px solid var(--intent-error-border, var(--red-a6))",
            color: "var(--intent-error-text, var(--red-11))",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <strong>Component render error</strong>
          {this.state.errorMessage && (
            <div style={{ marginTop: 4, fontFamily: "monospace", fontSize: 12 }}>
              {this.state.errorMessage}
            </div>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
