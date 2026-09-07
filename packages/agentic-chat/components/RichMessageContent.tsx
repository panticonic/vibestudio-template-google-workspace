import React, { type ComponentType, type ReactNode, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Text } from "@radix-ui/themes";
import * as runtime from "react/jsx-runtime";
import {
  createMdxComponents,
  markdownComponents,
  streamingMarkdownComponents,
  type MdxActionHandlers,
} from "./markdownComponents";

interface RichMessageContentProps {
  content: string;
  isStreaming: boolean;
  mdxActions?: MdxActionHandlers;
}

let mdxModule: typeof import("@mdx-js/mdx") | null = null;
async function getMdx() {
  if (!mdxModule) {
    try {
      mdxModule = await import("@mdx-js/mdx");
    } catch (error) {
      throw new Error(
        `Failed to load MDX: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return mdxModule;
}

const remarkPlugins = [remarkGfm];

class MdxRenderErrorBoundary extends React.Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.debug("MDX render failed, using plain-text fallback:", error);
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

function PlainTextMessageContent({ content }: { content: string }) {
  return (
    <div className="message-prose">
      <Text as="div" size="2" style={{ whiteSpace: "pre-wrap" }}>
        {content}
      </Text>
    </div>
  );
}

type RehypeHighlightPlugin = typeof import("rehype-highlight").default;
let rehypeHighlightPlugin: RehypeHighlightPlugin | null = null;
let rehypeHighlightPromise: Promise<RehypeHighlightPlugin> | null = null;

function getRehypeHighlight(): Promise<RehypeHighlightPlugin> {
  if (rehypeHighlightPlugin) return Promise.resolve(rehypeHighlightPlugin);
  if (!rehypeHighlightPromise) {
    rehypeHighlightPromise = import("rehype-highlight").then((module) => {
      rehypeHighlightPlugin = module.default;
      return rehypeHighlightPlugin;
    });
  }
  return rehypeHighlightPromise;
}

async function compileMdx(
  content: string,
  rehypeHighlight: RehypeHighlightPlugin | null,
  mdxActions?: MdxActionHandlers
): Promise<ComponentType | null> {
  const rehypePlugins = rehypeHighlight
    ? ([[rehypeHighlight, { ignoreMissing: true }]] as [
        RehypeHighlightPlugin,
        { ignoreMissing: boolean },
      ][])
    : [];
  const { evaluate } = await getMdx();
  const { default: Component } = await evaluate(content, {
    ...runtime,
    development: false,
    useMDXComponents: (() => createMdxComponents(mdxActions)) as never,
    remarkPlugins,
    rehypePlugins,
  });
  return Component as ComponentType;
}

const BLOCK_CODE_RE = /(?:^|\n)[ \t]*(?:```|~~~)|(?:^|\n)(?: {4}|\t)\S/m;

export const RichMessageContent = React.memo(function RichMessageContent({
  content,
  isStreaming,
  mdxActions,
}: RichMessageContentProps) {
  const [MdxComponent, setMdxComponent] = useState<ComponentType | null>(null);
  const [highlightLoaded, setHighlightLoaded] = useState<RehypeHighlightPlugin | null>(
    rehypeHighlightPlugin
  );
  const hasJsx = /<[A-Z]/.test(content);
  const needsHighlight = !isStreaming && BLOCK_CODE_RE.test(content);

  useEffect(() => {
    if (!needsHighlight || rehypeHighlightPlugin) return;
    void getRehypeHighlight().then(setHighlightLoaded);
  }, [needsHighlight]);

  useEffect(() => {
    if (isStreaming || !hasJsx) {
      setMdxComponent(null);
      return;
    }
    if (needsHighlight && !highlightLoaded) return;

    let cancelled = false;
    compileMdx(content, highlightLoaded, mdxActions)
      .then((Component) => {
        if (!cancelled) setMdxComponent(() => Component);
      })
      .catch((error) => {
        if (!cancelled) {
          console.debug("MDX compilation failed, using markdown fallback:", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [content, hasJsx, highlightLoaded, isStreaming, mdxActions, needsHighlight]);

  if (MdxComponent) {
    return (
      <MdxRenderErrorBoundary
        key={content}
        fallback={<PlainTextMessageContent content={content} />}
      >
        <div className="message-prose">
          <MdxComponent />
        </div>
      </MdxRenderErrorBoundary>
    );
  }

  const rehypePlugins =
    !isStreaming && highlightLoaded
      ? ([[highlightLoaded, { ignoreMissing: true }]] as [
          RehypeHighlightPlugin,
          { ignoreMissing: boolean },
        ][])
      : [];

  return (
    <div className="message-prose">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={isStreaming ? streamingMarkdownComponents : markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
