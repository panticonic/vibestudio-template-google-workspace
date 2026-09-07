import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Flex,
  Heading,
  Progress,
  Spinner,
  Text,
} from "@radix-ui/themes";
import {
  CheckCircledIcon,
  DownloadIcon,
  ExclamationTriangleIcon,
  ExternalLinkIcon,
} from "@radix-ui/react-icons";
import type { ModelCatalogEntry } from "@workspace/agentic-core";
import {
  LOCAL_DEFAULT_MODEL,
  LOCAL_DEFAULT_MODEL_REF,
  LOCAL_FALLBACK_MODEL,
  LOCAL_FALLBACK_MODEL_REF,
  LOCAL_PROVIDER_ID,
} from "@workspace/model-catalog/catalog";

export interface ModelSetupStatusProps {
  model: ModelCatalogEntry;
  providerLabel: string;
  pending: boolean;
  onSetup?: () => void;
  onOpenLocalModels?: () => void;
  onOpenLocalModelLog?: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function bundledDownloadSize(modelRef: string): number | null {
  if (modelRef === LOCAL_DEFAULT_MODEL_REF) return LOCAL_DEFAULT_MODEL.downloadSizeBytes;
  if (modelRef === LOCAL_FALLBACK_MODEL_REF) return LOCAL_FALLBACK_MODEL.downloadSizeBytes;
  return null;
}

function DownloadProgress({
  availability,
  onOpenLocalModels,
}: {
  availability: Extract<ModelCatalogEntry["availability"], { state: "downloading" }>;
  onOpenLocalModels?: () => void;
}) {
  const percentage = Math.max(0, Math.min(100, Math.round(availability.progress * 100)));
  const phaseLabel =
    availability.phase === "paused"
      ? "Download paused"
      : availability.phase === "queued"
        ? "Waiting to download"
        : "Downloading and verifying";

  return (
    <Card size="2" variant="surface" data-surface-tone="selected">
      <Flex direction="column" gap="3">
        <Flex justify="between" align="center" gap="3">
          <Flex align="center" gap="2">
            {availability.phase === "active" ? <Spinner size="1" /> : <DownloadIcon />}
            <Text size="2" weight="medium">
              {phaseLabel}
            </Text>
          </Flex>
          <Text size="2" weight="bold">
            {percentage}%
          </Text>
        </Flex>
        <Progress value={percentage} size="2" />
        <Flex justify="between" align="center" gap="3" wrap="wrap">
          <Text size="1" color="gray">
            {formatBytes(availability.receivedBytes)}
            {availability.totalBytes
              ? ` of ${formatBytes(availability.totalBytes)}`
              : " downloaded"}
            {" · "}The conversation will remain queued until installation finishes.
          </Text>
          {onOpenLocalModels ? (
            <Button size="1" variant="ghost" color="gray" onClick={onOpenLocalModels}>
              Manage download <ExternalLinkIcon />
            </Button>
          ) : null}
        </Flex>
      </Flex>
    </Card>
  );
}

export function ModelSetupStatus({
  model,
  providerLabel,
  pending,
  onSetup,
  onOpenLocalModels,
  onOpenLocalModelLog,
}: ModelSetupStatusProps) {
  const availability = model.availability;
  const local = model.provider === LOCAL_PROVIDER_ID;

  if (availability.state === "downloading") {
    return <DownloadProgress availability={availability} onOpenLocalModels={onOpenLocalModels} />;
  }

  if (availability.state === "starting") {
    return (
      <Card size="2" variant="surface" data-surface-tone="selected">
        <Flex align="center" gap="3">
          <Spinner />
          <Box>
            <Text size="2" weight="medium" as="p">
              Preparing {model.name}
            </Text>
            <Text size="1" color="gray" as="p">
              The conversation will start only after the model reports ready.
            </Text>
          </Box>
        </Flex>
      </Card>
    );
  }

  if (availability.state === "error") {
    return (
      <Callout.Root color="red" size="1">
        <Callout.Icon>
          <ExclamationTriangleIcon />
        </Callout.Icon>
        <Callout.Text>
          <Flex direction="column" gap="2" align="start">
            <Text>{availability.message}</Text>
            <Flex gap="2" wrap="wrap">
              {local && onOpenLocalModels ? (
                <Button size="1" variant="soft" color="red" onClick={onOpenLocalModels}>
                  Manage local model <ExternalLinkIcon />
                </Button>
              ) : null}
              {onOpenLocalModelLog ? (
                <Button size="1" variant="ghost" color="red" onClick={onOpenLocalModelLog}>
                  Open logs <ExternalLinkIcon />
                </Button>
              ) : null}
            </Flex>
          </Flex>
        </Callout.Text>
      </Callout.Root>
    );
  }

  if (availability.state === "ready" || availability.state === "startable") {
    return (
      <Flex align="center" gap="2" className="first-agent-ready-status">
        <CheckCircledIcon color="var(--green-9)" />
        <Text size="1" color="gray">
          {availability.state === "ready"
            ? `${model.name} is ready.`
            : `${model.name} is installed and will load when the agent starts.`}
        </Text>
      </Flex>
    );
  }

  if (local) {
    const downloadSize = bundledDownloadSize(model.ref);
    return (
      <Card size="2" variant="surface" data-surface-tone="selected">
        <Flex direction="column" gap="3">
          <Flex align="start" gap="3">
            <Box className="first-agent-setup-status-icon">
              <DownloadIcon />
            </Box>
            <Box>
              <Flex align="center" gap="2" wrap="wrap">
                <Heading size="3">Install {model.name}</Heading>
                {downloadSize !== null ? (
                  <Badge size="1" variant="soft" color="gray">
                    approximately {formatBytes(downloadSize)}
                  </Badge>
                ) : null}
              </Flex>
              <Text size="1" color="gray" as="p" mt="1">
                Vibestudio will download and verify the model before starting your conversation. It
                runs privately on this device and works offline after installation.
              </Text>
            </Box>
          </Flex>
          <Flex gap="2" wrap="wrap">
            <Button size="2" loading={pending} onClick={() => onSetup?.()}>
              <DownloadIcon /> Download & install
            </Button>
            {onOpenLocalModels ? (
              <Button size="2" variant="soft" color="gray" onClick={onOpenLocalModels}>
                View local models <ExternalLinkIcon />
              </Button>
            ) : null}
          </Flex>
          {pending ? (
            <Text size="1" color="gray">
              Preparing the local runtime, then starting the model download…
            </Text>
          ) : null}
        </Flex>
      </Card>
    );
  }

  if (!model.connectable) {
    return (
      <Callout.Root color="amber" size="1">
        <Callout.Icon>
          <ExclamationTriangleIcon />
        </Callout.Icon>
        <Callout.Text>
          {providerLabel} requires manual provider setup. Choose a provider with guided sign-in or
          configure this provider before starting the agent.
        </Callout.Text>
      </Callout.Root>
    );
  }

  // A connectable remote model is launchable. Credential acquisition belongs
  // to the running agent, so there is no prerequisite or procedure to explain
  // on this configuration surface.
  return null;
}
