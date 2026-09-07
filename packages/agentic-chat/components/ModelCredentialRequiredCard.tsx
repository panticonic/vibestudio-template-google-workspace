import { useState } from "react";
import { Box, Button, Callout, Card, Code, Flex, Spinner, Text } from "@radix-ui/themes";
import { getVibestudioHostPlatform } from "@workspace/react/responsive";

interface CredentialFlow {
  type?: string;
}

interface ProviderOption {
  providerId: string;
  providerLabel?: string;
  modelRef?: string;
  modelName?: string;
  modelBaseUrl?: string;
  flow?: CredentialFlow;
}

interface ModelCredentialRequiredCardProps {
  providerId?: string;
  modelRef?: string;
  modelBaseUrl?: string;
  flow?: CredentialFlow;
  credentialLabel?: string;
  providerOptions?: ProviderOption[];
  agentParticipantId?: string;
  browserHandoffCallerId?: string;
  browserHandoffCallerKind?: string;
  modelPersistenceParticipantId?: string;
  reason?: string;
  diagnosticReason?: string;
  failureCode?: string;
}

interface ChatApi {
  callMethod: (participantId: string, method: string, args: unknown) => Promise<unknown>;
}

export default function ModelCredentialRequiredCard({
  props = {},
  chat,
}: {
  props?: ModelCredentialRequiredCardProps;
  chat: ChatApi;
}) {
  const providerId = props.providerId ?? "";
  const currentModelRef = typeof props.modelRef === "string" ? props.modelRef : "";
  const fallbackOption: ProviderOption = {
    providerId,
    providerLabel: providerId,
    modelRef: currentModelRef,
    modelName: currentModelRef || providerId,
    modelBaseUrl: props.modelBaseUrl,
    flow: props.flow,
  };
  const providerOptions =
    Array.isArray(props.providerOptions) && props.providerOptions.length > 0
      ? props.providerOptions
      : [fallbackOption];
  const [selectedModelRef, setSelectedModelRef] = useState(
    providerOptions[0]?.modelRef || currentModelRef || providerId
  );
  const selectedOption =
    providerOptions.find((option) => option.modelRef === selectedModelRef) ??
    providerOptions[0] ??
    fallbackOption;
  const selectedProviderId = selectedOption.providerId || providerId;
  const selectedModelBaseUrl = selectedOption.modelBaseUrl || props.modelBaseUrl;
  const selectedFlow = selectedOption.flow || props.flow;
  const reconnectReason =
    typeof props.reason === "string" && props.reason.trim() ? props.reason : "";
  const diagnosticReason =
    typeof props.diagnosticReason === "string" && props.diagnosticReason.trim()
      ? props.diagnosticReason
      : "";
  const failureCode =
    typeof props.failureCode === "string" && props.failureCode.trim() ? props.failureCode : "";
  const [status, setStatus] = useState<"idle" | "starting" | "waiting" | "done" | "error">("idle");
  const [activeOpenMode, setActiveOpenMode] = useState<"internal" | "external" | null>(null);
  const [error, setError] = useState("");

  const startCredential = async (openMode: "internal" | "external") => {
    if (!selectedFlow || !selectedModelBaseUrl) return;
    setStatus("starting");
    setActiveOpenMode(openMode);
    setError("");
    try {
      if (!props.agentParticipantId) {
        throw new Error("Missing agent participant for credential setup");
      }
      if (selectedOption.modelRef && selectedOption.modelRef !== currentModelRef) {
        await chat.callMethod(props.agentParticipantId, "setModel", {
          model: selectedOption.modelRef,
        });
        if (props.modelPersistenceParticipantId) {
          void chat
            .callMethod(props.modelPersistenceParticipantId, "persist_agent_model", {
              participantId: props.agentParticipantId,
              model: selectedOption.modelRef,
            })
            .catch((err: unknown) => {
              console.warn("[ModelCredentialRequiredCard] model persistence failed:", err);
            });
        }
      }
      setStatus("waiting");
      await chat.callMethod(props.agentParticipantId, "connectModelCredential", {
        providerId: selectedProviderId,
        modelBaseUrl: selectedModelBaseUrl,
        modelRef: selectedOption.modelRef,
        browserOpenMode: openMode,
        browserHandoffCallerId: props.browserHandoffCallerId,
        browserHandoffCallerKind: props.browserHandoffCallerKind,
      });
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    } finally {
      setActiveOpenMode(null);
    }
  };

  const busy = status === "starting" || status === "waiting";
  const workspaceBrowserAvailable = getVibestudioHostPlatform() !== "mobile";
  const unsupported = !selectedFlow || !selectedModelBaseUrl;
  const apiKeyFlow = selectedFlow?.type === "api-key";
  const browserChoicePrompt = reconnectReason
    ? "Choose the browser that is signed in to the account you want to reconnect. If neither is signed in, pick the one you want to use."
    : "Choose the browser that is already signed in to the account you want to connect. If neither is signed in, pick the one you want to use.";
  const internalBrowserLabel = reconnectReason
    ? "Refresh in workspace browser"
    : "Use workspace browser";
  const externalBrowserLabel = reconnectReason ? "Refresh in system browser" : "Use system browser";
  const apiKeyButtonLabel =
    status === "done"
      ? "Connected"
      : status === "error"
        ? "Try Again"
        : reconnectReason
          ? "Update API Key"
          : "Enter API Key";

  return (
    <Card variant="surface" size="2">
      <Flex direction="column" gap="3">
        <Box>
          <Text as="div" size="2" weight="medium">
            {reconnectReason ? "Credential needs refresh for " : "Credential required for "}
            {providerId}
          </Text>
          <Text as="div" size="1" color="gray" mt="1">
            {reconnectReason ? "Refresh the saved" : "Connect a"} URL-bound model credential for{" "}
            <Code size="1">{selectedModelBaseUrl || selectedProviderId}</Code>.
          </Text>
        </Box>
        {providerOptions.length > 1 ? (
          <Flex direction="column" gap="1">
            {providerOptions.map((option) => {
              const selected = option.modelRef === selectedOption.modelRef;
              return (
                <Button
                  key={option.modelRef || option.providerId}
                  type="button"
                  size="1"
                  variant={selected ? "solid" : "soft"}
                  color={selected ? undefined : "gray"}
                  onClick={() => {
                    setSelectedModelRef(option.modelRef || option.providerId);
                    setError("");
                    setActiveOpenMode(null);
                    if (status !== "done") setStatus("idle");
                  }}
                  disabled={busy}
                  style={{ justifyContent: "flex-start" }}
                >
                  <Text size="1" weight="medium">
                    {option.providerLabel || option.providerId}
                  </Text>
                  <Text size="1" color={selected ? undefined : "gray"}>
                    {option.modelName || option.modelRef}
                  </Text>
                </Button>
              );
            })}
          </Flex>
        ) : null}
        {reconnectReason ? (
          <Callout.Root color="amber" size="1">
            <Callout.Text>{reconnectReason}</Callout.Text>
          </Callout.Root>
        ) : null}
        {diagnosticReason || failureCode ? (
          <Box>
            <Text as="div" size="1" color="gray">
              Diagnostic
            </Text>
            <Code size="1">
              {failureCode ? `${failureCode}: ` : ""}
              {diagnosticReason || "No provider details available."}
            </Code>
          </Box>
        ) : null}
        {unsupported ? (
          <Callout.Root color="amber" size="1">
            <Callout.Text>No built-in setup is available for this model provider.</Callout.Text>
          </Callout.Root>
        ) : null}
        {status === "done" ? (
          <Callout.Root color="green" size="1">
            <Callout.Text>Credential connected. Continuing...</Callout.Text>
          </Callout.Root>
        ) : null}
        {error ? (
          <Callout.Root color="red" size="1">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        ) : null}
        {apiKeyFlow ? (
          <Flex gap="2" wrap="wrap">
            <Button
              size="1"
              onClick={() => void startCredential("internal")}
              disabled={busy || unsupported || status === "done"}
            >
              {busy ? <Spinner size="1" /> : null}
              {apiKeyButtonLabel}
            </Button>
          </Flex>
        ) : (
          <Flex direction="column" gap="2">
            <Text as="div" size="1" color="gray">
              {browserChoicePrompt}
            </Text>
            <Flex direction="column" gap="2">
              {workspaceBrowserAvailable ? (
                <Button
                  size="1"
                  onClick={() => void startCredential("internal")}
                  disabled={busy || unsupported || status === "done"}
                  style={{
                    alignItems: "flex-start",
                    height: "auto",
                    justifyContent: "flex-start",
                    paddingBottom: 8,
                    paddingTop: 8,
                    textAlign: "left",
                    whiteSpace: "normal",
                  }}
                >
                  {busy && activeOpenMode === "internal" ? <Spinner size="1" /> : null}
                  <Flex direction="column" gap="1" align="start">
                    <Text as="span" size="1" weight="medium">
                      {internalBrowserLabel}
                    </Text>
                    <Text as="span" size="1">
                      Choose this when the account is signed in inside this workspace.
                    </Text>
                  </Flex>
                </Button>
              ) : null}
              <Button
                size="1"
                variant="soft"
                onClick={() => void startCredential("external")}
                disabled={busy || unsupported || status === "done"}
                style={{
                  alignItems: "flex-start",
                  height: "auto",
                  justifyContent: "flex-start",
                  paddingBottom: 8,
                  paddingTop: 8,
                  textAlign: "left",
                  whiteSpace: "normal",
                }}
              >
                {busy && activeOpenMode === "external" ? <Spinner size="1" /> : null}
                <Flex direction="column" gap="1" align="start">
                  <Text as="span" size="1" weight="medium">
                    {externalBrowserLabel}
                  </Text>
                  <Text as="span" size="1" color="gray">
                    Choose this when your regular browser already has the right account.
                  </Text>
                </Flex>
              </Button>
            </Flex>
          </Flex>
        )}
      </Flex>
    </Card>
  );
}
