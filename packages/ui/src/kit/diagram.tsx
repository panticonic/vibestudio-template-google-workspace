import { useEffect, useRef, useState } from "react";
import { Box, Flex, IconButton, Text, Tooltip } from "@radix-ui/themes";
import { CheckIcon, CopyIcon } from "@radix-ui/react-icons";
import "./diagram.css";

// Lazy-loaded mermaid module (~1.5MB deferred until the first diagram renders),
// mirroring the rehype-highlight / MDX lazy-loading in MessageContent.tsx.
type MermaidApi = typeof import("mermaid").default;
let mermaidApi: MermaidApi | null = null;
let mermaidPromise: Promise<MermaidApi> | null = null;

function getMermaid(): Promise<MermaidApi> {
  if (mermaidApi) return Promise.resolve(mermaidApi);
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      mermaidApi = m.default;
      return mermaidApi;
    });
  }
  return mermaidPromise;
}

let renderSeq = 0;

/**
 * Derive mermaid theme variables from the live Radix Themes CSS custom
 * properties so diagrams match the workspace theme (light/dark + accent)
 * without a hardcoded palette. With `theme: "base"` mermaid derives the many
 * secondary colors it needs from this core set.
 */
function readThemeVariables(el: HTMLElement): {
  dark: boolean;
  themeVariables: Record<string, string | boolean>;
} {
  const styles = getComputedStyle(el);
  const v = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  const dark = el.closest(".dark, .dark-theme") != null;
  return {
    dark,
    themeVariables: {
      darkMode: dark,
      fontFamily: v("--default-font-family", "sans-serif"),
      fontSize: "14px",
      background: v("--color-panel-solid", dark ? "#191919" : "#ffffff"),
      primaryColor: v("--accent-3", dark ? "#1c2b41" : "#e1f0ff"),
      primaryTextColor: v("--gray-12", dark ? "#eeeeee" : "#202020"),
      primaryBorderColor: v("--accent-8", dark ? "#3f6eae" : "#5eb1ef"),
      secondaryColor: v("--gray-4", dark ? "#2a2a2a" : "#e8e8e8"),
      tertiaryColor: v("--gray-3", dark ? "#222222" : "#f0f0f0"),
      lineColor: v("--gray-9", dark ? "#6e6e6e" : "#8d8d8d"),
      textColor: v("--gray-12", dark ? "#eeeeee" : "#202020"),
      mainBkg: v("--accent-3", dark ? "#1c2b41" : "#e1f0ff"),
      nodeBorder: v("--accent-8", dark ? "#3f6eae" : "#5eb1ef"),
      clusterBkg: v("--gray-2", dark ? "#1c1c1c" : "#f9f9f9"),
      clusterBorder: v("--gray-6", dark ? "#3a3a3a" : "#d9d9d9"),
      edgeLabelBackground: v("--color-panel-solid", dark ? "#191919" : "#ffffff"),
    },
  };
}

/** Watch for Radix appearance flips so rendered diagrams re-theme live. */
function useThemeVersion(ref: React.RefObject<HTMLElement | null>): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const themeRoot =
      ref.current?.closest(".radix-themes") ?? document.documentElement;
    const observer = new MutationObserver(() => setVersion((n) => n + 1));
    observer.observe(themeRoot, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [ref]);
  return version;
}

function CopySourceButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip content="Copy diagram source">
      <IconButton
        size="1"
        variant="ghost"
        color="gray"
        aria-label="Copy diagram source"
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </IconButton>
    </Tooltip>
  );
}

/**
 * The source, shown while the diagram loads and instead of it when it fails.
 *
 * Styled by this kit rather than by the chat panel's `.ns-codeblock`, so a
 * surface that renders a diagram is not required to import a whole chat
 * stylesheet to make the fallback legible.
 */
function DiagramSource({ code }: { code: string }) {
  return (
    <pre className="ns-diagram-source">
      <code>{code}</code>
    </pre>
  );
}

export interface MermaidDiagramProps {
  code: string;
}

/**
 * Renders a mermaid diagram from source text.
 *
 * States:
 * - loading: dimmed source in a frame while mermaid loads/renders
 * - rendered: themed SVG (sanitized by mermaid's strict security level)
 * - error: the source plus a compact error note — never crashes the message
 */
export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const themeVersion = useThemeVersion(containerRef);
  const source = code.replace(/\n$/, "");

  useEffect(() => {
    let cancelled = false;
    const host = containerRef.current ?? document.body;
    const id = `ns-mermaid-${++renderSeq}`;
    getMermaid()
      .then(async (mermaid) => {
        const { dark, themeVariables } = readThemeVariables(host);
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          darkMode: dark,
          themeVariables,
        });
        const rendered = await mermaid.render(id, source);
        if (cancelled) return;
        setSvg(rendered.svg);
        setError(null);
      })
      .catch((err: unknown) => {
        // mermaid can leave its scratch element behind on parse failure
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
        if (cancelled) return;
        setSvg(null);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [source, themeVersion]);

  if (error !== null) {
    return (
      <Box my="2" className="ns-diagram-frame ns-diagram-error" ref={containerRef}>
        <Flex className="ns-diagram-toolbar" align="center" justify="between" gap="2">
          <Text size="1" color="red">
            Diagram failed to render
          </Text>
          <CopySourceButton code={source} />
        </Flex>
        <DiagramSource code={source} />
        <Text as="p" size="1" color="gray" className="ns-diagram-error-detail">
          {error}
        </Text>
      </Box>
    );
  }

  if (svg === null) {
    return (
      <Box my="2" className="ns-diagram-frame ns-diagram-loading" ref={containerRef}>
        <Flex className="ns-diagram-toolbar" align="center" justify="between" gap="2">
          <Text size="1" color="gray">
            Rendering diagram…
          </Text>
        </Flex>
        <DiagramSource code={source} />
      </Box>
    );
  }

  return (
    <Box my="2" className="ns-diagram-frame" ref={containerRef}>
      <div className="ns-diagram-actions">
        <CopySourceButton code={source} />
      </div>
      <div
        className="ns-diagram"
        // Sanitized by mermaid (securityLevel: "strict" runs DOMPurify on labels)
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </Box>
  );
}

/**
 * MDX-facing wrapper: <Diagram code={`flowchart TD; A-->B`} /> or with the
 * source as string children. Registered in mdxComponents.
 */
export function Diagram({ code, children }: { code?: string; children?: unknown }) {
  const source = code ?? (typeof children === "string" ? children : "");
  if (!source.trim()) return null;
  return <MermaidDiagram code={source} />;
}
