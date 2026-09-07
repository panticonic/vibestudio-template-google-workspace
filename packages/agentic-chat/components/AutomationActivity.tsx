import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Code,
  Dialog,
  Flex,
  Grid,
  Select,
  Separator,
  Spinner,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import {
  CheckCircledIcon,
  ClockIcon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
  LightningBoltIcon,
  PauseIcon,
  Pencil2Icon,
  PlayIcon,
} from "@radix-ui/react-icons";
import type {
  AutomationActivityPayload,
  AutomationActivitySnapshot,
  AutomationDefinitionPayload,
} from "@workspace/agentic-core";
import type {
  MissionCharter,
  MissionRecord,
  MissionRunRecord,
} from "@vibestudio/automation/mission";
import {
  canonicalCronExpression,
  canonicalCronTimeZone,
  describeCronSchedule,
} from "@vibestudio/automation/cronSchedule";
import {
  CronScheduleDisplay,
  CronScheduleEditor,
} from "./CronScheduleControls.js";

export interface AutomationUiClient {
  inspect(missionId: string): Promise<AutomationInspection | null>;
  getRun(runId: string): Promise<MissionRunRecord | null>;
  edit(
    missionId: string,
    patch: { name?: string; charter?: MissionCharter },
  ): Promise<MissionRecord>;
  pause(missionId: string): Promise<MissionRecord>;
  resume(missionId: string): Promise<MissionRecord>;
  runNow(missionId: string): Promise<MissionRunRecord>;
  openConversation?(run: MissionRunRecord): void;
}

export interface AutomationInspection {
  automation: MissionRecord;
  recentRuns: MissionRunRecord[];
  totalRuns: number;
  activeRuns: number;
  issueRunsSince: number;
}

export interface AutomationUiRpc {
  call(target: string, method: string, args: unknown[]): Promise<unknown>;
}

const resolvedTargetByRpc = new WeakMap<AutomationUiRpc, Promise<string>>();
const clientByRpc = new WeakMap<AutomationUiRpc, AutomationUiClient>();

export function createAutomationUiClient(
  rpc: AutomationUiRpc,
  openConversation?: (run: MissionRunRecord) => void,
): AutomationUiClient {
  if (!openConversation) {
    const existing = clientByRpc.get(rpc);
    if (existing) return existing;
  }
  const target = () => {
    let targetPromise = resolvedTargetByRpc.get(rpc);
    if (targetPromise) return targetPromise;
    targetPromise = rpc
      .call("main", "workers.resolveService", ["vibestudio.missions.v1"])
      .then((value) => {
        const service = value as { kind?: unknown; targetId?: unknown };
        if (service.kind !== "durable-object" || !service.targetId) {
          throw new Error("The Automations service is unavailable");
        }
        return String(service.targetId);
      })
      .catch((error) => {
        resolvedTargetByRpc.delete(rpc);
        throw error;
      });
    resolvedTargetByRpc.set(rpc, targetPromise);
    return targetPromise;
  };
  const call = async <T,>(method: string, args: unknown[]) =>
    (await rpc.call(await target(), method, args)) as T;
  const client: AutomationUiClient = {
    inspect: async (missionId) => {
      const overview = await call<{ items?: unknown[] }>("overview", [
        { missionId, limit: 1 },
      ]);
      const item = overview.items?.[0] as AutomationInspection | undefined;
      return item?.automation?.missionId === missionId ? item : null;
    },
    getRun: (runId) => call("getRun", [runId]),
    edit: (missionId, patch) => call("edit", [missionId, patch]),
    pause: (missionId) => call("pause", [missionId]),
    resume: (missionId) => call("resume", [missionId]),
    runNow: (missionId) => call("runNow", [missionId]),
    ...(openConversation ? { openConversation } : {}),
  };
  if (!openConversation) clientByRpc.set(rpc, client);
  return client;
}

interface AutomationActivitySharedProps {
  client: AutomationUiClient;
  automation?: MissionRecord | null;
  display?: "pill" | "row";
  onChanged?(automation: MissionRecord): void;
}

export type AutomationActivityProps =
  | (AutomationActivitySharedProps & {
      activity: AutomationActivityPayload;
      definition?: never;
      run?: MissionRunRecord | null;
    })
  | (AutomationActivitySharedProps & {
      definition: AutomationDefinitionPayload;
      activity?: never;
      run?: never;
    });

const inspectionRequests = new WeakMap<
  AutomationUiClient,
  Map<string, Promise<AutomationInspection | null>>
>();
const runRequests = new WeakMap<
  AutomationUiClient,
  Map<string, Promise<MissionRunRecord | null>>
>();

function cacheFor<T>(
  owner: WeakMap<AutomationUiClient, Map<string, T>>,
  client: AutomationUiClient,
) {
  let cache = owner.get(client);
  if (!cache) {
    cache = new Map();
    owner.set(client, cache);
  }
  return cache;
}

function inspectAutomation(client: AutomationUiClient, missionId: string) {
  const cache = cacheFor(inspectionRequests, client);
  let pending = cache.get(missionId);
  if (!pending) {
    pending = client.inspect(missionId).finally(() => cache.delete(missionId));
    cache.set(missionId, pending);
  }
  return pending;
}

function inspectRun(client: AutomationUiClient, runId: string) {
  const cache = cacheFor(runRequests, client);
  let pending = cache.get(runId);
  if (!pending) {
    pending = client.getRun(runId).finally(() => cache.delete(runId));
    cache.set(runId, pending);
  }
  return pending;
}

function formatAbsolute(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

export function formatAutomationInterval(value: number): string {
  if (value % 86_400_000 === 0)
    return `${value / 86_400_000} day${value === 86_400_000 ? "" : "s"}`;
  if (value % 3_600_000 === 0)
    return `${value / 3_600_000} hour${value === 3_600_000 ? "" : "s"}`;
  if (value % 60_000 === 0)
    return `${value / 60_000} minute${value === 60_000 ? "" : "s"}`;
  return `${Math.round(value / 1_000)} seconds`;
}

function scheduleSummary(
  snapshot: Pick<AutomationActivitySnapshot, "schedule">,
): string {
  if (!snapshot.schedule) return "Manual";
  if (snapshot.schedule.kind === "cron") {
    try {
      return describeCronSchedule(
        snapshot.schedule.expression,
        snapshot.schedule.timezone,
      );
    } catch {
      return "Calendar schedule";
    }
  }
  return `Every ${formatAutomationInterval(snapshot.schedule.everyMs)}`;
}

function terminationSummary(trigger: MissionCharter["trigger"]): string {
  if (trigger.kind === "manual") return "No automatic end";
  const parts = [
    ...(trigger.untilAt === undefined
      ? []
      : [`until ${formatAbsolute(trigger.untilAt)}`]),
    ...(trigger.maxRuns === undefined
      ? []
      : [`after ${trigger.maxRuns} run${trigger.maxRuns === 1 ? "" : "s"}`]),
  ];
  return parts.length > 0
    ? parts.join(" or ")
    : "Runs until stopped or completed";
}

const PROVIDER_CONTEXT_CACHE_TTL_MS = 60 * 60 * 1_000;

function cronFieldCoversRange(
  field: string,
  minimum: number,
  maximum: number,
): boolean {
  const covered = new Set<number>();
  for (const part of field.split(",")) {
    const [range = "", rawStep] = part.split("/");
    const step = rawStep === undefined ? 1 : Number(rawStep);
    if (!Number.isInteger(step) || step < 1) return false;
    const [rawStart, rawEnd] =
      range === "*" ? [minimum, maximum] : range.split("-").map(Number);
    const start = rawStart ?? Number.NaN;
    const end = rawEnd ?? start;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < minimum ||
      end > maximum ||
      start > end
    ) {
      return false;
    }
    for (let value = start; value <= end; value += step) covered.add(value);
  }
  return covered.size === maximum - minimum + 1;
}

function cronCanWaitLongerThanProviderCacheTtl(expression: string): boolean {
  const canonical = canonicalCronExpression(expression);
  if (canonical === "@hourly") return false;
  if (canonical.startsWith("@")) return true;
  const [, hour, day, month, weekday] = canonical.split(" ") as [
    string,
    string,
    string,
    string,
    string,
  ];
  return !(
    cronFieldCoversRange(hour, 0, 23) &&
    cronFieldCoversRange(day, 1, 31) &&
    cronFieldCoversRange(month, 1, 12) &&
    (cronFieldCoversRange(weekday, 0, 6) || cronFieldCoversRange(weekday, 1, 7))
  );
}

function continuingConversationExceedsProviderCacheTtl(
  automation: MissionRecord,
): boolean {
  const { execution, trigger } = automation.charter;
  if (
    execution.kind !== "agent" ||
    execution.conversation.mode !== "continue" ||
    trigger.kind === "manual"
  ) {
    return false;
  }
  if (trigger.kind === "schedule")
    return trigger.everyMs > PROVIDER_CONTEXT_CACHE_TTL_MS;
  try {
    return cronCanWaitLongerThanProviderCacheTtl(trigger.expression);
  } catch {
    return false;
  }
}

function localDateTimeInput(value?: number): string {
  if (value === undefined) return "";
  const date = new Date(value);
  return new Date(value - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "device time";
}

function activityStatus(activity: AutomationActivityPayload) {
  if (activity.status === "succeeded") {
    return {
      label: "Succeeded",
      color: "green" as const,
      icon: <CheckCircledIcon />,
    };
  }
  if (activity.status === "failed") {
    return {
      label: "Failed",
      color: "red" as const,
      icon: <CrossCircledIcon />,
    };
  }
  if (activity.status === "skipped") {
    return {
      label: "Skipped",
      color: "amber" as const,
      icon: <ExclamationTriangleIcon />,
    };
  }
  return {
    label: "Running",
    color: "blue" as const,
    icon: <Spinner size="1" />,
  };
}

function definitionStatus(state?: MissionRecord["state"]) {
  if (state === "active") {
    return { label: "Active", color: "green" as const, icon: <PlayIcon /> };
  }
  if (state === "paused") {
    return { label: "Paused", color: "amber" as const, icon: <PauseIcon /> };
  }
  if (state === "completed") {
    return {
      label: "Completed",
      color: "green" as const,
      icon: <CheckCircledIcon />,
    };
  }
  if (state === "retired") {
    return {
      label: "Retired",
      color: "gray" as const,
      icon: <CrossCircledIcon />,
    };
  }
  return {
    label: "Stopped",
    color: "gray" as const,
    icon: <CrossCircledIcon />,
  };
}

function durationLabel(startedAt: number, finishedAt?: number): string {
  if (finishedAt === undefined) return "In progress";
  const elapsed = Math.max(0, finishedAt - startedAt);
  if (elapsed < 1_000) return "<1s";
  if (elapsed < 60_000) return `${Math.round(elapsed / 1_000)}s`;
  return `${Math.floor(elapsed / 60_000)}m ${Math.round((elapsed % 60_000) / 1_000)}s`;
}

function editableInterval(trigger: MissionCharter["trigger"]): {
  amount: string;
  unit: string;
} {
  if (trigger.kind !== "schedule") return { amount: "1", unit: "day" };
  if (trigger.everyMs % 86_400_000 === 0)
    return { amount: String(trigger.everyMs / 86_400_000), unit: "day" };
  if (trigger.everyMs % 3_600_000 === 0)
    return { amount: String(trigger.everyMs / 3_600_000), unit: "hour" };
  return { amount: String(trigger.everyMs / 60_000), unit: "minute" };
}

const UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

export function AutomationParametersEditor({
  automation,
  client,
  onSaved,
  onCancel,
}: {
  automation: MissionRecord;
  client: AutomationUiClient;
  onSaved(value: MissionRecord): void;
  onCancel(): void;
}) {
  const initialInterval = editableInterval(automation.charter.trigger);
  const initialTrigger = automation.charter.trigger;
  const [name, setName] = useState(automation.name);
  const [summary, setSummary] = useState(automation.charter.summary);
  const [scheduleKind, setScheduleKind] = useState<
    "manual" | "interval" | "cron"
  >(initialTrigger.kind === "schedule" ? "interval" : initialTrigger.kind);
  const [amount, setAmount] = useState(initialInterval.amount);
  const [unit, setUnit] = useState(initialInterval.unit);
  const [cronExpression, setCronExpression] = useState(
    initialTrigger.kind === "cron" ? initialTrigger.expression : "5 5 * * THU",
  );
  const [timezone, setTimezone] = useState(
    initialTrigger.kind === "cron"
      ? initialTrigger.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [until, setUntil] = useState(
    initialTrigger.kind === "manual"
      ? ""
      : localDateTimeInput(initialTrigger.untilAt),
  );
  const [maxRuns, setMaxRuns] = useState(
    initialTrigger.kind === "manual" || initialTrigger.maxRuns === undefined
      ? ""
      : String(initialTrigger.maxRuns),
  );
  const [payload, setPayload] = useState(() => {
    const execution = automation.charter.execution;
    if (execution.kind === "method")
      return JSON.stringify(execution.args, null, 2);
    return execution.action.kind === "prompt"
      ? execution.action.text
      : execution.action.code;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const execution = automation.charter.execution;

  const save = useCallback(async () => {
    const numericAmount = Number(amount);
    const everyMs = Math.round(numericAmount * UNIT_MS[unit]!);
    if (!name.trim() || !summary.trim() || !payload.trim()) {
      setError("Name, purpose, and action are required.");
      return;
    }
    if (
      scheduleKind === "interval" &&
      (!Number.isFinite(everyMs) || everyMs < 60_000)
    ) {
      setError(
        "Recurring schedules must run no more often than once per minute.",
      );
      return;
    }
    let normalizedCronExpression: string | undefined;
    let normalizedTimezone: string | undefined;
    if (scheduleKind === "cron") {
      try {
        normalizedCronExpression = canonicalCronExpression(cronExpression);
        normalizedTimezone = canonicalCronTimeZone(timezone);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return;
      }
    }
    const untilAt = until ? new Date(until).getTime() : undefined;
    if (until && (!Number.isSafeInteger(untilAt) || untilAt! <= Date.now())) {
      setError("The end time must be a valid future date and time.");
      return;
    }
    const parsedMaxRuns = maxRuns ? Number(maxRuns) : undefined;
    if (
      parsedMaxRuns !== undefined &&
      (!Number.isSafeInteger(parsedMaxRuns) ||
        parsedMaxRuns < 1 ||
        parsedMaxRuns <= automation.runCount)
    ) {
      setError(
        `Maximum runs must be greater than the ${automation.runCount} already admitted.`,
      );
      return;
    }
    let nextExecution: MissionCharter["execution"];
    try {
      nextExecution =
        execution.kind === "method"
          ? { ...execution, args: JSON.parse(payload) as unknown[] }
          : execution.action.kind === "prompt"
            ? { ...execution, action: { kind: "prompt", text: payload } }
            : { ...execution, action: { ...execution.action, code: payload } };
      if (
        nextExecution.kind === "method" &&
        !Array.isArray(nextExecution.args)
      ) {
        throw new Error("Method arguments must be a JSON array.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const previous = automation.charter.trigger;
      const charter: MissionCharter = {
        ...automation.charter,
        summary: summary.trim(),
        execution: nextExecution,
        trigger:
          scheduleKind === "interval"
            ? {
                kind: "schedule",
                everyMs,
                ...(previous.kind === "schedule" &&
                previous.anchorAt !== undefined
                  ? { anchorAt: previous.anchorAt }
                  : {}),
                ...(previous.kind === "schedule" &&
                previous.jitterMs !== undefined &&
                previous.jitterMs < everyMs
                  ? { jitterMs: previous.jitterMs }
                  : {}),
                ...(untilAt === undefined ? {} : { untilAt }),
                ...(parsedMaxRuns === undefined
                  ? {}
                  : { maxRuns: parsedMaxRuns }),
              }
            : scheduleKind === "cron"
              ? {
                  kind: "cron",
                  expression: normalizedCronExpression!,
                  timezone: normalizedTimezone!,
                  ...(untilAt === undefined ? {} : { untilAt }),
                  ...(parsedMaxRuns === undefined
                    ? {}
                    : { maxRuns: parsedMaxRuns }),
                }
              : { kind: "manual" },
      };
      onSaved(
        await client.edit(automation.missionId, { name: name.trim(), charter }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [
    amount,
    automation,
    client,
    cronExpression,
    execution,
    maxRuns,
    name,
    onSaved,
    payload,
    scheduleKind,
    summary,
    timezone,
    unit,
    until,
  ]);

  return (
    <Flex direction="column" gap="3">
      <Grid columns={{ initial: "1", sm: "2" }} gap="3">
        <TextField.Root
          aria-label="Automation name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Automation name"
        />
        <Select.Root
          value={scheduleKind}
          onValueChange={(value) =>
            setScheduleKind(value as typeof scheduleKind)
          }
        >
          <Select.Trigger style={{ flex: 1 }} />
          <Select.Content>
            <Select.Item value="interval">Recurring interval</Select.Item>
            <Select.Item value="cron">Calendar / cron</Select.Item>
            <Select.Item value="manual">Manual only</Select.Item>
          </Select.Content>
        </Select.Root>
      </Grid>
      {scheduleKind === "interval" ? (
        <Box>
          <Text as="div" size="1" color="gray" mb="1">
            Repeat every
          </Text>
          <Flex gap="2" align="center">
            <TextField.Root
              aria-label="Interval amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              style={{ width: 96 }}
            />
            <Select.Root value={unit} onValueChange={setUnit}>
              <Select.Trigger />
              <Select.Content>
                <Select.Item value="minute">minutes</Select.Item>
                <Select.Item value="hour">hours</Select.Item>
                <Select.Item value="day">days</Select.Item>
              </Select.Content>
            </Select.Root>
          </Flex>
        </Box>
      ) : null}
      {scheduleKind === "cron" ? (
        <CronScheduleEditor
          expression={cronExpression}
          timezone={timezone}
          onExpressionChange={setCronExpression}
          onTimezoneChange={setTimezone}
        />
      ) : null}
      {scheduleKind !== "manual" ? (
        <Grid columns={{ initial: "1", sm: "2" }} gap="3">
          <Box>
            <Text as="div" size="1" color="gray" mb="1">
              Stop at · optional · {localTimeZone()}
            </Text>
            <TextField.Root
              type="datetime-local"
              aria-label="Automation end time"
              value={until}
              onChange={(event) => setUntil(event.target.value)}
            />
          </Box>
          <Box>
            <Text as="div" size="1" color="gray" mb="1">
              Maximum total runs · optional
            </Text>
            <TextField.Root
              type="number"
              min={automation.runCount + 1}
              step={1}
              aria-label="Maximum runs"
              value={maxRuns}
              onChange={(event) => setMaxRuns(event.target.value)}
              placeholder="No limit"
            />
            <Text as="div" size="1" color="gray" mt="1">
              {automation.runCount} admitted so far; failed runs count, overlap
              skips do not.
            </Text>
          </Box>
        </Grid>
      ) : null}
      <TextArea
        aria-label="Automation purpose"
        value={summary}
        onChange={(event) => setSummary(event.target.value)}
        placeholder="What this automation does"
        resize="vertical"
      />
      <Box>
        <Text as="div" size="1" color="gray" mb="1">
          {execution.kind === "method"
            ? "Method arguments (JSON array)"
            : execution.action.kind === "eval"
              ? "Exact eval code"
              : "Prompt text"}
        </Text>
        <TextArea
          aria-label={
            execution.kind === "method"
              ? "Method arguments"
              : execution.action.kind === "eval"
                ? "Eval code"
                : "Prompt text"
          }
          value={payload}
          onChange={(event) => setPayload(event.target.value)}
          resize="vertical"
          style={{
            minHeight:
              execution.kind === "agent" && execution.action.kind === "eval"
                ? 220
                : 120,
            fontFamily:
              execution.kind === "agent" && execution.action.kind === "eval"
                ? "var(--code-font-family)"
                : undefined,
          }}
        />
      </Box>
      {error ? (
        <Callout.Root color="red" size="1">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      ) : null}
      <Flex justify="end" gap="2">
        <Button variant="soft" color="gray" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={saving} onClick={() => void save()}>
          {saving ? <Spinner size="1" /> : null}Save and apply
        </Button>
      </Flex>
    </Flex>
  );
}

function Inspector({
  activity,
  definition,
  automation,
  recentRuns,
  run,
  client,
  onChanged,
}: {
  activity?: AutomationActivityPayload;
  definition?: AutomationDefinitionPayload;
  automation: MissionRecord | null;
  recentRuns: MissionRunRecord[];
  run: MissionRunRecord | null;
  client: AutomationUiClient;
  onChanged?(automation: MissionRecord): void;
}) {
  const [current, setCurrent] = useState(automation);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setCurrent(automation), [automation]);
  const showProviderCacheWarning = useMemo(
    () =>
      current !== null &&
      continuingConversationExceedsProviderCacheTtl(current),
    [current],
  );
  const changed = useCallback(
    (value: MissionRecord) => {
      setCurrent(value);
      setEditing(false);
      onChanged?.(value);
    },
    [onChanged],
  );
  const action = useCallback(
    async (kind: "pause" | "resume" | "runNow") => {
      if (!current) return;
      setBusy(kind);
      setError(null);
      setNotice(null);
      try {
        if (kind === "runNow") {
          await client.runNow(current.missionId);
          setNotice(
            "A new tick has started. It will appear in history when its turn opens.",
          );
        } else {
          changed(await client[kind](current.missionId));
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(null);
      }
    },
    [changed, client, current],
  );

  if (!current)
    return (
      <Callout.Root color="amber">
        <Callout.Text>
          This automation definition is no longer available. Its historical
          provenance remains in this conversation.
        </Callout.Text>
      </Callout.Root>
    );
  if (editing)
    return (
      <AutomationParametersEditor
        automation={current}
        client={client}
        onSaved={changed}
        onCancel={() => setEditing(false)}
      />
    );
  const execution = current.charter.execution;
  return (
    <Flex direction="column" gap="4">
      {definition ? (
        <Callout.Root color="green" size="1">
          <Callout.Icon>
            <PlayIcon />
          </Callout.Icon>
          <Callout.Text>
            Started here {formatAbsolute(Date.parse(definition.institutedAt))}.
            Open this inspector any time to review its exact action, cadence,
            authority, and run history.
          </Callout.Text>
        </Callout.Root>
      ) : null}
      {showProviderCacheWarning ? (
        <Callout.Root color="amber" size="1">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>
            <Text as="span" weight="medium" style={{ display: "block" }}>
              Additional provider token cost
            </Text>
            <Text as="span" style={{ display: "block" }}>
              This automation continues one chat conversation and can wait more
              than one hour between wake-ups. API-provider context caches may
              expire during that gap. After the cache expires, each later
              wake-up consumes additional input tokens to restore the
              conversation context.
            </Text>
          </Callout.Text>
        </Callout.Root>
      ) : null}
      <Flex justify="between" gap="3" wrap="wrap">
        <Box>
          <Text as="div" size="1" color="gray">
            Purpose
          </Text>
          <Text size="2">{current.charter.summary}</Text>
        </Box>
        <Flex gap="2" wrap="wrap">
          {current.state !== "retired" ? (
            <Button size="1" variant="soft" onClick={() => setEditing(true)}>
              <Pencil2Icon />
              Edit parameters
            </Button>
          ) : null}
          {current.state === "active" ? (
            <Button
              size="1"
              variant="soft"
              disabled={busy !== null}
              onClick={() => void action("runNow")}
            >
              {busy === "runNow" ? <Spinner size="1" /> : <LightningBoltIcon />}
              Run now
            </Button>
          ) : null}
          {current.state === "active" ? (
            <Button
              size="1"
              color="red"
              variant="soft"
              disabled={busy !== null}
              onClick={() => void action("pause")}
            >
              <PauseIcon />
              {current.charter.trigger.kind !== "manual"
                ? "Stop recurring calls"
                : "Pause automation"}
            </Button>
          ) : null}
          {current.state === "paused" ? (
            <Button
              size="1"
              variant="soft"
              disabled={busy !== null}
              onClick={() => void action("resume")}
            >
              <PlayIcon />
              Resume
            </Button>
          ) : null}
        </Flex>
      </Flex>
      {error ? (
        <Callout.Root color="red" size="1">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      ) : null}
      {notice ? (
        <Callout.Root color="green" size="1">
          <Callout.Text>{notice}</Callout.Text>
        </Callout.Root>
      ) : null}
      <Grid columns={{ initial: "1", sm: "3" }} gap="3">
        <Box>
          <Text as="div" size="1" color="gray">
            Cadence
          </Text>
          {current.charter.trigger.kind === "cron" ? (
            <CronScheduleDisplay
              expression={current.charter.trigger.expression}
              timezone={current.charter.trigger.timezone}
              technical
            />
          ) : (
            <Text size="2" weight="medium">
              {current.charter.trigger.kind === "schedule"
                ? `Every ${formatAutomationInterval(current.charter.trigger.everyMs)}`
                : "Manual only"}
            </Text>
          )}
        </Box>
        <Box>
          <Text as="div" size="1" color="gray">
            First activated
          </Text>
          <Text size="2" weight="medium">
            {current.activatedAt !== undefined
              ? formatAbsolute(current.activatedAt)
              : "Not recorded"}
          </Text>
        </Box>
        <Box>
          <Text as="div" size="1" color="gray">
            Progress
          </Text>
          <Text size="2" weight="medium">
            {current.runCount} run{current.runCount === 1 ? "" : "s"}
            {current.charter.trigger.kind !== "manual" &&
            current.charter.trigger.maxRuns !== undefined
              ? ` of ${current.charter.trigger.maxRuns}`
              : ""}
          </Text>
        </Box>
      </Grid>
      <Box>
        <Text as="div" size="1" color="gray" mb="1">
          Exact action
        </Text>
        <Box
          p="3"
          style={{
            borderRadius: "var(--radius-2)",
            background: "var(--gray-a2)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            maxHeight: 220,
            overflow: "auto",
          }}
        >
          <Text
            size="2"
            style={
              execution.kind === "method" || execution.action.kind === "eval"
                ? { fontFamily: "var(--code-font-family)" }
                : undefined
            }
          >
            {execution.kind === "method"
              ? `${execution.method}(${JSON.stringify(execution.args, null, 2)})`
              : execution.action.kind === "eval"
                ? execution.action.code
                : execution.action.text}
          </Text>
        </Box>
      </Box>
      <Grid columns={{ initial: "1", sm: "2" }} gap="3">
        <Box>
          <Text as="div" size="1" color="gray" mb="1">
            Launch-time authority planning
          </Text>
          {execution.operations.length > 0 ? (
            <Flex direction="column" gap="1">
              {execution.operations.map((operation, index) => (
                <Code
                  key={`${operation.service}.${operation.method}:${index}`}
                  size="1"
                  style={{ overflowWrap: "anywhere" }}
                >
                  {operation.service}.{operation.method} · {operation.use}
                </Code>
              ))}
            </Flex>
          ) : (
            <Text size="2" color="gray">
              No pre-acquisition hints. Runtime calls still use ordinary
              approval.
            </Text>
          )}
        </Box>
        <Box>
          <Text as="div" size="1" color="gray" mb="1">
            {execution.kind === "agent" &&
            execution.conversation.mode === "continue"
              ? "Execution authority"
              : "Standing authority"}
          </Text>
          {execution.kind === "agent" &&
          execution.conversation.mode === "continue" ? (
            <Text size="2">
              Uses this existing agent task&apos;s ordinary authority. Scheduled
              turns do not install mission authority on the conversation.
            </Text>
          ) : (
            <>
              <Text size="2">
                {current.authority.grantIds.length} granted ·{" "}
                {current.authority.requestIds.length} pending ·{" "}
                {current.authority.denialIds.length} denied
              </Text>
              <Code
                size="1"
                style={{
                  display: "block",
                  overflowWrap: "anywhere",
                  marginTop: 4,
                }}
              >
                {current.authorityPlan.artifactRef}
              </Code>
            </>
          )}
        </Box>
      </Grid>
      {current.charter.trigger.kind !== "manual" ? (
        <Grid columns={{ initial: "1", sm: "2" }} gap="3">
          <Box>
            <Text as="div" size="1" color="gray">
              End policy
            </Text>
            <Text size="2" weight="medium">
              {terminationSummary(current.charter.trigger)}
            </Text>
          </Box>
          <Box>
            <Text as="div" size="1" color="gray">
              Revision
            </Text>
            <Text size="2" weight="medium">
              r{current.revision} · {current.state}
            </Text>
          </Box>
        </Grid>
      ) : null}
      {current.state === "completed" ? (
        <Callout.Root color="green" size="1">
          <Callout.Icon>
            <CheckCircledIcon />
          </Callout.Icon>
          <Callout.Text>
            <Text as="span" weight="medium" style={{ display: "block" }}>
              Automation completed
              {current.completedAt === undefined
                ? ""
                : ` ${formatAbsolute(current.completedAt)}`}
            </Text>
            <Text as="span" style={{ display: "block" }}>
              {current.completionReason === "response"
                ? "The automation reported that its recurring goal was finished."
                : current.completionReason === "max-runs"
                  ? "It reached its maximum run count."
                  : "It reached its configured end time."}
            </Text>
            {current.completionResponse &&
            current.completionResponse !== run?.completionResponse ? (
              <Text
                as="span"
                mt="1"
                style={{
                  display: "block",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                }}
              >
                {current.completionResponse}
              </Text>
            ) : null}
          </Callout.Text>
        </Callout.Root>
      ) : null}
      {definition && recentRuns.length > 0 ? (
        <>
          <Separator size="4" />
          <Box>
            <Text as="div" weight="medium" mb="2">
              Recent runs
            </Text>
            <Flex direction="column" gap="2">
              {recentRuns.map((recent) => {
                const failed = recent.outcome === "failed";
                const completedWithErrors =
                  recent.outcome === "completed-with-errors";
                const active = recent.phase !== "terminal";
                return (
                  <Box
                    key={recent.runId}
                    p="3"
                    style={{
                      borderRadius: "var(--radius-2)",
                      background: "var(--gray-a2)",
                    }}
                  >
                    <Flex justify="between" gap="3" align="start" wrap="wrap">
                      <Box>
                        <Flex gap="2" align="center" wrap="wrap">
                          <Badge
                            color={
                              failed
                                ? "red"
                                : completedWithErrors
                                  ? "amber"
                                  : active
                                    ? "blue"
                                    : "green"
                            }
                            variant="soft"
                          >
                            {active
                              ? "Running"
                              : failed
                                ? "Failed"
                                : completedWithErrors
                                  ? "Completed with errors"
                                  : (recent.outcome ?? "Finished")}
                          </Badge>
                          <Text size="2" weight="medium">
                            {recent.runNumber === undefined
                              ? "Run"
                              : `Run #${recent.runNumber}`}
                          </Text>
                          <Text size="1" color="gray">
                            {formatAbsolute(recent.startedAt)}
                          </Text>
                        </Flex>
                        {recent.failure ? (
                          <Text as="div" size="2" color="red" mt="2">
                            {recent.failure.message}
                          </Text>
                        ) : recent.finalMessage ? (
                          <Text
                            as="div"
                            size="2"
                            mt="2"
                            style={{ whiteSpace: "pre-wrap" }}
                          >
                            {recent.finalMessage}
                          </Text>
                        ) : null}
                        {recent.effectFailures?.map((effect) => (
                          <Text
                            key={effect.invocationId}
                            as="div"
                            size="2"
                            color="red"
                            mt="2"
                          >
                            {effect.name}: {effect.message}
                          </Text>
                        ))}
                      </Box>
                      {recent.channelId && client.openConversation ? (
                        <Button
                          size="1"
                          variant="soft"
                          onClick={() => client.openConversation?.(recent)}
                        >
                          Open run
                        </Button>
                      ) : null}
                    </Flex>
                  </Box>
                );
              })}
            </Flex>
          </Box>
        </>
      ) : null}
      {activity ? <Separator size="4" /> : null}
      {activity ? (
        <Box>
          <Flex align="center" gap="2" mb="2">
            <LightningBoltIcon />
            <Text weight="medium">This tick</Text>
            <Badge color={activityStatus(activity).color} variant="soft">
              {activityStatus(activity).label}
            </Badge>
          </Flex>
          <Grid columns={{ initial: "1", sm: "3" }} gap="3">
            <Box>
              <Text as="div" size="1" color="gray">
                Started
              </Text>
              <Text size="2">
                {formatAbsolute(run?.startedAt ?? activity.snapshot.startedAt)}
              </Text>
            </Box>
            <Box>
              <Text as="div" size="1" color="gray">
                Duration
              </Text>
              <Text size="2">
                {durationLabel(
                  run?.startedAt ?? activity.snapshot.startedAt,
                  run?.finishedAt ??
                    (activity.closedAt
                      ? Date.parse(activity.closedAt)
                      : undefined),
                )}
              </Text>
            </Box>
            <Box>
              <Text as="div" size="1" color="gray">
                Trigger
              </Text>
              <Text size="2">
                {activity.snapshot.trigger === "scheduled"
                  ? "Scheduled tick"
                  : "Run now"}
                {(run?.runNumber ?? activity.snapshot.runNumber) === undefined
                  ? ""
                  : ` · #${run?.runNumber ?? activity.snapshot.runNumber}`}
              </Text>
            </Box>
          </Grid>
          {run?.failure ||
          (activity.status === "failed" && activity.summary) ? (
            <Callout.Root
              color={activity.status === "skipped" ? "amber" : "red"}
              size="1"
              mt="3"
            >
              <Callout.Icon>
                <CrossCircledIcon />
              </Callout.Icon>
              <Callout.Text>
                {run?.failure?.message ?? activity.summary}
              </Callout.Text>
            </Callout.Root>
          ) : null}
          {run?.effectFailures?.length ? (
            <Callout.Root color="amber" size="1" mt="3">
              <Callout.Icon>
                <ExclamationTriangleIcon />
              </Callout.Icon>
              <Callout.Text>
                <Text as="span" weight="medium" style={{ display: "block" }}>
                  This run completed with failed effects
                </Text>
                {run.effectFailures.map((effect) => (
                  <Text
                    key={effect.invocationId}
                    as="span"
                    style={{ display: "block" }}
                  >
                    {effect.name}: {effect.message}
                  </Text>
                ))}
              </Callout.Text>
            </Callout.Root>
          ) : null}
          {run?.completionResponse ? (
            <Callout.Root color="green" size="1" mt="3">
              <Callout.Icon>
                <CheckCircledIcon />
              </Callout.Icon>
              <Callout.Text>
                <Text as="span" weight="medium" style={{ display: "block" }}>
                  Natural completion response
                </Text>
                <Text
                  as="span"
                  style={{
                    display: "block",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {run.completionResponse}
                </Text>
              </Callout.Text>
            </Callout.Root>
          ) : null}
          {(run?.finalMessage && run.finalMessage !== run.completionResponse) ||
          (activity.status === "succeeded" &&
            activity.summary &&
            !run?.completionResponse) ? (
            <Box
              mt="3"
              p="3"
              style={{
                borderRadius: "var(--radius-2)",
                background: "var(--gray-a2)",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                maxHeight: 260,
                overflow: "auto",
              }}
            >
              <Text size="2">
                {run?.finalMessage &&
                run.finalMessage !== run.completionResponse
                  ? run.finalMessage
                  : activity.summary}
              </Text>
            </Box>
          ) : null}
          {run && client.openConversation && run.channelId && run.contextId ? (
            <Button
              size="1"
              variant="soft"
              mt="3"
              onClick={() => client.openConversation?.(run)}
            >
              Open conversation
            </Button>
          ) : null}
        </Box>
      ) : null}
      <details>
        <summary
          style={{ cursor: "pointer", fontSize: 13, color: "var(--gray-11)" }}
        >
          Technical provenance
        </summary>
        <Flex direction="column" gap="2" mt="2">
          <Code size="1" style={{ overflowWrap: "anywhere" }}>
            {activity
              ? `tick revision r${activity.snapshot.revision} · ${activity.snapshot.action}`
              : `instituted revision r${definition?.snapshot.revision} · ${definition?.snapshot.action}`}
          </Code>
          {activity ? (
            <Code size="1" style={{ overflowWrap: "anywhere" }}>
              run {activity.snapshot.runId}
            </Code>
          ) : (
            <Code size="1" style={{ overflowWrap: "anywhere" }}>
              automation {current.missionId}
            </Code>
          )}
          {run ? (
            <Code size="1" style={{ overflowWrap: "anywhere" }}>
              mission authority {run.missionSubject}
            </Code>
          ) : null}
          {current.revision ===
          (activity?.snapshot.revision ?? definition?.snapshot.revision) ? (
            <>
              <Code size="1" style={{ overflowWrap: "anywhere" }}>
                {execution.image.source}@{execution.image.effectiveVersion}
              </Code>
              <Code size="1" style={{ overflowWrap: "anywhere" }}>
                {execution.image.className} · {execution.image.objectKey}
              </Code>
            </>
          ) : (
            <Text size="1" color="amber">
              The automation is now at r{current.revision}; edit controls affect
              the current revision, while this history item preserves r
              {activity?.snapshot.revision ?? definition?.snapshot.revision}.
            </Text>
          )}
        </Flex>
      </details>
    </Flex>
  );
}

export const AutomationActivity = React.memo(function AutomationActivity({
  activity,
  definition,
  client,
  automation: suppliedAutomation,
  run: suppliedRun,
  display = "pill",
  onChanged,
}: AutomationActivityProps) {
  const snapshot = activity?.snapshot ?? definition!.snapshot;
  const isDefinition = definition !== undefined;
  const [open, setOpen] = useState(false);
  const [automation, setAutomation] = useState<
    MissionRecord | null | undefined
  >(suppliedAutomation);
  const [recentRuns, setRecentRuns] = useState<MissionRunRecord[]>([]);
  const [run, setRun] = useState<MissionRunRecord | null | undefined>(
    isDefinition ? null : suppliedRun,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => setAutomation(suppliedAutomation), [suppliedAutomation]);
  useEffect(
    () => setRun(isDefinition ? null : suppliedRun),
    [isDefinition, suppliedRun],
  );
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setLoading(true);
    void Promise.all([
      inspectAutomation(client, snapshot.missionId),
      !isDefinition ? inspectRun(client, activity!.snapshot.runId) : null,
    ])
      .then(([inspection, nextRun]) => {
        if (cancelled) return;
        setAutomation(inspection?.automation ?? null);
        setRecentRuns(inspection?.recentRuns ?? []);
        setRun(nextRun);
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activity, client, isDefinition, open, snapshot.missionId]);
  const status = useMemo(
    () =>
      activity
        ? activityStatus(activity)
        : definitionStatus(automation?.state ?? definition?.snapshot.state),
    [activity, automation?.state, definition?.snapshot.state],
  );
  const since = activity
    ? (activity.snapshot.activatedAt ?? activity.snapshot.createdAt)
    : snapshot.createdAt;
  const isRunRow = display === "row";
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <button
          type="button"
          aria-label={
            activity
              ? `Inspect automation tick ${snapshot.name}`
              : `Inspect automation ${snapshot.name}`
          }
          style={{
            border: 0,
            padding: 0,
            background: "transparent",
            cursor: "pointer",
            textAlign: "left",
            maxWidth: "100%",
          }}
        >
          <Flex
            align="center"
            gap="2"
            wrap="wrap"
            px={display === "row" ? "0" : "2"}
            py="1"
            style={
              display === "pill"
                ? {
                    border: "1px solid var(--gray-a6)",
                    borderRadius: 999,
                    background: "var(--gray-a2)",
                  }
                : undefined
            }
          >
            <Badge color={status.color} variant="soft">
              {status.icon}
              {status.label}
            </Badge>
            <Text size="2" weight="medium" truncate>
              {isRunRow && activity
                ? activity.snapshot.trigger === "scheduled"
                  ? "Scheduled tick"
                  : "Run now"
                : snapshot.name}
            </Text>
            <Text size="1" color="gray">
              <ClockIcon />{" "}
              {isRunRow && activity
                ? `${formatAbsolute(activity.snapshot.startedAt)} · ${durationLabel(activity.snapshot.startedAt, activity.closedAt ? Date.parse(activity.closedAt) : undefined)}`
                : `${scheduleSummary(snapshot)} · ${isDefinition ? "created" : "since"} ${formatAbsolute(since)}`}
            </Text>
          </Flex>
        </button>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="760px" aria-describedby={undefined}>
        <Dialog.Title>{snapshot.name}</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="4">
          {isDefinition
            ? "Automation definition created in this conversation"
            : "Automation and exact tick details"}
        </Dialog.Description>
        {error ? (
          <Callout.Root color="red">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        ) : loading ||
          automation === undefined ||
          (!isDefinition && run === undefined) ? (
          <Flex justify="center" py="6">
            <Spinner />
          </Flex>
        ) : (
          <Inspector
            activity={activity}
            definition={definition}
            automation={automation}
            recentRuns={recentRuns}
            run={run ?? null}
            client={client}
            onChanged={(value) => {
              setAutomation(value);
              onChanged?.(value);
            }}
          />
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
});
