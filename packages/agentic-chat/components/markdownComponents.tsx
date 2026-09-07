import { Children, isValidElement, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { Diagram, MermaidDiagram } from "@workspace/ui/diagram";
import {
  Badge,
  Blockquote,
  Box,
  Button,
  Callout as RadixCallout,
  Card,
  Code,
  Flex,
  Heading,
  Link,
  Table,
  Text,
} from "@radix-ui/themes";
// Curated icon subset for MDX components (~saves 400KB vs wildcard import)
// These are the icons commonly used by agents in MDX content
import {
  CheckIcon,
  CheckCircledIcon,
  InfoCircledIcon,
  ExclamationTriangleIcon,
  Cross2Icon,
  CrossCircledIcon,
  QuestionMarkCircledIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  MinusIcon,
  GearIcon,
  Pencil1Icon,
  TrashIcon,
  CopyIcon,
  DownloadIcon,
  UploadIcon,
  FileIcon,
  FileTextIcon,
  CodeIcon,
  Link2Icon,
  ExternalLinkIcon,
  OpenInNewWindowIcon,
  MagnifyingGlassIcon,
  LightningBoltIcon,
  RocketIcon,
  StarIcon,
  HeartIcon,
  BellIcon,
  LockClosedIcon,
  LockOpen1Icon,
  PersonIcon,
  HomeIcon,
  CalendarIcon,
  ClockIcon,
  ReloadIcon,
  UpdateIcon,
  PlayIcon,
  PauseIcon,
  StopIcon,
} from "@radix-ui/react-icons";

export interface MdxActionHandlers {
  publishMessage?: (content: string) => void | Promise<void>;
}

// Re-export as Icons namespace for MDX components: <Icons.CheckIcon />
const Icons = {
  CheckIcon,
  CheckCircledIcon,
  InfoCircledIcon,
  ExclamationTriangleIcon,
  Cross2Icon,
  CrossCircledIcon,
  QuestionMarkCircledIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  MinusIcon,
  GearIcon,
  Pencil1Icon,
  TrashIcon,
  CopyIcon,
  DownloadIcon,
  UploadIcon,
  FileIcon,
  FileTextIcon,
  CodeIcon,
  Link2Icon,
  ExternalLinkIcon,
  OpenInNewWindowIcon,
  MagnifyingGlassIcon,
  LightningBoltIcon,
  RocketIcon,
  StarIcon,
  HeartIcon,
  BellIcon,
  LockClosedIcon,
  LockOpen1Icon,
  PersonIcon,
  HomeIcon,
  CalendarIcon,
  ClockIcon,
  ReloadIcon,
  UpdateIcon,
  PlayIcon,
  PauseIcon,
  StopIcon,
};

// Custom Callout wrapper that uses div instead of p for Text to avoid HTML nesting issues
// (MDX content inside Callout.Text can contain <p>, <ul>, <ol> which can't nest in <p>)
const CalloutText = ({ children, ...props }: { children?: ReactNode }) => (
  <Text as="div" size="2" {...props}>
    {children}
  </Text>
);

const Callout = Object.assign(RadixCallout.Root, {
  Root: RadixCallout.Root,
  Icon: RadixCallout.Icon,
  Text: CalloutText,
});

function FeedbackFormTitle({
  children,
  title,
}: {
  children?: ReactNode;
  title?: ReactNode;
}) {
  const content = children ?? title;
  if (!content) return null;
  return (
    <Heading size="4" mb="2">
      {content}
    </Heading>
  );
}

function createActionButton(actions?: MdxActionHandlers) {
  return function ActionButton({
    children,
    message,
    variant = "soft",
    size = "1",
  }: {
    children?: ReactNode;
    message?: string;
    variant?: "classic" | "solid" | "soft" | "surface" | "outline" | "ghost";
    size?: "1" | "2" | "3" | "4";
  }) {
    const disabled = !message || !actions?.publishMessage;
    return (
      <Button
        size={size}
        variant={variant}
        disabled={disabled}
        onClick={() => {
          if (!message) return;
          void actions?.publishMessage?.(message);
        }}
      >
        {children ?? message}
      </Button>
    );
  };
}

const MERMAID_LANGUAGE_RE = /\blanguage-mermaid\b/;

function extractText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractText).join("");
  return "";
}

function hasMermaidChild(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => {
    if (!isValidElement(child)) return false;
    const className = (child.props as { className?: unknown }).className;
    return typeof className === "string" && MERMAID_LANGUAGE_RE.test(className);
  });
}

// Fenced-code handling. Diagram fences (```mermaid) render as diagrams only in
// the non-streaming component set — mid-stream the fence is incomplete, so it
// stays a plain code block and flips to a diagram when the message completes
// (same gating as rehype-highlight / MDX in MessageContent.tsx).
function createCodeComponents({ diagrams }: { diagrams: boolean }): Pick<Components, "code" | "pre"> {
  return {
    code: ({ children, className }) => {
      if (diagrams && typeof className === "string" && MERMAID_LANGUAGE_RE.test(className)) {
        return <MermaidDiagram code={extractText(children)} />;
      }

      // In react-markdown v9 the `inline` prop was removed.
      // Block code (fences/indented) is always wrapped in <pre> by react-markdown,
      // so our `pre` handler takes care of the block wrapper (.ns-codeblock).
      // Here we just decide raw <code> (block) vs Radix <Code> (inline).
      const hasLanguageClass = className?.includes("language-") ?? false;
      const hasNewlines =
        typeof children === "string"
          ? children.includes("\n")
          : Array.isArray(children)
            ? children.some((c) => typeof c === "string" && c.includes("\n"))
            : false;

      if (hasLanguageClass || hasNewlines) {
        // Block code — rendered inside <pre> by the pre handler below
        return (
          <code className={className} style={{ display: "block" }}>
            {children}
          </code>
        );
      }

      // Inline code, OR single-line no-language fence (pre handler catches that case
      // and .ns-codeblock CSS resets the Radix styling — see styles.css)
      const text = String(children ?? "").replace(/\n$/, "");
      return <Code size="2">{text}</Code>;
    },
    pre: ({ children }) => {
      // A mermaid fence already rendered as a block-level diagram frame —
      // don't wrap it in <pre> (invalid nesting and unwanted code styling)
      if (diagrams && hasMermaidChild(children)) {
        return <>{children}</>;
      }
      return (
        <Box my="2">
          <pre className="ns-codeblock" style={{ margin: 0 }}>
            {children}
          </pre>
        </Box>
      );
    },
  };
}

const baseMarkdownComponents: Components = {
  h1: ({ children }) => (
    <Heading size="6" mb="2">
      {children}
    </Heading>
  ),
  h2: ({ children }) => (
    <Heading size="5" mb="2">
      {children}
    </Heading>
  ),
  h3: ({ children }) => (
    <Heading size="4" mb="1">
      {children}
    </Heading>
  ),
  h4: ({ children }) => (
    <Heading size="3" mb="1">
      {children}
    </Heading>
  ),
  p: ({ children }) => (
    <Text as="p" size="2" mb="2">
      {children}
    </Text>
  ),
  a: ({ href, children }) => <Link href={href ?? ""}>{children}</Link>,
  blockquote: ({ children }) => <Blockquote>{children}</Blockquote>,
  ul: ({ children }) => (
    <ul style={{ paddingLeft: "var(--space-4)", marginBottom: "var(--space-2)" }}>
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol style={{ paddingLeft: "var(--space-4)", marginBottom: "var(--space-2)" }}>
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li style={{ fontSize: "var(--font-size-2)" }}>
      {children}
    </li>
  ),
  // GFM tables — remark-gfm generates table/thead/tbody/tr/th/td elements.
  // Style them to match the Radix theme instead of relying on unstyled browser defaults.
  table: ({ children }) => (
    <Box my="2" style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "var(--font-size-2)",
          lineHeight: "var(--line-height-2)",
        }}
      >
        {children}
      </table>
    </Box>
  ),
  thead: ({ children }) => (
    <thead style={{ borderBottom: "2px solid var(--gray-6)" }}>{children}</thead>
  ),
  th: ({ children, style }) => (
    <th
      style={{
        padding: "var(--space-2) var(--space-3)",
        textAlign: "left",
        fontWeight: 600,
        ...style,
      }}
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td
      style={{
        padding: "var(--space-2) var(--space-3)",
        borderBottom: "1px solid var(--gray-4)",
        ...style,
      }}
    >
      {children}
    </td>
  ),
  strong: ({ children }) => <Text weight="bold">{children}</Text>,
  em: ({ children }) => <Text style={{ fontStyle: "italic" }}>{children}</Text>,
};

// Default set: diagram fences render as diagrams (use for completed messages).
export const markdownComponents: Components = {
  ...baseMarkdownComponents,
  ...createCodeComponents({ diagrams: true }),
};

// Streaming set: diagram fences stay plain code blocks until the message completes.
export const streamingMarkdownComponents: Components = {
  ...baseMarkdownComponents,
  ...createCodeComponents({ diagrams: false }),
};

export const mdxComponents: Record<string, unknown> = {
  ...markdownComponents,
  Badge,
  Blockquote,
  Box,
  Button,
  Callout,
  Card,
  Code,
  Flex,
  Heading,
  Link,
  Table,
  Text,
  Icons,
  FeedbackFormTitle,
  Diagram,
  Mermaid: Diagram,
};

export function createMdxComponents(actions?: MdxActionHandlers): Record<string, unknown> {
  return {
    ...mdxComponents,
    ActionButton: createActionButton(actions),
  };
}
