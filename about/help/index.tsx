/**
 * Help Page - Shell panel showing documentation and help resources.
 */
import type { ReactNode } from "react";
import { Card, Flex, Heading, Text, Kbd, Link } from "@radix-ui/themes";
import {
  RocketIcon,
  CubeIcon,
  DashboardIcon,
  MagicWandIcon,
  CodeIcon,
  QuestionMarkCircledIcon,
  LockClosedIcon,
  MobileIcon,
} from "@radix-ui/react-icons";
import { buildPanelLink } from "@workspace/runtime";
import { useIsMobile } from "@workspace/react";
import {
  AboutThemeRoot,
  AboutPage,
  BRAND_GRADIENT,
} from "@workspace/about-shared/ui";

interface HelpSection {
  title: string;
  icon: ReactNode;
  content: string;
  mobileContent?: string;
  link?: { label: string; panel: string };
}

const helpSections: HelpSection[] = [
  {
    title: "Getting Started",
    icon: <RocketIcon />,
    content:
      "Vibestudio is your personal vibe computer: a workspace for building, browsing, and working with AI agents. " +
      "Everything opens in panels, while sensitive actions remain sandboxed until you approve them.",
  },
  {
    title: "Workspaces",
    icon: <CubeIcon />,
    content:
      "A workspace keeps your panels, conversations, projects, and settings together. " +
      "Use Cmd/Ctrl+Shift+O to switch workspaces; each workspace has its own durable state and permissions.",
  },
  {
    title: "Panels",
    icon: <DashboardIcon />,
    content:
      "Panels can be chats, terminals, personal apps, tools, or websites. Use Cmd/Ctrl+T to open one and Cmd/Ctrl+W to close the current one, " +
      "and Cmd/Ctrl+K to find actions contributed by the panel you are using.",
  },
  {
    title: "Agents and providers",
    icon: <MagicWandIcon />,
    content:
      "Agents work inside your workspace, but cannot silently cross protected boundaries. " +
      "Open a chat from the panel launcher and connect a supported model provider when prompted.",
  },
  {
    title: "Approvals and sandboxing",
    icon: <LockClosedIcon />,
    content:
      "When an agent or panel needs network, filesystem, credential, or other sensitive access, Vibestudio pauses it and asks you. " +
      "Allow once for a narrow exception; only create a lasting trust grant when you recognize the requester and scope.",
    link: { label: "Review saved permissions", panel: "about/permissions" },
  },
  {
    title: "Credentials",
    icon: <CodeIcon />,
    content:
      "Passwords and service tokens are stored outside panel code. A panel receives only the credential binding you approve, " +
      "and you can revoke stored credentials from the credential manager.",
    link: { label: "Manage credentials", panel: "about/credentials" },
  },
  {
    title: "Phone and remote access",
    icon: <MobileIcon />,
    content:
      "Click the connection status badge in the title bar, then use Paired devices → Connect a device. Pairing links expire quickly; each paired device gets its own revocable identity.",
    mobileContent:
      "Open Settings → Devices → Connect another device, then share the one-time link with the new phone or desktop. Each paired device gets its own revocable identity.",
  },
];

function SectionIcon({ children }: { children: ReactNode }) {
  return (
    <Flex
      align="center"
      justify="center"
      style={{
        width: 28,
        height: 28,
        borderRadius: 7,
        background: BRAND_GRADIENT,
        color: "white",
        flexShrink: 0,
      }}
    >
      {children}
    </Flex>
  );
}

function HelpPage() {
  const isMobile = useIsMobile();
  return (
    <AboutPage
      icon={<QuestionMarkCircledIcon width={20} height={20} />}
      title="Help"
      subtitle="Documentation and getting started"
    >
      {helpSections.map((section) => (
        <Card key={section.title} size={isMobile ? "2" : "3"}>
          <Flex align="center" gap="2" mb="2">
            <SectionIcon>{section.icon}</SectionIcon>
            <Heading size="4">{section.title}</Heading>
          </Flex>
          <Text as="p" size="2" color="gray" style={{ lineHeight: 1.65 }}>
            {isMobile
              ? (section.mobileContent ?? section.content)
              : section.content}
          </Text>
          {section.link ? (
            <Link
              href={buildPanelLink(section.link.panel)}
              size="2"
              mt="2"
              style={{ display: "inline-block" }}
            >
              {section.link.label} →
            </Link>
          ) : null}
        </Card>
      ))}

      <Card size={isMobile ? "2" : "3"}>
        <Heading size="4" mb="2">
          Quick Reference
        </Heading>
        <Flex direction="column" gap="2">
          <Text size="2" color="gray">
            Press <Kbd>Cmd/Ctrl + /</Kbd> for the full list of keyboard
            shortcuts.
          </Text>
          <Text size="2" color="gray">
            Press <Kbd>Cmd/Ctrl + T</Kbd> to open the panel launcher and{" "}
            <Kbd>Cmd/Ctrl + W</Kbd> to close the current panel.
          </Text>
          <Text size="2" color="gray">
            Press <Kbd>Cmd/Ctrl + K</Kbd> to search actions for the app and
            current panel.
          </Text>
        </Flex>
      </Card>
    </AboutPage>
  );
}

export default function AboutPanelRoot() {
  return (
    <AboutThemeRoot>
      <HelpPage />
    </AboutThemeRoot>
  );
}
