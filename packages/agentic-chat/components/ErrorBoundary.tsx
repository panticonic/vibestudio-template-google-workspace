import React, { Component, type ReactNode } from "react";

interface PanelRenderErrorDiagnosticRequest {
  surfaceName?: string;
  errorName?: string;
  errorMessage: string;
  errorStack?: string;
  componentStack?: string;
  locationHref?: string;
  userAgent?: string;
  timestamp?: string;
}

interface PanelErrorDiagnosticChatResult {
  panelId: string;
  title: string;
  prompt: string;
}

type PanelErrorDiagnosticLauncher = (
  request: PanelRenderErrorDiagnosticRequest
) => Promise<PanelErrorDiagnosticChatResult>;

interface PanelErrorDiagnosticLauncherGlobal {
  __vibestudioPanelErrorDiagnostics?: PanelErrorDiagnosticLauncher;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  surfaceName?: string;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  autoReloading: boolean;
  debugChatOpening: boolean;
  debugChatOpened: boolean;
  debugChatError: string | null;
}

const TRANSIENT_IMPORT_ERROR_RE =
  /failed to fetch dynamically imported module|error loading dynamically imported module|loading chunk \d+ failed|importing a module script failed/i;
const AUTO_RELOAD_STORAGE_KEY = "__vibestudioTransientImportReload";
const AUTO_RELOAD_WINDOW_MS = 30_000;

function isTransientImportError(error: Error): boolean {
  const text = `${error.name}\n${error.message}\n${error.stack ?? ""}`;
  return TRANSIENT_IMPORT_ERROR_RE.test(text);
}

function getPanelErrorDiagnosticLauncher(): PanelErrorDiagnosticLauncher | null {
  const g = globalThis as typeof globalThis & PanelErrorDiagnosticLauncherGlobal;
  return typeof g.__vibestudioPanelErrorDiagnostics === "function"
    ? g.__vibestudioPanelErrorDiagnostics
    : null;
}

function shouldAutoReloadForTransientImport(): boolean {
  try {
    const now = Date.now();
    const marker = window.sessionStorage.getItem(AUTO_RELOAD_STORAGE_KEY);
    if (marker) {
      const parsed = JSON.parse(marker) as { href?: unknown; at?: unknown };
      if (
        parsed.href === window.location.href &&
        typeof parsed.at === "number" &&
        now - parsed.at < AUTO_RELOAD_WINDOW_MS
      ) {
        return false;
      }
    }
    window.sessionStorage.setItem(
      AUTO_RELOAD_STORAGE_KEY,
      JSON.stringify({
        href: window.location.href,
        at: now,
      })
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Error boundary component to catch React rendering errors and prevent
 * the entire app from unmounting. Shows an error UI instead of a blank page.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      autoReloading: false,
      debugChatOpening: false,
      debugChatOpened: false,
      debugChatError: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("[Chat ErrorBoundary] React error caught:", error);
    console.error("[Chat ErrorBoundary] Component stack:", errorInfo.componentStack);

    this.setState({ errorInfo });
    this.props.onError?.(error, errorInfo);

    if (isTransientImportError(error) && shouldAutoReloadForTransientImport()) {
      this.setState({ autoReloading: true });
      window.setTimeout(() => window.location.reload(), 250);
    }
  }

  handleRetry = (): void => {
    try {
      window.sessionStorage.removeItem(AUTO_RELOAD_STORAGE_KEY);
    } catch {
      // Ignore storage failures; retry should still re-render.
    }
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      autoReloading: false,
      debugChatOpening: false,
      debugChatOpened: false,
      debugChatError: null,
    });
  };

  handleDebugWithAgent = async (): Promise<void> => {
    const launcher = getPanelErrorDiagnosticLauncher();
    if (!launcher) {
      this.setState({ debugChatError: "Panel diagnostics are not available in this host." });
      return;
    }
    const error = this.state.error;
    this.setState({ debugChatOpening: true, debugChatError: null });
    try {
      await launcher({
        surfaceName: this.props.surfaceName ?? "panel",
        errorName: error?.name,
        errorMessage: error?.message ?? String(error ?? "Unknown error"),
        errorStack: error?.stack,
        componentStack: this.state.errorInfo?.componentStack ?? undefined,
        locationHref: typeof window !== "undefined" ? window.location.href : undefined,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
        timestamp: new Date().toISOString(),
      });
      this.setState({ debugChatOpening: false, debugChatOpened: true });
    } catch (err) {
      this.setState({
        debugChatOpening: false,
        debugChatError: err instanceof Error ? err.message : String(err),
      });
    }
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const surfaceName = this.props.surfaceName ?? "panel";
      const diagnosticLauncherAvailable = getPanelErrorDiagnosticLauncher() !== null;
      return (
        <div
          style={{
            padding: "20px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            backgroundColor: "var(--agentic-surface, var(--surface-panel))",
            color: "var(--agentic-text, var(--gray-12))",
            fontFamily: "system-ui, -apple-system, sans-serif",
          }}
        >
          <div
            style={{
              maxWidth: "500px",
              textAlign: "center",
            }}
          >
            <h2 style={{ color: "var(--intent-error-text, var(--red-11))", marginBottom: "16px" }}>
              Something went wrong
            </h2>
            <p style={{ marginBottom: "16px", opacity: 0.8 }}>
              {this.state.autoReloading
                ? `The ${surfaceName} hit a transient network error while loading. Reloading...`
                : `The ${surfaceName} encountered an error. You can debug it with an agent, try to recover, or reload the panel.`}
            </p>
            <details
              style={{
                marginBottom: "16px",
                textAlign: "left",
                backgroundColor: "var(--agentic-surface-card, var(--surface-card))",
                padding: "12px",
                borderRadius: "8px",
                fontSize: "12px",
              }}
            >
              <summary style={{ cursor: "pointer", marginBottom: "8px" }}>Error details</summary>
              <pre
                style={{
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  margin: 0,
                  color: "var(--intent-error-text, var(--red-11))",
                }}
              >
                {this.state.error?.toString()}
              </pre>
              {this.state.errorInfo?.componentStack && (
                <pre
                  style={{
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    margin: "8px 0 0 0",
                    opacity: 0.7,
                    fontSize: "10px",
                  }}
                >
                  {this.state.errorInfo.componentStack}
                </pre>
              )}
            </details>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "12px",
                justifyContent: "center",
              }}
            >
              {diagnosticLauncherAvailable && (
                <button
                  onClick={() => {
                    void this.handleDebugWithAgent();
                  }}
                  disabled={this.state.debugChatOpening}
                  style={{
                    padding: "8px 16px",
                    backgroundColor: "var(--agentic-player-accent, var(--accent-9))",
                    color: "var(--accent-contrast)",
                    border: "none",
                    borderRadius: "6px",
                    cursor: this.state.debugChatOpening ? "default" : "pointer",
                    fontSize: "14px",
                    opacity: this.state.debugChatOpening ? 0.8 : 1,
                  }}
                >
                  {this.state.debugChatOpening
                    ? "Opening..."
                    : this.state.debugChatOpened
                      ? "Debug Chat Opened"
                      : "Debug with Agent"}
                </button>
              )}
              <button
                onClick={this.handleRetry}
                style={{
                  padding: "8px 16px",
                  backgroundColor: "var(--agentic-surface-card, var(--surface-card))",
                  color: "var(--agentic-text, var(--gray-12))",
                  border: "1px solid var(--agentic-border, var(--surface-border))",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontSize: "14px",
                }}
              >
                Try Again
              </button>
              <button
                onClick={() => window.location.reload()}
                style={{
                  padding: "8px 16px",
                  backgroundColor: "var(--agentic-surface-card, var(--surface-card))",
                  color: "var(--agentic-text, var(--gray-12))",
                  border: "1px solid var(--agentic-border, var(--surface-border))",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontSize: "14px",
                }}
              >
                Reload Panel
              </button>
            </div>
            {this.state.debugChatError && (
              <p
                style={{
                  margin: "12px 0 0",
                  color: "var(--intent-error-text, var(--red-11))",
                  fontSize: "12px",
                  overflowWrap: "anywhere",
                }}
              >
                {this.state.debugChatError}
              </p>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
