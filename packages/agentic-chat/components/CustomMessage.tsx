import React, { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Callout,
  DropdownMenu,
  Flex,
  IconButton,
  Spinner,
  Text,
} from "@radix-ui/themes";
import { DotsHorizontalIcon, ExclamationTriangleIcon, ReloadIcon } from "@radix-ui/react-icons";
import { EventErrorBoundary } from "@workspace/tool-ui/components/EventErrorBoundary";
import { SurfaceFrame } from "@workspace/tool-ui/components/SurfaceFrame";
import type { CustomMessageCardPayload } from "@workspace/agentic-core";
import { foldCustomMessageState, validateCustomState } from "@workspace/agentic-core";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  type AgenticEvent,
  type UiFeedbackCategory,
} from "@workspace/agentic-protocol";
import type { MessageTypeComponentEntry } from "../types";

interface CustomRenderProps {
  payload: CustomMessageCardPayload;
  entry?: MessageTypeComponentEntry;
  chat: Record<string, unknown>;
}

interface ReadyCustomRenderProps extends CustomRenderProps {
  entry: Extract<MessageTypeComponentEntry, { status: "ready" }>;
  expanded: boolean;
}

function useFoldedState(
  payload: CustomMessageCardPayload,
  entry?: MessageTypeComponentEntry
): unknown {
  return useMemo(() => {
    if (entry?.status !== "ready") return payload.initialState;
    return foldCustomMessageState(payload.initialState, payload.updates, entry.module.reduce);
  }, [entry, payload.initialState, payload.lastSeq, payload.updates]);
}

/**
 * Full inspectable snapshot of a custom message: the wire payload, the
 * registry's internal state for its type (including which load stage a
 * spinner is parked on), and the folded state. This is what "Copy details"
 * puts on the clipboard — the custom-message equivalent of a tool bead's
 * invocation details.
 */
export function customInspectorPayload(
  payload: CustomMessageCardPayload,
  entry: MessageTypeComponentEntry | undefined
): Record<string, unknown> {
  const definition = entry && "definition" in entry ? entry.definition : undefined;
  return {
    message: {
      messageId: payload.messageId,
      typeId: payload.typeId,
      displayMode: payload.displayMode,
      by: payload.by,
      lastSeq: payload.lastSeq,
      updateCount: payload.updates.length,
      failed: payload.failed ?? false,
      error: payload.error,
      initialState: payload.initialState,
      updates: payload.updates,
    },
    registry: !entry
      ? { status: "missing", note: "no registry entry — type never entered fetch/compile" }
      : entry.status === "ready"
        ? {
            status: "ready",
            cacheKey: entry.cacheKey,
            hasReduce: typeof entry.module.reduce === "function",
            hasPill: Boolean(entry.module.Pill),
          }
        : entry.status === "loading"
          ? {
              status: "loading",
              stage: entry.stage ?? "unknown",
              stageStartedAt: entry.startedAt ? new Date(entry.startedAt).toISOString() : undefined,
              stageElapsedMs: entry.startedAt ? Date.now() - entry.startedAt : undefined,
            }
          : {
              status: "error",
              message: entry.message,
              updatedAtSeq: entry.updatedAtSeq,
            },
    definition: definition
      ? {
          source: definition.cleared ? undefined : definition.source,
          updatedAtSeq: definition.updatedAtSeq,
          cleared: definition.cleared ?? false,
          imports: definition.imports,
          hasStateSchema: Boolean(definition.stateSchema),
          hasUpdateSchema: Boolean(definition.updateSchema),
        }
      : undefined,
  };
}

/**
 * Compact "⋯" actions menu for custom message cards: Copy details, plus
 * optional Inspect toggle and Collapse. Replaces the previous row of inline
 * text buttons — diagnostics are one click away instead of always-on chrome.
 */
function CardActionsMenu({
  payload,
  entry,
  inspectOpen,
  onToggleInspect,
  onCollapse,
}: {
  payload: CustomMessageCardPayload;
  entry?: MessageTypeComponentEntry;
  inspectOpen?: boolean;
  onToggleInspect?: () => void;
  onCollapse?: (() => void) | undefined;
}) {
  const copy = useCallback(async () => {
    const details = customInspectorPayload(payload, entry);
    await navigator.clipboard.writeText(JSON.stringify(details, null, 2));
  }, [payload, entry]);
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger>
        <IconButton
          size="1"
          color="gray"
          variant="ghost"
          aria-label="Card actions"
          title="Card actions"
          style={{ marginLeft: "auto" }}
        >
          <DotsHorizontalIcon />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        <DropdownMenu.Item onSelect={() => void copy()}>Copy details</DropdownMenu.Item>
        {onToggleInspect && (
          <DropdownMenu.Item onSelect={onToggleInspect}>
            {inspectOpen ? "Hide inspector" : "Inspect"}
          </DropdownMenu.Item>
        )}
        {onCollapse && <DropdownMenu.Item onSelect={onCollapse}>Collapse</DropdownMenu.Item>}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

const LOADING_STAGE_LABELS: Record<string, string> = {
  "fetching-definition": "Fetching type definition from the channel registry",
  "loading-source": "Loading renderer source file",
  compiling: "Compiling renderer",
};

function CustomRenderer({ payload, entry, expanded, chat }: ReadyCustomRenderProps) {
  const state = useFoldedState(payload, entry);
  // Validate folded state against the registered JSON Schema before handing it
  // to the component. The same document was enforced at agent emission time;
  // a failure here means the fold (custom reduce) diverged — report it.
  const validationErrors = useMemo(
    () =>
      validateCustomState(
        entry.definition.cleared ? undefined : entry.definition.stateSchema,
        state
      ),
    [entry, state]
  );
  if (validationErrors) {
    return (
      <>
        <CustomMessageValidationError
          typeId={payload.typeId}
          errors={validationErrors}
          compact={!expanded}
        />
        {expanded && (
          <UiFeedbackReporter
            chat={chat}
            payload={payload}
            category="state_invalid"
            errorMessage={validationErrors.join("; ")}
            occurrenceKey={`state_invalid:${payload.messageId}:${payload.lastSeq}`}
          />
        )}
      </>
    );
  }
  // Prefer a dedicated `Pill` export for the collapsed inline view; otherwise the
  // default component handles both states via `expanded`.
  const Component = (!expanded && entry.module.Pill) || entry.module.default;
  if (!Component) {
    return (
      <Text size="1" color="blue" weight="medium">
        {payload.typeId}
      </Text>
    );
  }
  return (
    <Component
      messageId={payload.messageId}
      typeId={payload.typeId}
      state={state}
      expanded={expanded}
      displayMode={payload.displayMode}
      chat={chat}
    />
  );
}

export const CustomPill = React.memo(function CustomPill({
  id,
  payload,
  entry,
  expanded,
  chat,
  onExpand,
}: CustomRenderProps & {
  id: string;
  expanded: boolean;
  onExpand: (id: string) => void;
}) {
  if (payload.failed) {
    return (
      <Flex align="center" gap="1" style={pillStyle("red")} title={payload.error?.message}>
        <Badge color="red" size="1">
          Failed
        </Badge>
        <Text size="1" color="red" weight="medium">
          {payload.typeId}
        </Text>
      </Flex>
    );
  }
  if (!entry || entry.status === "loading") {
    const stage = entry?.status === "loading" ? entry.stage : undefined;
    return (
      <Flex
        align="center"
        gap="1"
        style={pillStyle("gray", true)}
        title={`${payload.typeId} — ${stage ? (LOADING_STAGE_LABELS[stage] ?? stage) : "waiting for type registry"}. Click for details.`}
        onClick={() => onExpand(id)}
        tabIndex={0}
        role="button"
        aria-expanded={expanded}
      >
        <Spinner size="1" />
        <Text size="1" color="gray" weight="medium">
          {payload.typeId}
        </Text>
      </Flex>
    );
  }
  if (entry.status === "error") {
    return (
      <Flex
        align="center"
        gap="1"
        style={pillStyle("red")}
        title={`${entry.message}. Click for details.`}
        onClick={() => onExpand(id)}
        tabIndex={0}
        role="button"
        aria-expanded={expanded}
      >
        <Text size="1" color="red" weight="medium">
          {payload.typeId}
        </Text>
        {entry.retry && (
          <Button
            size="1"
            variant="ghost"
            color="red"
            onClick={(event) => {
              event.stopPropagation();
              entry.retry?.();
            }}
          >
            <ReloadIcon width={10} height={10} />
          </Button>
        )}
      </Flex>
    );
  }
  const resetKey = customResetKey(payload, entry, expanded);
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onExpand(id);
  };
  return (
    <Flex
      align="center"
      gap="1"
      style={pillStyle("blue")}
      onClick={() => onExpand(id)}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-expanded={expanded}
    >
      <EventErrorBoundary
        resetKey={resetKey}
        renderFallback={(error) => (
          <CustomMessageErrorFallback error={error} payload={payload} chat={chat} compact />
        )}
      >
        <Suspense fallback={<Spinner size="1" />}>
          <CustomRenderer payload={payload} entry={entry} expanded={expanded} chat={chat} />
        </Suspense>
      </EventErrorBoundary>
    </Flex>
  );
});

export const ExpandedCustom = React.memo(function ExpandedCustom({
  payload,
  entry,
  expanded,
  chat,
  onCollapse,
}: CustomRenderProps & {
  expanded: boolean;
  onCollapse?: () => void;
}) {
  if (payload.failed) {
    return <CustomFailedCard payload={payload} entry={entry} />;
  }
  if (!entry || entry.status !== "ready" || !entry.module.default) {
    return (
      <CustomDiagnosticCard
        payload={payload}
        entry={entry}
        chat={chat}
        onCollapse={onCollapse}
        overrideMessage={
          entry?.status === "ready" && !entry.module.default
            ? "Message type has no default export"
            : undefined
        }
      />
    );
  }
  const resetKey = customResetKey(payload, entry, expanded);
  return (
    <ReadyCustomCard payload={payload} entry={entry} onCollapse={onCollapse} resetKey={resetKey}>
      <Box>
        <EventErrorBoundary
          resetKey={resetKey}
          renderFallback={(error) => (
            <CustomMessageErrorFallback error={error} payload={payload} chat={chat} />
          )}
        >
          <Suspense fallback={<Spinner size="1" />}>
            <CustomRenderer payload={payload} entry={entry} expanded={expanded} chat={chat} />
          </Suspense>
        </EventErrorBoundary>
      </Box>
    </ReadyCustomCard>
  );
});

/**
 * Card frame for a ready custom message: typeId header, Copy details, an
 * Inspect toggle (metadata + update history with fold previews), and an
 * optional Collapse affordance for inline-mode cards.
 */
function ReadyCustomCard({
  payload,
  entry,
  onCollapse,
  children,
}: {
  payload: CustomMessageCardPayload;
  entry: Extract<MessageTypeComponentEntry, { status: "ready" }>;
  onCollapse?: (() => void) | undefined;
  resetKey: string;
  children: React.ReactNode;
}) {
  const [inspectOpen, setInspectOpen] = useState(false);
  return (
    <SurfaceFrame
      className="message-card"
      title={payload.typeId}
      tone="blue"
      onHeaderClick={onCollapse}
      actions={
        <CardActionsMenu
          payload={payload}
          entry={entry}
          inspectOpen={inspectOpen}
          onToggleInspect={() => setInspectOpen((open) => !open)}
          onCollapse={onCollapse}
        />
      }
    >
      {inspectOpen && (
        <Flex direction="column" gap="1" mb="2">
          <MetaRow label="message" value={payload.messageId} />
          <MetaRow
            label="owner"
            value={payload.by ? `${payload.by.kind}:${payload.by.id}` : "unknown"}
          />
          <MetaRow label="cacheKey" value={entry.cacheKey} />
          {!entry.definition.cleared && entry.definition.source && (
            <MetaRow
              label="source"
              value={
                entry.definition.source.type === "file"
                  ? entry.definition.source.path
                  : "inline code"
              }
            />
          )}
          <Text size="1" color="gray" weight="medium" mt="1">
            Update history
          </Text>
          <CustomUpdateHistory payload={payload} reducer={entry.module.reduce} />
        </Flex>
      )}
      {children}
    </SurfaceFrame>
  );
}

export function CustomMessageCard(props: CustomRenderProps) {
  return <ExpandedCustom {...props} expanded={true} />;
}

/** Standard frame for cards whose owner published a terminal failure. */
function CustomFailedCard({
  payload,
  entry,
}: {
  payload: CustomMessageCardPayload;
  entry?: MessageTypeComponentEntry;
}) {
  return (
    <SurfaceFrame
      className="message-card"
      title={payload.typeId}
      tone="red"
      badge={
        <Badge color="red" size="1">
          Failed
        </Badge>
      }
      actions={<CardActionsMenu payload={payload} entry={entry} />}
    >
      <Callout.Root color="red" size="1">
        <Callout.Icon>
          <ExclamationTriangleIcon />
        </Callout.Icon>
        <Text as="div" size="2" className="rt-CalloutText">
          <Flex direction="column" gap="1">
            <Text size="1" weight="medium">
              {payload.typeId} failed
            </Text>
            <Text size="1" color="red">
              {payload.error?.message ?? "The agent reported a failure for this card."}
            </Text>
          </Flex>
        </Text>
      </Callout.Root>
    </SurfaceFrame>
  );
}

/** Elapsed time since `startedAt`, refreshed every second while mounted. */
function useElapsedSeconds(startedAt: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [startedAt]);
  return startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : null;
}

/**
 * Pretty-rendered inspector for a custom message that has no renderable
 * component yet (type loading, load stuck, compile failed). The custom-message
 * counterpart of an expanded tool bead: status, stage + elapsed, definition
 * metadata, payload summary, Retry, and Copy details for the raw JSON.
 */
/** Stage residency beyond this is reported to the owning agent as stalled. */
const LOAD_STALL_FEEDBACK_SECONDS = 30;

function CustomDiagnosticCard({
  payload,
  entry,
  chat,
  onCollapse,
  overrideMessage,
}: {
  payload: CustomMessageCardPayload;
  entry?: MessageTypeComponentEntry;
  chat?: Record<string, unknown>;
  onCollapse?: (() => void) | undefined;
  overrideMessage?: string | undefined;
}) {
  const loading = !entry || entry.status === "loading";
  const stage = entry?.status === "loading" ? entry.stage : undefined;
  const startedAt = entry?.status === "loading" ? entry.startedAt : undefined;
  const elapsed = useElapsedSeconds(startedAt);
  const stalled = loading && stage !== undefined && (elapsed ?? 0) >= LOAD_STALL_FEEDBACK_SECONDS;
  const errorMessage = overrideMessage ?? (entry?.status === "error" ? entry.message : undefined);
  const retry = entry?.status === "error" ? entry.retry : undefined;
  const definition = entry && "definition" in entry ? entry.definition : undefined;
  const color = loading ? "gray" : "red";
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <SurfaceFrame
      className="message-card"
      title={payload.typeId}
      tone={loading ? "gray" : "red"}
      icon={loading ? <Spinner size="1" /> : <ExclamationTriangleIcon />}
      subtitle={
        loading
          ? stage
            ? (LOADING_STAGE_LABELS[stage] ?? stage)
            : "waiting for registry"
          : errorMessage
      }
      badge={
        <Badge color={color} size="1" variant="soft">
          {loading ? (stage ?? "waiting") : "error"}
        </Badge>
      }
      actions={
        <Flex align="center" gap="1">
          {retry && (
            <Button size="1" variant="soft" color="red" onClick={retry}>
              <ReloadIcon width={11} height={11} /> Retry
            </Button>
          )}
          <CardActionsMenu payload={payload} entry={entry} onCollapse={onCollapse} />
        </Flex>
      }
    >
      {stalled && chat && (
        <UiFeedbackReporter
          chat={chat}
          payload={payload}
          category="load_stalled"
          errorMessage={`Renderer for ${payload.typeId} stuck in stage "${stage}" for ${elapsed}s`}
          occurrenceKey={`load_stalled:${payload.typeId}:${stage}`}
        />
      )}
      <Flex direction="column" gap="2">
        {loading && (
          <Text size="1" color="gray">
            {stage
              ? (LOADING_STAGE_LABELS[stage] ?? stage)
              : "No registry entry yet — the type was never fetched or compiled."}
            {elapsed !== null ? ` — ${elapsed}s in this stage` : ""}
          </Text>
        )}
        {errorMessage && (
          <Text size="1" color="red">
            {errorMessage}
          </Text>
        )}
        <Text
          size="1"
          color="gray"
          onClick={() => setDetailsOpen((open) => !open)}
          style={{ cursor: "pointer", userSelect: "none" }}
          aria-expanded={detailsOpen}
          role="button"
        >
          {detailsOpen ? "▾ Details" : "▸ Details"}
        </Text>
        {detailsOpen && (
          <Flex direction="column" gap="1">
            <MetaRow label="message" value={payload.messageId} />
            <MetaRow
              label="owner"
              value={payload.by ? `${payload.by.kind}:${payload.by.id}` : "unknown"}
            />
            <MetaRow
              label="updates"
              value={`${payload.updates.length} (lastSeq ${payload.lastSeq})`}
            />
            {definition && !definition.cleared && definition.source && (
              <MetaRow
                label="source"
                value={definition.source.type === "file" ? definition.source.path : "inline code"}
              />
            )}
            {definition && (
              <MetaRow
                label="registered"
                value={`seq ${definition.updatedAtSeq}${definition.cleared ? " (cleared)" : ""}${definition.stateSchema ? ", stateSchema" : ""}${definition.updateSchema ? ", updateSchema" : ""}`}
              />
            )}
            {definition?.imports && (
              <MetaRow label="imports" value={Object.keys(definition.imports).join(", ")} />
            )}
            <Text size="1" color="gray" weight="medium" mt="1">
              Update history
            </Text>
            <CustomUpdateHistory payload={payload} />
          </Flex>
        )}
      </Flex>
    </SurfaceFrame>
  );
}

function previewJson(value: unknown, max = 200): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "undefined";
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Per-update history with progressive fold previews: shows each
 * `custom.updated` payload and the state it produced, so a reducer bug is
 * visible as "state went wrong at seq N" instead of a mystery.
 */
function CustomUpdateHistory({
  payload,
  reducer,
}: {
  payload: CustomMessageCardPayload;
  reducer?: ((state: unknown, update: unknown) => unknown) | undefined;
}) {
  const steps = useMemo(() => {
    let state: unknown = payload.initialState;
    const folded: Array<{ seq: number; update: unknown; state: unknown; error?: string }> = [];
    for (const item of payload.updates) {
      if (reducer) {
        try {
          state = reducer(state, item.update);
          folded.push({ seq: item.seq, update: item.update, state });
        } catch (err) {
          folded.push({
            seq: item.seq,
            update: item.update,
            state,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        state = item.update;
        folded.push({ seq: item.seq, update: item.update, state });
      }
    }
    return folded;
  }, [payload.initialState, payload.updates, reducer]);

  if (payload.updates.length === 0) {
    return (
      <Text size="1" color="gray">
        No updates — state is the initial state: {previewJson(payload.initialState)}
      </Text>
    );
  }
  return (
    <Flex direction="column" gap="1">
      <MetaRow label="initial" value={previewJson(payload.initialState)} />
      {steps.map((step) => (
        <Flex key={step.seq} direction="column" gap="0">
          <MetaRow label={`seq ${step.seq}`} value={previewJson(step.update)} />
          {step.error ? (
            <Text size="1" color="red" style={{ marginLeft: 80 }}>
              reducer threw: {step.error} (state kept)
            </Text>
          ) : (
            <Text size="1" color="gray" style={{ marginLeft: 80, wordBreak: "break-all" }}>
              → {previewJson(step.state)}
            </Text>
          )}
        </Flex>
      ))}
    </Flex>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <Flex gap="2" align="center">
      <Text size="1" color="gray" style={{ minWidth: 72 }}>
        {label}
      </Text>
      <Text
        size="1"
        style={{ fontFamily: "var(--code-font-family, monospace)", wordBreak: "break-all" }}
      >
        {value}
      </Text>
    </Flex>
  );
}

type FeedbackDeliveryState = "sending" | "sent" | "failed";

/**
 * Publishes a `ui.feedback` event targeted at the card owner when mounted.
 * Mounting happens exactly when the failure is shown, so the agent hears about
 * every failure the user sees — deduplicated by occurrenceKey on the harness
 * side and by idempotencyKey on the channel side.
 */
function UiFeedbackReporter({
  chat,
  payload,
  category,
  errorMessage,
  errorName,
  stack,
  componentStack,
  occurrenceKey,
  onDelivery,
}: {
  chat: Record<string, unknown>;
  payload: CustomMessageCardPayload;
  category: UiFeedbackCategory;
  errorMessage: string;
  errorName?: string;
  stack?: string;
  componentStack?: string;
  occurrenceKey: string;
  onDelivery?: (state: FeedbackDeliveryState) => void;
}) {
  useEffect(() => {
    let cancelled = false;
    const publish = chat["publish"];
    if (typeof publish !== "function" || !payload.by) {
      onDelivery?.("failed");
      return;
    }
    const event: AgenticEvent<"ui.feedback"> = {
      kind: "ui.feedback",
      actor: { kind: "panel", id: "chat" },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        target: {
          kind: payload.by.kind as never,
          id: payload.by.id,
          participantId: payload.by.participantId ?? payload.by.id,
        },
        to: [
          {
            kind: "participant",
            participantId: payload.by.participantId ?? payload.by.id,
          },
        ],
        category,
        refs: { messageId: payload.messageId as never, typeId: payload.typeId },
        error: {
          message: errorMessage,
          ...(errorName ? { name: errorName } : {}),
          ...(stack ? { stack } : {}),
          ...(componentStack ? { componentStack } : {}),
        },
        occurrenceKey,
      },
      createdAt: new Date().toISOString(),
    };
    void (async () => {
      try {
        await (
          publish as (
            kind: string,
            payload: unknown,
            options?: { idempotencyKey?: string }
          ) => Promise<unknown>
        )(AGENTIC_EVENT_PAYLOAD_KIND, event, { idempotencyKey: `ui-feedback:${occurrenceKey}` });
        if (!cancelled) onDelivery?.("sent");
      } catch (publishError) {
        console.warn("Failed to publish ui.feedback diagnostic", publishError);
        if (!cancelled) onDelivery?.("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
    // Publish once per occurrence — occurrenceKey is the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [occurrenceKey]);
  return null;
}

function CustomMessageErrorFallback({
  error,
  payload,
  chat,
  compact = false,
}: {
  error: Error;
  payload: CustomMessageCardPayload;
  chat: Record<string, unknown>;
  compact?: boolean;
}) {
  const [delivery, setDelivery] = useState<FeedbackDeliveryState>("sending");
  const reporter = (
    <UiFeedbackReporter
      chat={chat}
      payload={payload}
      category="render_failed"
      errorMessage={error.message || "Unknown error"}
      errorName={error.name || "Error"}
      stack={error.stack}
      occurrenceKey={`render_failed:${payload.messageId}:${payload.lastSeq}`}
      onDelivery={setDelivery}
    />
  );
  if (compact) {
    return (
      <Flex align="center" gap="1" title={error.message}>
        {reporter}
        <Badge color="red" size="1">
          Error
        </Badge>
        <Text size="1" color="red" weight="medium">
          {payload.typeId}
        </Text>
      </Flex>
    );
  }
  return (
    <Callout.Root color="red" size="1">
      {reporter}
      <Callout.Icon>
        <ExclamationTriangleIcon />
      </Callout.Icon>
      <Text as="div" size="2" className="rt-CalloutText">
        <Flex direction="column" gap="1">
          <Text size="1" weight="medium">
            Custom message error: {payload.typeId}
          </Text>
          <Text size="1" color="red">
            {error.message || "Unknown error"}
          </Text>
          <Text size="1" color="gray">
            {delivery === "sent"
              ? "Reported to the owning agent."
              : delivery === "failed"
                ? "Diagnostic not delivered — the owning agent was not notified."
                : "Reporting to the owning agent…"}
          </Text>
        </Flex>
      </Text>
    </Callout.Root>
  );
}

function CustomMessageValidationError({
  typeId,
  errors,
  compact = false,
}: {
  typeId: string;
  errors: string[];
  compact?: boolean;
}) {
  if (compact) {
    return (
      <Flex align="center" gap="1" title={errors.join("; ")}>
        <Badge color="amber" size="1">
          Invalid
        </Badge>
        <Text size="1" color="amber" weight="medium">
          {typeId}
        </Text>
      </Flex>
    );
  }
  return (
    <Callout.Root color="amber" size="1">
      <Callout.Icon>
        <ExclamationTriangleIcon />
      </Callout.Icon>
      <Text as="div" size="2" className="rt-CalloutText">
        <Flex direction="column" gap="1">
          <Text size="1" weight="medium">
            Invalid {typeId} state
          </Text>
          {errors.map((message, index) => (
            <Text key={index} size="1" color="amber">
              {message}
            </Text>
          ))}
        </Flex>
      </Text>
    </Callout.Root>
  );
}

function customResetKey(
  payload: CustomMessageCardPayload,
  entry: Extract<MessageTypeComponentEntry, { status: "ready" }>,
  expanded: boolean
): string {
  return `${entry.cacheKey}:${payload.messageId}:${payload.lastSeq}:${expanded ? "expanded" : "collapsed"}`;
}

function pillStyle(
  color: "blue" | "gray" | "red",
  clickable = color !== "gray"
): React.CSSProperties {
  return {
    cursor: clickable ? "pointer" : "default",
    userSelect: "none",
    padding: "2px 6px",
    borderRadius: "4px",
    backgroundColor: `var(--${color}-a3)`,
    border: `1px solid var(--${color}-a5)`,
  };
}
