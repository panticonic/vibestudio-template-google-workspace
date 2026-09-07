import React, { Suspense, lazy, type ReactNode } from "react";
import { Text } from "@radix-ui/themes";
import type { MdxActionHandlers } from "./markdownComponents";

interface MessageContentProps {
  content: string;
  isStreaming: boolean;
  mdxActions?: MdxActionHandlers;
}

// Markdown parsing, GFM, MDX, and syntax highlighting are progressive
// enhancements. Keeping them behind a real import boundary lets an empty chat
// (and the very common plain-text message) paint without parsing the markdown
// toolchain first.
const RichMessageContent = lazy(() =>
  import("./RichMessageContent").then((module) => ({
    default: module.RichMessageContent,
  }))
);

// Match syntax that materially benefits from markdown rendering. Bare
// punctuation does not qualify, so ordinary prose stays on the synchronous
// plain-text path.
const MARKDOWN_SYNTAX_RE =
  /^[ \t]*#{1,6} |`[^`]|```|\*\*|__|\*[^\s*]|_[^\s_]|^[ \t]*[-*+] |^[ \t]*\d+\. |^[ \t]*>|~~|\[[^\]]*\]\(|!\[|.*\|.*\|/m;
const GFM_AUTOLINK_LITERAL_RE =
  /(?:https?:\/\/|www\.)[^\s<]+|[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/iu;

function PlainTextMessageContent({ content }: { content: string }) {
  return (
    <div className="message-prose">
      <Text as="div" size="2" style={{ whiteSpace: "pre-wrap" }}>
        {content}
      </Text>
    </div>
  );
}

class RichRenderErrorBoundary extends React.Component<
  { children: ReactNode; fallback: ReactNode; resetKey: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previous: Readonly<{ resetKey: string }>) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  componentDidCatch(error: unknown) {
    console.debug("Rich message renderer failed, using plain text:", error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export const MessageContent = React.memo(function MessageContent({
  content,
  isStreaming,
  mdxActions,
}: MessageContentProps) {
  const needsRichRenderer =
    /<[A-Z]/.test(content) ||
    MARKDOWN_SYNTAX_RE.test(content) ||
    (!isStreaming && GFM_AUTOLINK_LITERAL_RE.test(content));
  if (!needsRichRenderer) {
    return <PlainTextMessageContent content={content} />;
  }

  const fallback = <PlainTextMessageContent content={content} />;
  return (
    <RichRenderErrorBoundary fallback={fallback} resetKey={content}>
      <Suspense fallback={fallback}>
        <RichMessageContent content={content} isStreaming={isStreaming} mdxActions={mdxActions} />
      </Suspense>
    </RichRenderErrorBoundary>
  );
});
