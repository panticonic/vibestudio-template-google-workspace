import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Flex,
  Grid,
  Heading,
  Separator,
  Text,
} from "@radix-ui/themes";
import { GlobeIcon, OpenInNewWindowIcon } from "@radix-ui/react-icons";
import { openExternal, openPanel } from "@workspace/runtime";
import {
  configureGoogleOAuthClient,
  connectGoogle,
  getGoogleOnboardingStatus,
  type GoogleOnboardingStatus,
} from "./index.js";

interface GoogleWorkspaceSetupProps {
  props?: Record<string, never>;
  chat: {
    send(
      content: string,
      options?: { metadata?: Record<string, unknown> }
    ): Promise<unknown>;
  };
}

const STEPS = [
  {
    title: "Choose one Google Cloud project",
    description: "Keep this project selected for every step below.",
    url: "https://console.cloud.google.com/projectcreate",
  },
  {
    title: "Enable the Workspace APIs",
    description: "Turn on Gmail, Calendar, Drive, Docs, Sheets, Slides, and People.",
    url: "https://console.cloud.google.com/apis/library",
  },
  {
    title: "Set up the consent screen",
    description: "Add the app name and contact details, then publish it to Production.",
    url: "https://console.cloud.google.com/auth/overview",
  },
  {
    title: "Create a Desktop app",
    description: "Create an OAuth client and choose Desktop app as its application type.",
    url: "https://console.cloud.google.com/auth/clients",
  },
] as const;

function statusLabel(status: GoogleOnboardingStatus | null): string {
  if (!status) return "Checking…";
  if (status.stage === "verified") return `Connected${status.email ? ` as ${status.email}` : ""}`;
  if (status.stage === "connected") return "Connected, verification needed";
  if (status.stage === "ready-to-connect") return "App details saved";
  if (status.stage === "needs-setup") return "Google Cloud setup needed";
  return "Needs attention";
}

export default function GoogleWorkspaceSetup({ chat }: GoogleWorkspaceSetupProps) {
  const [browser, setBrowser] = useState<"internal" | "external">("internal");
  const [status, setStatus] = useState<GoogleOnboardingStatus | null>(null);
  const [busy, setBusy] = useState<string | null>("status");
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async (verify = false) => {
    const next = await getGoogleOnboardingStatus({ verify });
    setStatus(next);
    if (next.error) throw new Error(next.error);
    return next;
  };

  useEffect(() => {
    void refresh(true)
      .catch((error) => setMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(null));
  }, []);

  const run = async (action: string, operation: () => Promise<void>) => {
    setBusy(action);
    setMessage(null);
    try {
      await operation();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const openStep = (url: string) =>
    run(`open:${url}`, async () => {
      if (browser === "external") await openExternal(url);
      else await openPanel(url, { focus: true, title: "Google Cloud setup" });
    });

  const saveClient = () =>
    run("configure", async () => {
      await configureGoogleOAuthClient();
      await refresh();
      setMessage("Desktop app details saved securely. You can connect Google now.");
    });

  const connect = () =>
    run("connect", async () => {
      const result = await connectGoogle();
      if (!result.success) throw new Error(result.error ?? "Google connection failed.");
      await refresh(true);
      setMessage("Google Workspace is connected and verified.");
    });

  const verify = () =>
    run("verify", async () => {
      const next = await refresh(true);
      if (next.stage !== "verified") {
        throw new Error(next.verification?.error ?? "Google could not verify this connection.");
      }
      setMessage("Google Workspace is connected and verified.");
    });

  const refreshOverview = () =>
    chat.send("Check the Google connection and refresh the setup overview.", {
      metadata: {
        interaction: {
          source: "onboarding-setup-hub",
          kind: "onboarding-capability",
          action: "check",
          targetId: "connection.google-workspace",
        },
      },
    });

  const connected = status?.stage === "verified";

  return (
    <Flex direction="column" gap="4" p="2" style={{ width: "100%", minWidth: 0 }}>
      <Flex justify="between" align="start" gap="3" wrap="wrap">
        <Box style={{ flex: "1 1 16rem", minWidth: 0 }}>
          <Heading size="4">Connect Google Workspace</Heading>
          <Text as="div" size="2" color="gray">
            One durable connection enables Gmail, Calendar, Drive, Docs, Sheets,
            Slides, contacts, and account identity.
          </Text>
        </Box>
        <Badge color={connected ? "green" : "blue"} variant="soft">
          {statusLabel(status)}
        </Badge>
      </Flex>

      {!connected ? (
        <>
          <Box>
            <Text size="2" weight="bold">Where should setup pages open?</Text>
            <Text as="p" size="1" color="gray">
              Use your normal browser for existing sign-in, passkeys, or a password manager.
            </Text>
            <Flex gap="2" mt="2" wrap="wrap">
              <Button
                variant={browser === "internal" ? "solid" : "soft"}
                onClick={() => setBrowser("internal")}
              >
                <GlobeIcon /> Here
              </Button>
              <Button
                variant={browser === "external" ? "solid" : "soft"}
                onClick={() => setBrowser("external")}
              >
                <OpenInNewWindowIcon /> My browser
              </Button>
            </Flex>
          </Box>

          <Grid
            gap="2"
            style={{
              gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 18rem), 1fr))",
            }}
          >
            {STEPS.map((step, index) => (
              <Box
                key={step.url}
                style={{ border: "1px solid var(--gray-6)", borderRadius: 8, padding: 12 }}
              >
                <Flex direction="column" gap="2" height="100%" justify="between">
                  <Box>
                    <Text size="2" weight="bold">{index + 1}. {step.title}</Text>
                    <Text as="p" size="1" color="gray">{step.description}</Text>
                  </Box>
                  <Button
                    size="1"
                    variant="soft"
                    disabled={busy !== null}
                    onClick={() => void openStep(step.url)}
                  >
                    Open this step
                  </Button>
                </Flex>
              </Box>
            ))}
          </Grid>

          <Text size="1" color="gray">
            On the consent screen, publish to Production so Google does not expire the
            refresh token after seven days. The app can remain unverified for personal use.
          </Text>

          <Separator size="4" />

          <Flex justify="end" gap="2" wrap="wrap">
            <Button
              variant="soft"
              disabled={busy !== null}
              onClick={() => void saveClient()}
            >
              {busy === "configure" ? "Opening trusted prompt…" : "Save Desktop app details"}
            </Button>
            <Button
              disabled={busy !== null || status?.stage === "needs-setup"}
              onClick={() => void connect()}
            >
              {busy === "connect" ? "Connecting…" : "Connect Google"}
            </Button>
          </Flex>
        </>
      ) : (
        <Flex justify="end">
          <Button variant="soft" disabled={busy !== null} onClick={() => void refreshOverview()}>
            Refresh setup overview
          </Button>
        </Flex>
      )}

      {status?.stage === "connected" ? (
        <Flex justify="end">
          <Button disabled={busy !== null} onClick={() => void verify()}>
            {busy === "verify" ? "Verifying…" : "Verify connection"}
          </Button>
        </Flex>
      ) : null}

      {message ? (
        <Text size="1" color={message.includes("verified") || message.includes("saved") ? "gray" : "red"}>
          {message}
        </Text>
      ) : null}
    </Flex>
  );
}
