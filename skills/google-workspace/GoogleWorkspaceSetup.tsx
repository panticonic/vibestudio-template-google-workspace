import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Flex,
  Grid,
  Heading,
  Separator,
  Select,
  Callout,
  Text,
} from "@radix-ui/themes";
import { GlobeIcon, OpenInNewWindowIcon } from "@radix-ui/react-icons";
import { OperationNotice } from "@workspace/ui/feedback";
import {
  openExternal,
  openPanel,
  panel,
  buildPanelLink,
} from "@workspace/runtime";
import {
  configureGoogleOAuthClient,
  connectGoogle,
  getGoogleOnboardingStatus,
  type GoogleOnboardingStatus,
} from "./index.js";

import {
  GOOGLE_GMAIL_SCOPES,
  GOOGLE_WORKSPACE_BROAD_SCOPES,
} from "@workspace/google-workspace/providers";
interface GoogleWorkspaceSetupProps {
  onStatus?: (status: GoogleOnboardingStatus | null) => void;
}

const STEPS = [
  {
    title: "Choose one Google Cloud project",
    description: "Keep this project selected for every step below.",
    url: "https://console.cloud.google.com/projectcreate",
  },
  {
    title: "Enable the Workspace APIs",
    description:
      "Turn on Gmail, Calendar, Drive, Docs, Sheets, Slides, and People.",
    url: "https://console.cloud.google.com/apis/library",
  },
  {
    title: "Set up the consent screen",
    description:
      "Add the app name and contact details, then publish it to Production.",
    url: "https://console.cloud.google.com/auth/overview",
  },
  {
    title: "Create a Desktop app",
    description:
      "Create an OAuth client and choose Desktop app as its application type.",
    url: "https://console.cloud.google.com/auth/clients",
  },
] as const;

function statusLabel(status: GoogleOnboardingStatus | null): string {
  if (!status) return "Status unavailable";
  if (status.stage === "verified")
    return `Connected${status.email ? ` as ${status.email}` : ""}`;
  if (status.stage === "connected") return "Connected, verification needed";
  if (status.stage === "ready-to-connect") return "App details saved";
  if (status.stage === "needs-setup") return "Google Cloud setup needed";
  return "Needs attention";
}

export default function GoogleWorkspaceSetup({
  onStatus,
}: GoogleWorkspaceSetupProps = {}) {
  const [browser, setBrowser] = useState<"internal" | "external">("external");
  const [workflow, setWorkflow] = useState<"gmail" | "workspace">("gmail");
  const scopes =
    workflow === "gmail"
      ? [...GOOGLE_GMAIL_SCOPES]
      : [...GOOGLE_WORKSPACE_BROAD_SCOPES];
  const [status, setStatus] = useState<GoogleOnboardingStatus | null>(null);
  const [busy, setBusy] = useState<string | null>("status");
  const [messageIntent, setMessageIntent] = useState<"error" | "success">(
    "success",
  );
  const busyOwner = useRef<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async (verify = false) => {
    let next: GoogleOnboardingStatus;
    try {
      next = await getGoogleOnboardingStatus({ verify });
    } catch (error) {
      setStatus(null);
      onStatus?.(null);
      throw error;
    }
    setStatus(next);
    onStatus?.(next);
    if (next.error) throw new Error(next.error);
    return next;
  };

  const run = async (action: string, operation: () => Promise<void>) => {
    if (busyOwner.current !== null) return;
    busyOwner.current = action;
    setBusy(action);
    setMessage(null);
    setMessageIntent("success");
    try {
      await operation();
    } catch (error) {
      setMessageIntent("error");
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      busyOwner.current = null;
      setBusy(null);
    }
  };

  useEffect(() => {
    const check = () =>
      void run("status", async () => {
        await refresh(true);
      });
    check();
    // Returning from account setup re-observes its owner without restarting a
    // connection or interrupting a currently pending trusted prompt.
    return panel.onFocus(check);
  }, []);

  const openStep = (url: string) =>
    run(`open:${url}`, async () => {
      if (browser === "external") await openExternal(url);
      else await openPanel(url, { focus: true, title: "Google Cloud setup" });
    });

  const saveClient = () =>
    run("configure", async () => {
      await configureGoogleOAuthClient();
      await refresh();
      setMessage(
        "Desktop app details saved securely. You can connect Google now.",
      );
    });

  const connect = () =>
    run("connect", async () => {
      const result = await connectGoogle({
        scopes,
        ...(status?.verification && !status.verification.valid
          ? { force: true }
          : {}),
      });
      if (!result.success)
        throw new Error(result.error ?? "Google connection failed.");
      const next = await refresh(true);
      if (next.stage !== "verified")
        throw new Error(
          next.verification?.error ??
            "Google could not verify the permissions for this workflow.",
        );
      if (!scopes.every((scope) => next.verification?.scopes?.includes(scope)))
        throw new Error(
          "Google has not granted all permissions for this workflow. Connect again and review the requested access.",
        );
      setMessage("Google Workspace is connected and verified.");
    });

  const verify = () =>
    run("verify", async () => {
      const next = await refresh(true);
      if (
        next.stage !== "verified" ||
        !scopes.every((scope) => next.verification?.scopes?.includes(scope))
      ) {
        throw new Error(
          next.verification?.error ??
            "Google could not verify the permissions for this workflow.",
        );
      }
      setMessage("Google Workspace is connected and verified.");
    });

  const connected =
    status?.stage === "verified" &&
    scopes.every((scope) => status.verification?.scopes?.includes(scope));

  return (
    <Flex
      direction="column"
      gap="4"
      p="2"
      style={{ width: "100%", minWidth: 0 }}
    >
      <Flex justify="between" align="start" gap="3" wrap="wrap">
        <Box style={{ flex: "1 1 16rem", minWidth: 0 }}>
          <Heading size="4">Connect Google Workspace</Heading>
          <Text as="div" size="2" color="gray">
            Start with Gmail, then connect other Workspace apps when you need
            them. This template uses your own Google Cloud project and Desktop
            OAuth app; you will need permission to manage that project.
          </Text>
        </Box>
        <Badge color={connected ? "green" : "blue"} variant="soft">
          {status?.stage === "verified" && !connected
            ? "More permissions needed"
            : busy === "status"
              ? "Checking…"
              : statusLabel(status)}
        </Badge>
      </Flex>

      <Flex direction="column" gap="1">
        <Text as="label" htmlFor="google-workflow" size="2" weight="bold">
          What would you like to connect?
        </Text>
        <Select.Root
          value={workflow}
          onValueChange={(value) => setWorkflow(value as "gmail" | "workspace")}
          disabled={busy !== null}
        >
          <Select.Trigger id="google-workflow" />
          <Select.Content>
            <Select.Item value="gmail">Gmail</Select.Item>
            <Select.Item value="workspace">All Workspace apps</Select.Item>
          </Select.Content>
        </Select.Root>
        <Text size="1" color="gray">
          {workflow === "gmail"
            ? "Read, organize, and send mail with your Gmail aliases. New connections request Gmail access; existing grants stay in place when adding access."
            : "Mail, calendar, files, documents, spreadsheets, presentations, and contacts. Changing access opens a new Google consent flow."}
        </Text>
      </Flex>
      {status?.warnings.map((warning) => (
        <Callout.Root key={warning} color="amber" size="1">
          <Callout.Text>{warning}</Callout.Text>
        </Callout.Root>
      ))}
      {!connected ? (
        <>
          {status?.configured ? (
            <OperationNotice intent="info">
              Your Desktop app details are saved. Continue by connecting Google;
              you can change the app details below if needed.
            </OperationNotice>
          ) : null}
          {!status?.configured ? (
            <>
              <Box>
                <Text size="2" weight="bold">
                  Where should setup pages open?
                </Text>
                <Text as="p" size="1" color="gray">
                  Use your normal browser for existing sign-in, passkeys, or a
                  password manager.
                </Text>
                <Flex gap="2" mt="2" wrap="wrap">
                  <Button
                    variant={browser === "internal" ? "solid" : "soft"}
                    aria-pressed={browser === "internal"}
                    disabled={busy !== null}
                    onClick={() => setBrowser("internal")}
                  >
                    <GlobeIcon /> Here
                  </Button>
                  <Button
                    variant={browser === "external" ? "solid" : "soft"}
                    aria-pressed={browser === "external"}
                    disabled={busy !== null}
                    onClick={() => setBrowser("external")}
                  >
                    <OpenInNewWindowIcon /> My browser
                  </Button>
                </Flex>
              </Box>

              <Grid
                gap="2"
                style={{
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(min(100%, 18rem), 1fr))",
                }}
              >
                {STEPS.map((step, index) => (
                  <Box
                    key={step.url}
                    style={{
                      border: "1px solid var(--gray-6)",
                      borderRadius: 8,
                      padding: 12,
                    }}
                  >
                    <Flex
                      direction="column"
                      gap="2"
                      height="100%"
                      justify="between"
                    >
                      <Box>
                        <Text size="2" weight="bold">
                          {index + 1}. {step.title}
                        </Text>
                        <Text as="p" size="1" color="gray">
                          {index === 1 && workflow === "gmail"
                            ? "Enable the Gmail API. You can enable other APIs later."
                            : step.description}
                        </Text>
                      </Box>
                      <Button
                        size="1"
                        variant="soft"
                        disabled={busy !== null}
                        aria-label={`Open step ${index + 1}: ${step.title}`}
                        onClick={() => void openStep(step.url)}
                      >
                        Open this step
                      </Button>
                    </Flex>
                  </Box>
                ))}
              </Grid>

              <Text size="1" color="gray">
                On the consent screen, publish to Production so Google does not
                expire the refresh token after seven days. The app can remain
                unverified for personal use.
              </Text>
            </>
          ) : null}

          <Separator size="4" />

          <Flex justify="end" gap="2" wrap="wrap">
            <Button
              variant="soft"
              disabled={busy !== null}
              onClick={() => void saveClient()}
            >
              {busy === "configure"
                ? "Opening trusted prompt…"
                : status?.configured
                  ? "Change Desktop app details"
                  : "Save Desktop app details"}
            </Button>
            <Button
              disabled={busy !== null || !status?.readyToConnect}
              onClick={() => void connect()}
            >
              {busy === "connect" ? "Connecting…" : "Connect Google"}
            </Button>
          </Flex>
        </>
      ) : (
        <Flex justify="end">
          <Button
            variant="soft"
            disabled={busy !== null}
            onClick={() => void verify()}
          >
            Check connection
          </Button>
        </Flex>
      )}

      {status?.connected && status.stage !== "verified" ? (
        <Flex justify="end">
          <Button disabled={busy !== null} onClick={() => void verify()}>
            {busy === "verify" ? "Verifying…" : "Verify connection"}
          </Button>
        </Flex>
      ) : null}

      {!status && busy === null ? (
        <Button
          variant="soft"
          onClick={() =>
            void run("status", async () => {
              await refresh(true);
            })
          }
        >
          Check connection
        </Button>
      ) : null}
      {busy ? (
        <OperationNotice>
          {busy === "connect"
            ? "Connecting Google. Complete the consent request in your browser; this step stays open while you decide."
            : busy === "configure"
              ? "Waiting for your Desktop app details in the trusted prompt."
              : busy === "verify" || busy === "status"
                ? "Checking your Google connection…"
                : "Opening the setup page…"}
        </OperationNotice>
      ) : null}
      {message ? (
        <OperationNotice intent={messageIntent}>{message}</OperationNotice>
      ) : null}
      <Flex gap="3" wrap="wrap">
        <a
          href={buildPanelLink("about/credentials", {
            workspace: { role: "personal" },
          })}
        >
          Manage connected accounts
        </a>
        <a
          href={buildPanelLink("about/permissions", {
            workspace: { role: "system" },
          })}
        >
          Review saved permissions
        </a>
      </Flex>
    </Flex>
  );
}
