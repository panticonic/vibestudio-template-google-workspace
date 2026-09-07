/**
 * Two-step provider/model selection for agent setup.
 *
 * Provider and model are separate decisions: the provider menu establishes
 * where the agent runs, then the model menu shows only that provider's models.
 * The workspace recommendation stays first instead of being displaced by live
 * availability or by the user's current exploratory selection.
 */

import { useMemo, useRef } from "react";
import {
  Badge,
  Box,
  Flex,
  Progress,
  Select,
  Spinner,
  Text,
  Tooltip,
} from "@radix-ui/themes";
import { HomeIcon, ImageIcon, LightningBoltIcon } from "@radix-ui/react-icons";
import type {
  ModelCatalog,
  ModelCatalogEntry,
  ModelCatalogProvider,
} from "@workspace/agentic-core";
import {
  isModelUsable,
  LOCAL_FALLBACK_MODEL_REF,
  LOCAL_PROVIDER_ID,
  type ModelAvailability,
} from "@workspace/model-catalog/catalog";

export interface ModelPickerProps {
  catalog: ModelCatalog | null;
  /** Currently selected "provider:modelId" ref. */
  value: string;
  onChange: (ref: string) => void;
  /** Workspace-recommended model. Its provider and model remain first. */
  recommendedModelRef?: string | null;
  /** Deep-link a failing local model to its server log. */
  onOpenServerLog?: (server: "utility" | "main") => void;
}

const NEEDS_SETUP: ModelAvailability = {
  state: "needs-setup",
  detail: "no-credential",
};

function availabilityOf(model: ModelCatalogEntry): ModelAvailability {
  return model.availability ?? NEEDS_SETUP;
}

function providerIdFromRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const separator = ref.indexOf(":");
  return separator > 0 ? ref.slice(0, separator) : null;
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function measuredTokensPerSec(model: ModelCatalogEntry): number | null {
  const tokensPerSec = model.tokensPerSec;
  return typeof tokensPerSec === "number" && Number.isFinite(tokensPerSec)
    ? tokensPerSec
    : null;
}

function availabilityRank(model: ModelCatalogEntry): number {
  switch (availabilityOf(model).state) {
    case "ready":
      return 0;
    case "startable":
      return 1;
    case "starting":
    case "downloading":
      return 2;
    case "needs-setup":
      return 3;
    case "error":
      return 4;
  }
}

/** Stable product ordering: recommendation first, experimental local last. */
export function orderModelPickerProviders(
  providers: readonly ModelCatalogProvider[],
  recommendedModelRef: string | null | undefined,
): ModelCatalogProvider[] {
  const recommendedProviderId = providerIdFromRef(recommendedModelRef);
  return [...providers].sort((left, right) => {
    if (left.id === recommendedProviderId)
      return right.id === recommendedProviderId ? 0 : -1;
    if (right.id === recommendedProviderId) return 1;
    if (left.id === LOCAL_PROVIDER_ID)
      return right.id === LOCAL_PROVIDER_ID ? 0 : 1;
    if (right.id === LOCAL_PROVIDER_ID) return -1;
    return left.label.localeCompare(right.label);
  });
}

/** Recommended model first, then live usability, then a predictable name sort. */
export function orderProviderModels(
  models: readonly ModelCatalogEntry[],
  provider: ModelCatalogProvider | null,
  recommendedModelRef: string | null | undefined,
): ModelCatalogEntry[] {
  const recommendation =
    providerIdFromRef(recommendedModelRef) === provider?.id
      ? recommendedModelRef
      : provider?.recommendedModelRef;
  return [...models].sort((left, right) => {
    if (left.ref === recommendation)
      return right.ref === recommendation ? 0 : -1;
    if (right.ref === recommendation) return 1;
    const availability = availabilityRank(left) - availabilityRank(right);
    return availability || left.name.localeCompare(right.name);
  });
}

/** Select the provider's natural default without hiding setup-required models. */
export function modelRefForProvider(
  models: readonly ModelCatalogEntry[],
  provider: ModelCatalogProvider,
  recommendedModelRef: string | null | undefined,
): string | null {
  return (
    orderProviderModels(
      models.filter((model) => model.provider === provider.id),
      provider,
      recommendedModelRef,
    )[0]?.ref ?? null
  );
}

function dotColor(availability: ModelAvailability): string {
  switch (availability.state) {
    case "ready":
      return "var(--green-9)";
    case "startable":
    case "starting":
    case "downloading":
      return "var(--amber-9)";
    case "error":
      return "var(--red-9)";
    default:
      return "var(--gray-7)";
  }
}

function statusLabel(availability: ModelAvailability): string | null {
  switch (availability.state) {
    case "ready":
      return "Ready";
    case "startable":
      return "Loads on use";
    case "starting":
      return "Starting…";
    case "downloading":
      return availability.phase === "paused"
        ? "Download paused"
        : availability.phase === "queued"
          ? "Download queued"
          : `Downloading ${Math.round(availability.progress * 100)}%`;
    case "error":
      return availability.message;
    case "needs-setup":
      switch (availability.detail) {
        case "no-credential":
          return "Not connected";
        case "credential-expired":
          return "Connection expired";
        case "not-installed":
          return "Not installed";
      }
  }
}

function StatusDot({
  availability,
  onOpenLog,
}: {
  availability: ModelAvailability;
  onOpenLog?: () => void;
}) {
  if (availability.state === "downloading" && availability.phase === "active") {
    return <Spinner size="1" />;
  }
  const dot = (
    <Box
      as="span"
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        minWidth: 8,
        borderRadius: 999,
        background: dotColor(availability),
      }}
    />
  );
  if (availability.state !== "error") return dot;
  const content = onOpenLog
    ? `${availability.message} — click to open the server log`
    : availability.message;
  return (
    <Tooltip content={content}>
      {onOpenLog ? (
        <button
          type="button"
          aria-label="Open the failing server's log"
          onClick={onOpenLog}
          style={{
            all: "unset",
            cursor: "pointer",
            display: "inline-flex",
            lineHeight: 0,
          }}
        >
          {dot}
        </button>
      ) : (
        dot
      )}
    </Tooltip>
  );
}

function ModelChips({ model }: { model: ModelCatalogEntry }) {
  const tokensPerSec = measuredTokensPerSec(model);
  return (
    <Flex gap="2" align="center" wrap="wrap">
      {model.provider === LOCAL_PROVIDER_ID ? (
        <Badge color="amber" variant="soft" size="1">
          <HomeIcon width="10" height="10" /> experimental
        </Badge>
      ) : null}
      {model.reasoning ? (
        <Badge color="purple" variant="soft" size="1">
          <LightningBoltIcon width="10" height="10" /> reasoning
        </Badge>
      ) : null}
      {model.vision ? (
        <Badge color="blue" variant="soft" size="1">
          <ImageIcon width="10" height="10" /> vision
        </Badge>
      ) : null}
      <Badge color="gray" variant="soft" size="1">
        {formatContext(model.contextWindow)} context
      </Badge>
      {tokensPerSec !== null ? (
        <Badge
          color={tokensPerSec < 10 ? "amber" : "gray"}
          variant="soft"
          size="1"
        >
          {Math.round(tokensPerSec)} tok/s
        </Badge>
      ) : null}
    </Flex>
  );
}

function PickerLabel({ children }: { children: string }) {
  return (
    <Text size="2" weight="medium">
      {children}
    </Text>
  );
}

export function ModelPicker({
  catalog,
  value,
  onChange,
  recommendedModelRef,
  onOpenServerLog,
}: ModelPickerProps) {
  const models = useMemo(() => catalog?.models ?? [], [catalog]);
  const selectedModel = models.find((model) => model.ref === value) ?? null;
  const selectedProviderId =
    selectedModel?.provider ?? providerIdFromRef(value) ?? "";
  const initialModelRef = useRef<string | null>(null);
  if (!initialModelRef.current && value) initialModelRef.current = value;
  const recommendedRef = recommendedModelRef ?? initialModelRef.current ?? value;
  const recommendedProviderId = providerIdFromRef(recommendedRef);
  const providers = useMemo(
    () => {
      const providerIdsWithModels = new Set(models.map((model) => model.provider));
      return orderModelPickerProviders(
        (catalog?.providers ?? []).filter((provider) => providerIdsWithModels.has(provider.id)),
        recommendedRef,
      );
    },
    [catalog?.providers, models, recommendedRef],
  );
  const selectedProvider =
    providers.find((provider) => provider.id === selectedProviderId) ??
    providers[0] ??
    null;
  const providerModels = useMemo(
    () =>
      orderProviderModels(
        models.filter((model) => model.provider === selectedProvider?.id),
        selectedProvider,
        recommendedRef,
      ),
    [models, recommendedRef, selectedProvider],
  );
  const providerRecommendation =
    providerIdFromRef(recommendedRef) === selectedProvider?.id
      ? recommendedRef
      : selectedProvider?.recommendedModelRef;

  const handleProviderChange = (providerId: string) => {
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider) return;
    const next = modelRefForProvider(models, provider, recommendedRef);
    if (next) onChange(next);
  };

  const selectedAvailability = selectedModel
    ? availabilityOf(selectedModel)
    : null;
  const selectedStatus = selectedAvailability
    ? statusLabel(selectedAvailability)
    : null;
  const selectedOpenLog =
    onOpenServerLog &&
    selectedModel?.provider === LOCAL_PROVIDER_ID &&
    selectedAvailability?.state === "error"
      ? () =>
          onOpenServerLog(
            selectedModel.ref === LOCAL_FALLBACK_MODEL_REF ? "utility" : "main",
          )
      : undefined;

  return (
    <Flex direction="column" gap="3">
      <Flex direction="column" gap="1">
        <PickerLabel>Provider</PickerLabel>
        <Select.Root
          value={selectedProvider?.id ?? ""}
          onValueChange={handleProviderChange}
        >
          <Select.Trigger aria-label="Provider" style={{ width: "100%" }} />
          <Select.Content position="popper">
            {providers.map((provider) => (
              <Select.Item key={provider.id} value={provider.id}>
                {provider.label}
                {provider.id === recommendedProviderId ? " — Recommended" : ""}
                {provider.id === LOCAL_PROVIDER_ID ? " — Experimental" : ""}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        <Text size="1" color="gray">
          {selectedProvider?.id === recommendedProviderId
            ? "Recommended for this workspace"
            : selectedProvider?.id === LOCAL_PROVIDER_ID
              ? "Runs on this device; local inference is experimental"
              : "Choose where model requests are handled"}
        </Text>
      </Flex>

      <Flex direction="column" gap="1">
        <PickerLabel>Model</PickerLabel>
        <Select.Root value={selectedModel?.ref ?? ""} onValueChange={onChange}>
          <Select.Trigger aria-label="Model" style={{ width: "100%" }} />
          <Select.Content position="popper">
            {providerModels.map((model) => (
              <Select.Item key={model.ref} value={model.ref}>
                {model.name}
                {model.ref === providerRecommendation ? " — Recommended" : ""}
                {!isModelUsable(model)
                  ? ` — ${statusLabel(availabilityOf(model))}`
                  : ""}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </Flex>

      {selectedModel && selectedAvailability ? (
        <Box
          p="3"
          style={{
            borderRadius: "var(--radius-3)",
            background: "var(--gray-a2)",
            border: "1px solid var(--gray-a4)",
          }}
        >
          <Flex direction="column" gap="2">
            <Flex align="center" justify="between" gap="3">
              <Flex align="center" gap="2" style={{ minWidth: 0 }}>
                <StatusDot
                  availability={selectedAvailability}
                  onOpenLog={selectedOpenLog}
                />
                <Text size="2" weight="medium" truncate>
                  {selectedModel.name}
                </Text>
              </Flex>
              <Badge
                size="1"
                variant="soft"
                color={
                  selectedAvailability.state === "ready"
                    ? "green"
                    : selectedAvailability.state === "error"
                      ? "red"
                      : "amber"
                }
              >
                {selectedStatus}
              </Badge>
            </Flex>
            <ModelChips model={selectedModel} />
            {selectedAvailability.state === "downloading" ? (
              <Progress
                value={Math.round(selectedAvailability.progress * 100)}
                size="1"
              />
            ) : null}
          </Flex>
        </Box>
      ) : null}
    </Flex>
  );
}
