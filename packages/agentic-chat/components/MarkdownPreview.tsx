import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const remarkPlugins = [remarkGfm];

function PreviewBlock({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return <span className={className}>{children} </span>;
}

const markdownPreviewComponents: Components = {
  p: ({ children }) => <PreviewBlock className="markdown-preview-block">{children}</PreviewBlock>,
  h1: ({ children }) => <PreviewBlock className="markdown-preview-heading">{children}</PreviewBlock>,
  h2: ({ children }) => <PreviewBlock className="markdown-preview-heading">{children}</PreviewBlock>,
  h3: ({ children }) => <PreviewBlock className="markdown-preview-heading">{children}</PreviewBlock>,
  h4: ({ children }) => <PreviewBlock className="markdown-preview-heading">{children}</PreviewBlock>,
  h5: ({ children }) => <PreviewBlock className="markdown-preview-heading">{children}</PreviewBlock>,
  h6: ({ children }) => <PreviewBlock className="markdown-preview-heading">{children}</PreviewBlock>,
  blockquote: ({ children }) => (
    <PreviewBlock className="markdown-preview-quote">{children}</PreviewBlock>
  ),
  ul: ({ children }) => <PreviewBlock className="markdown-preview-list">{children}</PreviewBlock>,
  ol: ({ children }) => <PreviewBlock className="markdown-preview-list">{children}</PreviewBlock>,
  li: ({ children }) => <span className="markdown-preview-list-item">{children} </span>,
  table: ({ children }) => (
    <PreviewBlock className="markdown-preview-table">{children}</PreviewBlock>
  ),
  section: ({ children }) => <PreviewBlock>{children}</PreviewBlock>,
  thead: ({ children }) => <span>{children}</span>,
  tbody: ({ children }) => <span>{children}</span>,
  tr: ({ children }) => <span className="markdown-preview-table-row">{children} </span>,
  th: ({ children }) => <span className="markdown-preview-table-cell">{children} </span>,
  td: ({ children }) => <span className="markdown-preview-table-cell">{children} </span>,
  sup: ({ children }) => <span className="markdown-preview-sup">{children}</span>,
  hr: () => <span className="markdown-preview-break"> </span>,
  a: ({ children }) => <span className="markdown-preview-link">{children}</span>,
  img: ({ alt }) => (alt ? <span className="markdown-preview-image">{alt}</span> : null),
  strong: ({ children }) => <strong className="markdown-preview-strong">{children}</strong>,
  em: ({ children }) => <em className="markdown-preview-emphasis">{children}</em>,
  del: ({ children }) => <s className="markdown-preview-deleted">{children}</s>,
  code: ({ children, className }) =>
    className?.includes("language-mermaid") ? (
      <span className="markdown-preview-image">Diagram</span>
    ) : (
      <code className="markdown-preview-code">{String(children ?? "").replace(/\n$/, "")}</code>
    ),
  pre: ({ children }) => <span className="markdown-preview-codeblock">{children} </span>,
  br: () => <span className="markdown-preview-break"> </span>,
  input: ({ checked }) => (
    <span className="markdown-preview-task">{checked ? "Done" : "Todo"} </span>
  ),
};

export function MarkdownPreview({ content }: { content: string }) {
  return (
    <span className="markdown-preview">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownPreviewComponents}>
        {content}
      </ReactMarkdown>
    </span>
  );
}
