/**
 * One Markdown renderer, drawn against the primitive contract.
 *
 * The parser (`../markdown`) decides what the text *is*; this decides what it
 * looks like — once, for both clients. Everything it can render, it renders;
 * everything it will not execute (raw HTML, JSX, MDX) it shows verbatim with a
 * label, because a card the agent wrote and the user cannot see is worse than an
 * ugly one.
 */

import { Fragment, type ReactNode } from "react";
import { parseMarkdown, type MarkdownBlock, type MarkdownInline } from "../markdown";
import { useSkin } from "./primitives";

export function Markdown({
  source,
  caret,
}: {
  source: string;
  /** Append the live-text cursor to the last line (a streaming reply). */
  caret?: boolean;
}) {
  return <Blocks blocks={parseMarkdown(source)} {...(caret ? { caret } : {})} />;
}

export function Blocks({
  blocks,
  caret,
}: {
  blocks: readonly MarkdownBlock[];
  caret?: boolean;
}) {
  const { Box } = useSkin();
  const last = blocks.length - 1;
  return (
    <Box gap="sm">
      {blocks.map((block, index) => (
        <Block
          key={`${block.kind}:${index}`}
          block={block}
          {...(caret && index === last ? { caret } : {})}
        />
      ))}
    </Box>
  );
}

function Block({ block, caret }: { block: MarkdownBlock; caret?: boolean }) {
  const { Box, Text, Code, Divider, Caret } = useSkin();
  switch (block.kind) {
    case "paragraph":
      return (
        <Text>
          <Inlines nodes={block.children} />
          {caret ? <Caret /> : null}
        </Text>
      );
    case "heading":
      return (
        <Text variant={block.level <= 2 ? "heading" : "strong"}>
          <Inlines nodes={block.children} />
        </Text>
      );
    case "code":
      return <Code text={block.text} language={block.language} caption={block.meta} />;
    case "embed":
      // Shown, never run. The label is what stops it reading as broken output.
      return <Code text={block.text} language={block.label.toLowerCase()} caption={block.label} />;
    case "rule":
      return <Divider />;
    case "quote":
      return (
        <Box surface="rail" pad="sm" gap="xs" tone="neutral">
          <Blocks blocks={block.children} />
        </Box>
      );
    case "list":
      return <List block={block} />;
    case "table":
      return <Table block={block} />;
  }
}

function List({ block }: { block: Extract<MarkdownBlock, { kind: "list" }> }) {
  const { Box, Text } = useSkin();
  return (
    <Box gap={block.tight ? "xs" : "sm"}>
      {block.items.map((item, index) => (
        <Box key={index} row gap="sm" align="baseline">
          <Text tone="muted" variant="caption">
            {item.checked === undefined
              ? block.ordered
                ? `${block.start + index}.`
                : "•"
              : item.checked
                ? "☑"
                : "☐"}
          </Text>
          <Box gap="xs" grow>
            <Blocks blocks={item.children} />
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function Table({ block }: { block: Extract<MarkdownBlock, { kind: "table" }> }) {
  const { Box, Text } = useSkin();
  return (
    <Box surface="outline" gap="none" testId="quickfire-table">
      <Box row gap="sm" pad="sm" surface="sunken">
        {block.head.map((cell, index) => (
          <Box key={index} grow>
            <Text variant="label">
              <Inlines nodes={cell} />
            </Text>
          </Box>
        ))}
      </Box>
      {block.rows.map((row, rowIndex) => (
        <Box key={rowIndex} row gap="sm" pad="sm">
          {row.map((cell, index) => (
            <Box key={index} grow>
              <Text variant="caption">
                <Inlines nodes={cell} />
              </Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

export function Inlines({ nodes }: { nodes: readonly MarkdownInline[] }): ReactNode {
  return nodes.map((node, index) => <Inline key={index} node={node} />);
}

function Inline({ node }: { node: MarkdownInline }): ReactNode {
  const { Text, Pressable, Image, Break, openUrl } = useSkin();
  switch (node.kind) {
    case "text":
      return <Fragment>{node.text}</Fragment>;
    case "code":
      return <Text variant="code">{node.text}</Text>;
    case "strong":
      return (
        <Text variant="strong">
          <Inlines nodes={node.children} />
        </Text>
      );
    case "emphasis":
      return (
        <Text variant="emphasis">
          <Inlines nodes={node.children} />
        </Text>
      );
    case "strike":
      return (
        <Text variant="strike" tone="muted">
          <Inlines nodes={node.children} />
        </Text>
      );
    case "link":
      return (
        <Pressable
          variant="quiet"
          tone="accent"
          href={node.href}
          label={`Open ${node.href}`}
          onPress={() => openUrl?.(node.href)}
        >
          <Text tone="accent">
            <Inlines nodes={node.children} />
          </Text>
        </Pressable>
      );
    case "image":
      if (Image) return <Image src={node.src} alt={node.alt} />;
      return <Text tone="muted">{node.alt ? `🖼 ${node.alt}` : "🖼 image"}</Text>;
    case "break":
      return Break ? <Break /> : <Fragment>{"\n"}</Fragment>;
  }
}
