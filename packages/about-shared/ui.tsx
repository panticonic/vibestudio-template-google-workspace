/**
 * Shared UI scaffold for about panels.
 *
 * Provides the common theme root, mount helper, and page layout used by all
 * shell about pages so individual panels only describe their content.
 */
import type { ReactNode } from "react";
import "@radix-ui/themes/styles.css";
import "@workspace/ui/foundation.css";
import "@workspace/ui/themes/vibestudio.css";
import { Theme, Flex, Box, Heading, Text, Card } from "@radix-ui/themes";
import { VibestudioLogo } from "@workspace/ui/brand";
import { usePanelThemeConfig } from "@workspace/react/theme";
import { useIsMobile } from "@workspace/react/responsive";
import { usePanelTheme } from "@workspace/react/theme";

/** Brand gradient used for the app mark and page icons. Theme-aware via Radix color scales. */
export const BRAND_GRADIENT = "var(--brand-gradient)";

/** Theme wrapper shared by all about panels. */
export function AboutThemeRoot({ children }: { children: ReactNode }) {
  const theme = usePanelTheme();
  const appTheme = usePanelThemeConfig();
  return (
    <Theme appearance={theme} {...appTheme}>
      {children}
    </Theme>
  );
}

/** Theme-aware Vibestudio logo mark. */
export function BrandMark({ size = 48 }: { size?: number }) {
  return <VibestudioLogo size={size} variant="symbol" />;
}

/** Small gradient bubble wrapping a page icon. */
export function PageIcon({ children }: { children: ReactNode }) {
  return (
    <Flex
      align="center"
      justify="center"
      style={{
        width: 40,
        height: 40,
        borderRadius: 10,
        background: BRAND_GRADIENT,
        boxShadow: "0 3px 12px var(--brand-glow)",
        color: "white",
        flexShrink: 0,
      }}
    >
      {children}
    </Flex>
  );
}

export interface AboutPageProps {
  /** Optional icon rendered in a gradient bubble next to the title. */
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  /** Optional element rendered on the right edge of the header (e.g. a status badge). */
  actions?: ReactNode;
  /** Content column max width in px. */
  maxWidth?: number;
  children: ReactNode;
}

/**
 * Standard about-page layout: centered column with a header and stacked
 * content. The page scrolls naturally — no nested scroll containers.
 */
export function AboutPage({
  icon,
  title,
  subtitle,
  actions,
  maxWidth = 720,
  children,
}: AboutPageProps) {
  const isMobile = useIsMobile();
  return (
    <Box
      px={isMobile ? "4" : "6"}
      py={isMobile ? "4" : "6"}
      style={{ maxWidth, margin: "0 auto", boxSizing: "border-box" }}
    >
      <Flex
        align={isMobile ? "start" : "center"}
        justify="between"
        direction={isMobile ? "column" : "row"}
        gap="3"
        mb={isMobile ? "4" : "5"}
      >
        <Flex align="center" gap="3">
          {icon && <PageIcon>{icon}</PageIcon>}
          <Box>
            <Heading size={isMobile ? "6" : "7"}>{title}</Heading>
            {subtitle && (
              <Text color="gray" size="2">
                {subtitle}
              </Text>
            )}
          </Box>
        </Flex>
        {actions}
      </Flex>
      <Flex direction="column" gap="4">
        {children}
      </Flex>
    </Box>
  );
}

export interface SectionProps {
  title?: string;
  description?: string;
  /** Optional element rendered to the right of the section title. */
  actions?: ReactNode;
  children: ReactNode;
}

/** A titled card section within an AboutPage. */
export function Section({ title, description, actions, children }: SectionProps) {
  const isMobile = useIsMobile();
  return (
    <Card size={isMobile ? "2" : "3"}>
      {(title || actions) && (
        <Flex align="center" justify="between" gap="3" mb={description ? "1" : "3"}>
          {title && <Heading size="4">{title}</Heading>}
          {actions}
        </Flex>
      )}
      {description && (
        <Text as="p" size="2" color="gray" mb="3">
          {description}
        </Text>
      )}
      {children}
    </Card>
  );
}
