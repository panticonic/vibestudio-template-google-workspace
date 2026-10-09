import { useState } from "react";
import { Button, Flex, Heading, Text } from "@radix-ui/themes";
import { gmailChatStateArgs } from "@workspace/gmail/chat-state";
import { buildPanelLink, panel } from "@workspace/runtime";
import { AboutThemeRoot, AboutPage } from "@workspace/about-shared/ui";
import GoogleWorkspaceSetup from "@workspace-skills/google-workspace/setup";
import { GOOGLE_GMAIL_SCOPES } from "@workspace/google-workspace/providers";
import type { GoogleOnboardingStatus } from "@workspace-skills/google-workspace";
export default function Welcome() {
  const [status, setStatus] = useState<GoogleOnboardingStatus | null>(null);
  const ready =
    status?.stage === "verified" &&
    Boolean(status.credentialId) &&
    GOOGLE_GMAIL_SCOPES.every((scope) =>
      status.verification?.scopes?.includes(scope),
    );
  return (
    <AboutThemeRoot>
      <AboutPage title="Google Workspace">
        <GoogleWorkspaceSetup onStatus={setStatus} />
        <Flex direction="column" gap="2" mt="4">
          <Heading size="3">Your Gmail assistant</Heading>
          <Text size="2" color="gray">
            Review your inbox, draft a reply, and choose what deserves your
            attention. Drafts wait for your Send action.
          </Text>
          {ready ? (
            <Button asChild>
              <a
                href={buildPanelLink("panels/chat", {
                  stateArgs: gmailChatStateArgs(
                    `google-mail-${panel.slotId}`,
                    status!.credentialId!,
                  ),
                })}
              >
                Open Gmail
              </a>
            </Button>
          ) : (
            <>
              <Button disabled>Open Gmail</Button>
              <Text size="1" color="gray">
                {status?.stage === "verified"
                  ? "Grant Gmail access in the setup above to continue."
                  : "Finish connecting Google in the setup above to continue."}
              </Text>
            </>
          )}
        </Flex>
      </AboutPage>
    </AboutThemeRoot>
  );
}
