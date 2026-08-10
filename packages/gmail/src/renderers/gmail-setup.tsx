import { Badge, Button, Callout, Flex, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon, GearIcon, Pencil1Icon, ReloadIcon } from "@radix-ui/react-icons";
import { useState } from "react";
import type { GmailSetupState } from "@workspace/gmail/card-types";

type GmailSetupCardState = Partial<GmailSetupState> & { status: GmailSetupState["status"] };

/** One-tap onboarding answers, handed to the agent as a chat message. */
const ONBOARDING_PRESETS = ["Invoices & receipts", "Scheduling", "Urgent ops mail"];

interface GmailChat {
  callMethodByHandle: (handle: string, method: string, args: unknown) => Promise<unknown>;
  send: (content: string) => Promise<unknown>;
}

export function Pill({ state }: { state: GmailSetupCardState }) {
  const auth = state.auth?.status ?? "unknown";
  return (
    <Flex align="center" gap="1">
      <GearIcon />
      <Text size="1" weight="medium">
        Gmail
      </Text>
      <Badge
        size="1"
        color={auth === "ok" ? "green" : auth === "reconnect-required" ? "red" : "gray"}
      >
        {auth === "ok" ? "Connected" : auth === "reconnect-required" ? "Reconnect" : "Connecting"}
      </Badge>
    </Flex>
  );
}

/**
 * Lean connection/preference card. No rule editor: the attention preference
 * is natural-language text the agent maintains — Edit hands off to chat.
 */
export default function GmailSetup({
  state,
  expanded,
  chat,
}: {
  state: GmailSetupCardState;
  expanded: boolean;
  chat: GmailChat;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (!expanded) return <Pill state={state} />;

  async function run(key: string, method: string, args: unknown = {}): Promise<unknown> {
    setBusy(key);
    setError(null);
    try {
      return await chat.callMethodByHandle("gmail", method, args);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function reconnect() {
    setNote(null);
    const result = (await run("reconnect", "reconnect")) as
      | { ok: boolean; auth?: { status?: string }; error?: string }
      | undefined;
    if (!result) return;
    setNote(
      result.auth?.status === "ok"
        ? "Connection verified."
        : `Still disconnected${result.error ? `: ${result.error}` : "."}`
    );
  }

  async function sendPreset(preset: string) {
    setBusy(`preset:${preset}`);
    setError(null);
    try {
      // The agent saves this via gmail_set_attention — one tap, no typing.
      await chat.send(`@gmail Watch for: ${preset}. Plus the default (people I reply to).`);
      setNote("Asked the Gmail agent — it will confirm in chat.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function editPreference() {
    setBusy("edit");
    setError(null);
    try {
      await chat.send(
        `@gmail I'd like to change what email you wake me for. Currently: "${preference}"`
      );
      setNote("Asked the Gmail agent — continue in chat.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const auth = state.auth?.status ?? "unknown";
  const preference = state.attentionPreference ?? "Mail from people you have replied to before.";

  return (
    <Flex direction="column" gap="2">
      <Flex align="center" justify="between" gap="2" wrap="wrap">
        <Flex align="center" gap="2" style={{ minWidth: 0 }}>
          <GearIcon />
          <Text size="3" weight="bold">
            Gmail
          </Text>
          <Badge
            color={auth === "ok" ? "green" : auth === "reconnect-required" ? "red" : "gray"}
            variant="soft"
          >
            {auth === "ok"
              ? (state.email ?? "Connected")
              : auth === "reconnect-required"
                ? "Reconnect required"
                : "Connecting"}
          </Badge>
        </Flex>
        {auth !== "ok" ? (
          <Button size="2" variant="soft" disabled={busy !== null} onClick={() => void reconnect()}>
            <ReloadIcon /> {busy === "reconnect" ? "Verifying" : "Reconnect"}
          </Button>
        ) : null}
      </Flex>

      {note ? (
        <Text size="1" color="gray">
          {note}
        </Text>
      ) : null}
      {state.lastError || error ? (
        <Callout.Root color="red" size="1">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>{error ?? state.lastError}</Callout.Text>
        </Callout.Root>
      ) : null}

      <Flex align="start" justify="between" gap="2">
        <Text size="2" style={{ minWidth: 0, wordBreak: "break-word" }}>
          Watching for:{" "}
          <Text as="span" color="gray">
            {preference}
          </Text>
        </Text>
        <Button
          size="2"
          variant="ghost"
          disabled={busy !== null}
          style={{ flex: "0 0 auto" }}
          onClick={() => void editPreference()}
        >
          <Pencil1Icon /> Edit
        </Button>
      </Flex>

      {state.status === "onboarding" ? (
        <Callout.Root color="blue" size="1">
          <Callout.Icon>
            <GearIcon />
          </Callout.Icon>
          <Callout.Text>
            <Flex direction="column" gap="2" align="start">
              <Text size="1">
                Tell the Gmail agent what mail deserves your attention — tap a preset, type in chat,
                or keep the default (mail from people you have replied to).
              </Text>
              <Flex gap="1" wrap="wrap">
                <Button
                  size="2"
                  variant="soft"
                  disabled={busy !== null}
                  onClick={() =>
                    void run("keep-defaults", "markConfigured", {
                      summary: "Using the default: mail from people you have replied to before.",
                    })
                  }
                >
                  {busy === "keep-defaults" ? "Saving…" : "Keep the default"}
                </Button>
                {ONBOARDING_PRESETS.map((preset) => (
                  <Button
                    key={preset}
                    size="2"
                    variant="surface"
                    disabled={busy !== null}
                    onClick={() => void sendPreset(preset)}
                  >
                    {preset}
                  </Button>
                ))}
              </Flex>
            </Flex>
          </Callout.Text>
        </Callout.Root>
      ) : null}
    </Flex>
  );
}
