import type { ComponentType, ReactNode } from "react";
import type { Root } from "react-dom/client";
import { panel } from "@workspace/runtime";

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

export interface ReactPanelOptions {
  rootId?: string;
  ThemeComponent?: ComponentType<{ appearance: "light" | "dark"; children?: ReactNode }>;
}

type ReactNamespace = typeof import("react");
type CreateRootFn = typeof import("react-dom/client").createRoot;

export interface ReactPanelInstance<Props> {
  update: (nextProps?: Props) => void;
  unmount: () => void;
  root: Root;
}

function getPanelErrorDiagnosticLauncher(): PanelErrorDiagnosticLauncher | null {
  const g = globalThis as typeof globalThis & PanelErrorDiagnosticLauncherGlobal;
  return typeof g.__vibestudioPanelErrorDiagnostics === "function"
    ? g.__vibestudioPanelErrorDiagnostics
    : null;
}

export function createReactPanelMount(
  ReactLib: ReactNamespace,
  createRootFn: CreateRootFn,
  options?: ReactPanelOptions
) {
  const rootId = options?.rootId ?? "root";
  const ThemeProvider = options?.ThemeComponent
    ? (() => {
        const ThemeComponent = options.ThemeComponent!;
        return function vibestudioRadixThemeProvider({
          children,
        }: {
          children?: ReactNode;
        }): ReactNode {
          const [theme, setTheme] = ReactLib.useState(() => panel.getTheme());

          ReactLib.useEffect(() => {
            let mounted = true;
            const unsubscribe = panel.onThemeChange((nextTheme) => {
              if (mounted) setTheme(nextTheme);
            });
            return () => {
              mounted = false;
              unsubscribe();
            };
          }, []);

          return ReactLib.createElement(ThemeComponent, { appearance: theme }, children);
        };
      })()
    : null;

  function ConnectionErrorBarrier({ children }: { children: ReactNode }): ReactNode {
    const [connError, setConnError] = ReactLib.useState<{
      code: number;
      reason: string;
      source?: "electron" | "server";
    } | null>(null);

    ReactLib.useEffect(() => {
      return panel.onConnectionError((err) => setConnError(err));
    }, []);

    if (connError) {
      if (connError.source === "server") {
        // Non-blocking banner — panel is still functional for navigation/UI
        return ReactLib.createElement(
          ReactLib.Fragment,
          null,
          ReactLib.createElement(
            "div",
            {
              style: {
                padding: "8px 16px",
                background: "var(--intent-warning-surface, #fef3cd)",
                color: "var(--intent-warning, #856404)",
                fontSize: 13,
                textAlign: "center",
                borderBottom: "1px solid var(--intent-warning-border, #ffc107)",
              },
            },
            `Backend unavailable: ${connError.reason}`
          ),
          children
        );
      }
      // Full-screen overlay — panel is disconnected from the app
      return ReactLib.createElement(
        "div",
        {
          style: {
            position: "fixed",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--color-background, #fff)",
            color: "var(--color-text, #111)",
            fontFamily: "system-ui, sans-serif",
            zIndex: 2147483647,
          },
        },
        ReactLib.createElement(
          "div",
          { style: { textAlign: "center", maxWidth: 400, padding: 24 } },
          ReactLib.createElement(
            "div",
            { style: { fontSize: 18, fontWeight: 600, marginBottom: 8 } },
            "Connection lost"
          ),
          ReactLib.createElement(
            "div",
            { style: { fontSize: 14, opacity: 0.7 } },
            connError.reason
          ),
          ReactLib.createElement(
            "button",
            {
              type: "button",
              onClick: () => globalThis.location?.reload(),
              style: {
                marginTop: 16,
                padding: "8px 14px",
                borderRadius: 6,
                border: "1px solid currentColor",
                background: "transparent",
                color: "inherit",
                cursor: "pointer",
              },
            },
            "Retry panel"
          )
        )
      );
    }

    return ReactLib.createElement(ReactLib.Fragment, null, children);
  }

  interface RenderErrorBoundaryProps {
    children: ReactNode;
  }

  interface RenderErrorBoundaryState {
    error: Error | null;
    errorInfo: { componentStack?: string } | null;
    debugChatOpening: boolean;
    debugChatOpened: boolean;
    debugChatError: string | null;
  }

  class RenderErrorBoundary extends ReactLib.Component<
    RenderErrorBoundaryProps,
    RenderErrorBoundaryState
  > {
    state: RenderErrorBoundaryState = {
      error: null,
      errorInfo: null,
      debugChatOpening: false,
      debugChatOpened: false,
      debugChatError: null,
    };

    static getDerivedStateFromError(error: Error): Partial<RenderErrorBoundaryState> {
      return { error };
    }

    componentDidCatch(error: Error, errorInfo: { componentStack?: string }): void {
      console.error("[ReactPanel] render error caught:", error);
      console.error("[ReactPanel] component stack:", errorInfo.componentStack);
      this.setState({ errorInfo });
    }

    handleRetry = (): void => {
      this.setState({
        error: null,
        errorInfo: null,
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
          surfaceName: "panel",
          errorName: error?.name,
          errorMessage: error?.message ?? String(error ?? "Unknown error"),
          errorStack: error?.stack,
          componentStack: this.state.errorInfo?.componentStack,
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
      if (!this.state.error) return this.props.children;
      const diagnosticLauncherAvailable = getPanelErrorDiagnosticLauncher() !== null;
      return ReactLib.createElement(
        "div",
        {
          style: {
            minHeight: "100dvh",
            boxSizing: "border-box",
            padding: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--color-background, #1a1a1a)",
            color: "var(--gray-12, #e0e0e0)",
            fontFamily: "system-ui, -apple-system, sans-serif",
          },
        },
        ReactLib.createElement(
          "div",
          { style: { maxWidth: 560, textAlign: "center" } },
          ReactLib.createElement(
            "h2",
            { style: { color: "var(--red-11, #f44336)", marginBottom: 16 } },
            "Something went wrong"
          ),
          ReactLib.createElement(
            "p",
            { style: { marginBottom: 16, opacity: 0.8 } },
            "The panel encountered an error. You can debug it with an agent, try to recover, or reload the panel."
          ),
          ReactLib.createElement(
            "details",
            {
              style: {
                marginBottom: 16,
                textAlign: "left",
                background: "var(--gray-3, #2a2a2a)",
                padding: 12,
                borderRadius: 8,
                fontSize: 12,
              },
            },
            ReactLib.createElement(
              "summary",
              { style: { cursor: "pointer", marginBottom: 8 } },
              "Error details"
            ),
            ReactLib.createElement(
              "pre",
              {
                style: {
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  margin: 0,
                  color: "var(--red-11, #f44336)",
                },
              },
              this.state.error.toString()
            ),
            this.state.errorInfo?.componentStack
              ? ReactLib.createElement(
                  "pre",
                  {
                    style: {
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      margin: "8px 0 0 0",
                      opacity: 0.7,
                      fontSize: 10,
                    },
                  },
                  this.state.errorInfo.componentStack
                )
              : null
          ),
          ReactLib.createElement(
            "div",
            { style: { display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "center" } },
            diagnosticLauncherAvailable
              ? ReactLib.createElement(
                  "button",
                  {
                    onClick: () => {
                      void this.handleDebugWithAgent();
                    },
                    disabled: this.state.debugChatOpening,
                    style: {
                      padding: "8px 16px",
                      background: "var(--accent-9, #4a9eff)",
                      color: "white",
                      border: "none",
                      borderRadius: 6,
                      cursor: this.state.debugChatOpening ? "default" : "pointer",
                      fontSize: 14,
                      opacity: this.state.debugChatOpening ? 0.8 : 1,
                    },
                  },
                  this.state.debugChatOpening
                    ? "Opening..."
                    : this.state.debugChatOpened
                      ? "Debug Chat Opened"
                      : "Debug with Agent"
                )
              : null,
            ReactLib.createElement(
              "button",
              {
                onClick: this.handleRetry,
                style: {
                  padding: "8px 16px",
                  background: "var(--gray-4, #3a3a3a)",
                  color: "var(--gray-12, #e0e0e0)",
                  border: "1px solid var(--gray-6, #444)",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 14,
                },
              },
              "Try Again"
            ),
            ReactLib.createElement(
              "button",
              {
                onClick: () => window.location.reload(),
                style: {
                  padding: "8px 16px",
                  background: "var(--gray-4, #3a3a3a)",
                  color: "var(--gray-12, #e0e0e0)",
                  border: "1px solid var(--gray-6, #444)",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 14,
                },
              },
              "Reload Panel"
            )
          ),
          this.state.debugChatError
            ? ReactLib.createElement(
                "p",
                {
                  style: {
                    margin: "12px 0 0",
                    color: "var(--red-11, #f44336)",
                    fontSize: 12,
                    overflowWrap: "anywhere",
                  },
                },
                this.state.debugChatError
              )
            : null
        )
      );
    }
  }

  const Wrapper: ComponentType<{ children: ReactNode }> = ThemeProvider
    ? ({ children }) =>
        ReactLib.createElement(
          ConnectionErrorBarrier,
          null,
          ReactLib.createElement(ThemeProvider, null, children)
        )
    : ({ children }) => ReactLib.createElement(ConnectionErrorBarrier, null, children);

  return function mountReactPanel<Props>(
    Component: ComponentType<Props>,
    initialProps?: Props
  ): ReactPanelInstance<Props> {
    const container = document.getElementById(rootId);
    if (!container) {
      throw new Error(`React root element '#${rootId}' not found in panel DOM`);
    }

    const existingRoot = (container as any)._reactRoot;
    const root = existingRoot ?? createRootFn(container);
    if (!existingRoot) {
      (container as any)._reactRoot = root;
    }
    let currentProps = initialProps ?? ({} as Props);

    const render = (nextProps?: Props) => {
      if (nextProps) {
        currentProps = nextProps;
      }

      root.render(
        ReactLib.createElement(
          RenderErrorBoundary,
          null,
          ReactLib.createElement(
            Wrapper,
            null,
            ReactLib.createElement(Component as ComponentType<any>, currentProps as any)
          )
        )
      );
    };

    render(currentProps);

    return {
      update: render,
      unmount: () => root.unmount(),
      root,
    };
  };
}
