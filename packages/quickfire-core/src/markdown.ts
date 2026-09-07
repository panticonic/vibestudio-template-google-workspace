/**
 * One Markdown engine for every compact agent surface (spec §4.3, §7.2).
 *
 * The *parsing* is micromark/mdast — the same CommonMark+GFM engine the chat
 * panel's `react-markdown` runs on, so the two venues cannot disagree about what
 * a reply says. What this module owns is the projection into a small, platform
 * neutral tree: the desktop overlay renders it to DOM and the mobile sheet
 * renders the same tree to React Native, and neither can be handed a hast/DOM
 * shape. Everything below the type declarations is that projection.
 *
 * Two rules make it safe to point at model output:
 *
 *  - **Nothing is dropped.** Every mdast node either maps to a node here or
 *    degrades to its own text. Raw HTML/JSX blocks — including MDX we
 *    deliberately do not execute — become an `embed` block that renders
 *    verbatim with a label, so the user sees what the agent wrote and can open
 *    the chat panel to run it.
 *  - **Only destinations we would open become links.** Everything else keeps its
 *    words and loses its href.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { isOpenableLink } from "./links";
import type {
  Definition,
  PhrasingContent,
  Root,
  RootContent,
  TableCell,
  TableRow,
} from "mdast";

export type MarkdownAlign = "left" | "center" | "right" | null;

export type MarkdownInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: MarkdownInline[] }
  | { kind: "emphasis"; children: MarkdownInline[] }
  | { kind: "strike"; children: MarkdownInline[] }
  | { kind: "link"; href: string; children: MarkdownInline[] }
  | { kind: "image"; src: string; alt: string }
  /** An explicit line break inside a paragraph (two trailing spaces, or `\`). */
  | { kind: "break" };

export interface MarkdownListItem {
  /** GFM task state. Absent when the item is not a checkbox item. */
  checked?: boolean;
  children: MarkdownBlock[];
}

export type MarkdownBlock =
  | { kind: "paragraph"; children: MarkdownInline[] }
  | { kind: "heading"; level: number; children: MarkdownInline[] }
  | {
      kind: "list";
      ordered: boolean;
      /** First number of an ordered list; 1 for bullets. */
      start: number;
      /** Tight lists render items as single lines; loose ones get paragraph spacing. */
      tight: boolean;
      items: MarkdownListItem[];
    }
  | { kind: "quote"; children: MarkdownBlock[] }
  | {
      kind: "code";
      text: string;
      /** Info-string language, lowercased; null for an indented or bare fence. */
      language: string | null;
      /** Anything after the language in the info string, e.g. `title="a.ts"`. */
      meta: string | null;
    }
  | {
      kind: "table";
      align: MarkdownAlign[];
      head: MarkdownInline[][];
      rows: MarkdownInline[][][];
    }
  | { kind: "rule" }
  /** Verbatim markup this venue shows but never executes (HTML, JSX, MDX). */
  | { kind: "embed"; text: string; label: string };


/** Fenced languages we label as un-runnable markup rather than pretend to render. */
const EMBED_LANGUAGES = new Set(["html", "svg", "jsx", "tsx", "mdx"]);

export function parseMarkdown(source: string): MarkdownBlock[] {
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return blocksOf(tree, definitionsOf(tree));
}

/**
 * Parse a fragment as running text.
 *
 * Convenience for the places that hold one line rather than a document — and
 * the seam the inline tests drive. Block structure inside the fragment is
 * flattened, because the caller has already decided this is a line.
 */
export function parseInline(source: string): MarkdownInline[] {
  return parseMarkdown(source).flatMap((block) =>
    block.kind === "paragraph" || block.kind === "heading"
      ? block.children
      : [{ kind: "text" as const, text: markdownToPlainText([block]) }]
  );
}

/** Flatten a parsed document to text, for aria labels, previews and copy. */
export function markdownToPlainText(blocks: readonly MarkdownBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "paragraph":
      case "heading":
        parts.push(inlineToPlainText(block.children));
        break;
      case "list":
        for (const [index, item] of block.items.entries()) {
          const marker = block.ordered ? `${block.start + index}.` : "•";
          const box = item.checked === undefined ? "" : item.checked ? "[x] " : "[ ] ";
          parts.push(`${marker} ${box}${markdownToPlainText(item.children)}`);
        }
        break;
      case "quote":
        parts.push(markdownToPlainText(block.children));
        break;
      case "code":
      case "embed":
        parts.push(block.text);
        break;
      case "table":
        parts.push(block.head.map(inlineToPlainText).join(" · "));
        for (const row of block.rows) parts.push(row.map(inlineToPlainText).join(" · "));
        break;
      case "rule":
        parts.push("—");
        break;
    }
  }
  return parts.join("\n").trim();
}

export function inlineToPlainText(nodes: readonly MarkdownInline[]): string {
  let text = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
      case "code":
        text += node.text;
        break;
      case "image":
        text += node.alt;
        break;
      case "break":
        text += "\n";
        break;
      default:
        text += inlineToPlainText(node.children);
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// mdast → the platform-neutral tree
// ---------------------------------------------------------------------------

/**
 * Link/image definitions, so reference-style links resolve.
 *
 * mdast leaves `[text][label]` as a reference plus a separate definition node;
 * resolving them here is the difference between a working link and the literal
 * brackets the surface used to show.
 */
type Definitions = Map<string, Definition>;

function definitionsOf(tree: Root): Definitions {
  const definitions: Definitions = new Map();
  const visit = (nodes: readonly RootContent[]) => {
    for (const node of nodes) {
      if (node.type === "definition") definitions.set(node.identifier, node);
      if ("children" in node && Array.isArray(node.children)) {
        visit(node.children as RootContent[]);
      }
    }
  };
  visit(tree.children);
  return definitions;
}

function blocksOf(
  parent: { children: readonly RootContent[] },
  definitions: Definitions
): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  for (const node of parent.children) {
    const block = blockOf(node, definitions);
    if (block) blocks.push(block);
  }
  return blocks;
}

function blockOf(node: RootContent, definitions: Definitions): MarkdownBlock | null {
  switch (node.type) {
    case "paragraph":
      return { kind: "paragraph", children: inlinesOf(node.children, definitions) };
    case "heading":
      return {
        kind: "heading",
        level: node.depth,
        children: inlinesOf(node.children, definitions),
      };
    case "blockquote":
      return { kind: "quote", children: blocksOf(node, definitions) };
    case "thematicBreak":
      return { kind: "rule" };
    case "code": {
      const language = node.lang?.toLowerCase() ?? null;
      if (language && EMBED_LANGUAGES.has(language)) {
        // Shown, never run. The label is what stops it reading as broken output.
        return { kind: "embed", text: node.value, label: language.toUpperCase() };
      }
      return { kind: "code", text: node.value, language, meta: node.meta ?? null };
    }
    case "html":
      return { kind: "embed", text: node.value, label: "HTML" };
    case "list":
      return {
        kind: "list",
        ordered: node.ordered === true,
        start: node.start ?? 1,
        tight: node.spread !== true,
        items: node.children.map((item) => ({
          ...(typeof item.checked === "boolean" ? { checked: item.checked } : {}),
          children: blocksOf(item, definitions),
        })),
      };
    case "table": {
      const [head, ...rows] = node.children;
      if (!head) return null;
      return {
        kind: "table",
        align: (node.align ?? []).map((value) => value ?? null),
        head: cellsOf(head, definitions),
        rows: rows.map((row) => cellsOf(row, definitions)),
      };
    }
    // A definition is the *target* of a reference, not content of its own; it is
    // consumed by `definitionsOf` and would otherwise render as a stray line.
    case "definition":
      return null;
    case "footnoteDefinition":
      return {
        kind: "quote",
        children: blocksOf(node, definitions),
      };
    default:
      return null;
  }
}

function cellsOf(row: TableRow, definitions: Definitions): MarkdownInline[][] {
  return row.children.map((cell: TableCell) => inlinesOf(cell.children, definitions));
}

function inlinesOf(
  nodes: readonly PhrasingContent[],
  definitions: Definitions
): MarkdownInline[] {
  const inlines: MarkdownInline[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        inlines.push({ kind: "text", text: node.value });
        break;
      case "inlineCode":
        inlines.push({ kind: "code", text: node.value });
        break;
      case "strong":
        inlines.push({ kind: "strong", children: inlinesOf(node.children, definitions) });
        break;
      case "emphasis":
        inlines.push({ kind: "emphasis", children: inlinesOf(node.children, definitions) });
        break;
      case "delete":
        inlines.push({ kind: "strike", children: inlinesOf(node.children, definitions) });
        break;
      case "break":
        inlines.push({ kind: "break" });
        break;
      case "link":
        inlines.push(...linkOf(node.url, inlinesOf(node.children, definitions)));
        break;
      case "linkReference": {
        const target = definitions.get(node.identifier);
        const children = inlinesOf(node.children, definitions);
        inlines.push(...(target ? linkOf(target.url, children) : children));
        break;
      }
      case "image":
        inlines.push({ kind: "image", src: node.url, alt: node.alt ?? "" });
        break;
      case "imageReference": {
        const target = definitions.get(node.identifier);
        if (target) inlines.push({ kind: "image", src: target.url, alt: node.alt ?? "" });
        else if (node.alt) inlines.push({ kind: "text", text: node.alt });
        break;
      }
      case "footnoteReference":
        inlines.push({ kind: "text", text: `[^${node.label ?? node.identifier}]` });
        break;
      // Inline HTML is text here: this venue does not execute markup, and
      // swallowing it would silently edit what the agent said.
      case "html":
        inlines.push({ kind: "text", text: node.value });
        break;
      // No default: `PhrasingContent` is exhausted above, and the compiler is
      // what keeps it that way. A new inline node type — from a Markdown
      // extension we enable later — becomes a type error here rather than
      // content that quietly disappears from the transcript.
    }
  }
  return inlines;
}

/**
 * A destination we will not open is not a link — but its words still render.
 *
 * "Will not open" is the workspace's own address grammar (`./links`), so a
 * panel link an agent writes is a link here, not a paragraph of literal text.
 */
function linkOf(url: string, children: MarkdownInline[]): MarkdownInline[] {
  return isOpenableLink(url) ? [{ kind: "link", href: url, children }] : children;
}
