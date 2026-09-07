/**
 * ExitPlanModePreview - Plan approval UI for ExitPlanMode tool
 *
 * Shows the plan content (rendered as Markdown) and the requested bash
 * permissions (allowedPrompts) in a clean, scannable format.
 *
 * These permissions will be auto-approved during implementation if the user
 * approves the plan.
 */

import { Box, Text, Flex, Badge, Card, Code, Heading, ScrollArea } from "@radix-ui/themes";
import { CheckCircledIcon, LightningBoltIcon, FileTextIcon } from "@radix-ui/react-icons";
import Markdown from "react-markdown";
import type { AllowedPrompt } from "@workspace/pubsub";

export interface ExitPlanModePreviewProps {
  /** The plan content (Markdown) */
  plan?: string;
  allowedPrompts?: AllowedPrompt[];
  /** Path to the plan file (if provided by SDK) */
  planFilePath?: string;
}

/** Get a short display path (last 3 segments) */
function getShortPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 3) return filePath;
  return ".../" + parts.slice(-3).join("/");
}

/** Markdown components for styling within the preview */
const markdownComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <Heading size="4" mb="2">{children}</Heading>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <Heading size="3" mb="2">{children}</Heading>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <Heading size="2" mb="1">{children}</Heading>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <Text as="p" size="2" mb="2">{children}</Text>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul style={{ paddingLeft: 16, marginBottom: 8 }}>{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol style={{ paddingLeft: 16, marginBottom: 8 }}>{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li style={{ fontSize: "0.875rem", lineHeight: 1.5 }}>{children}</li>
  ),
  // Code handling mirrors agentic-chat/markdownComponents.tsx — keep in sync.
  // Block code: `pre` does the wrapping; `code` decides raw <code> vs Radix <Code>.
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const hasLanguageClass = className?.includes("language-") ?? false;
    const hasNewlines =
      typeof children === "string"
        ? children.includes("\n")
        : Array.isArray(children)
          ? children.some((c: unknown) => typeof c === "string" && (c as string).includes("\n"))
          : false;
    if (hasLanguageClass || hasNewlines) {
      return (
        <code className={className} style={{ display: "block", fontFamily: "var(--code-font-family, monospace)", fontSize: "0.85em" }}>
          {children}
        </code>
      );
    }
    const text = String(children ?? "").replace(/\n$/, "");
    return <Code size="2">{text}</Code>;
  },
  pre: ({ children }: { children?: React.ReactNode }) => (
    <Box my="2" style={{ background: "var(--gray-3)", borderRadius: 4, padding: 8, overflow: "auto", whiteSpace: "pre" }}>
      {children}
    </Box>
  ),
};

export function ExitPlanModePreview({ plan, allowedPrompts, planFilePath }: ExitPlanModePreviewProps) {
  const hasPermissions = allowedPrompts && allowedPrompts.length > 0;

  return (
    <Box>
      {/* Header */}
      <Flex gap="2" align="center" mb="3">
        <CheckCircledIcon style={{ color: "var(--green-9)", width: 18, height: 18 }} />
        <Text size="2" weight="medium">
          Ready to implement
        </Text>
      </Flex>

      {/* Plan file location (if provided) */}
      {planFilePath && (
        <Flex gap="2" align="center" mb="3">
          <FileTextIcon style={{ color: "var(--gray-9)" }} />
          <Text size="2" color="gray">
            Plan:{" "}
            <Code size="2" title={planFilePath}>
              {getShortPath(planFilePath)}
            </Code>
          </Text>
        </Flex>
      )}

      {/* Plan content (Markdown) */}
      {plan && (
        <Card size="1" mb="3">
          <ScrollArea style={{ maxHeight: 600, minHeight: 400, resize: "vertical", overflow: "auto" }}>
            <Box p="2">
              <Markdown components={markdownComponents}>
                {plan}
              </Markdown>
            </Box>
          </ScrollArea>
        </Card>
      )}

      {/* Permissions section */}
      {hasPermissions ? (
        <Card size="1">
          <Flex direction="column" gap="2">
            <Flex gap="2" align="center">
              <LightningBoltIcon style={{ color: "var(--amber-9)" }} />
              <Text size="2" weight="medium">
                Requested permissions:
              </Text>
            </Flex>
            <Text size="1" color="gray" mb="2">
              These bash commands will be auto-approved during implementation:
            </Text>
            <Flex direction="column" gap="2">
              {allowedPrompts.map((prompt, index) => (
                <Flex key={index} gap="2" align="center">
                  <Badge color="amber" size="1" variant="soft">
                    Bash
                  </Badge>
                  <Text size="2" style={{ fontFamily: "monospace" }}>
                    {prompt.prompt}
                  </Text>
                </Flex>
              ))}
            </Flex>
          </Flex>
        </Card>
      ) : !plan ? (
        // Only show "no permissions" if there's also no plan content
        <Card size="1">
          <Flex gap="2" align="center">
            <CheckCircledIcon style={{ color: "var(--green-9)" }} />
            <Text size="2" color="gray">
              No special permissions requested
            </Text>
          </Flex>
        </Card>
      ) : null}

      {/* Help text */}
      <Text size="1" color="gray" mt="2" style={{ display: "block" }}>
        Approving will allow Claude to proceed with implementation.
      </Text>
    </Box>
  );
}
