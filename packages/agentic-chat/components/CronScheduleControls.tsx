import { useId, useMemo, useState, type ReactNode } from "react";
import {
  Badge,
  Box,
  Callout,
  Checkbox,
  Code,
  Flex,
  Grid,
  SegmentedControl,
  Select,
  Text,
  TextField,
} from "@radix-ui/themes";
import { CheckCircledIcon, ExclamationTriangleIcon } from "@radix-ui/react-icons";
import {
  canonicalCronExpression,
  canonicalCronTimeZone,
  cronExpressionFromVisual,
  cronUpcomingOccurrences,
  cronVisualSchedule,
  describeCronSchedule,
  formatCronOccurrence,
  type CronVisualSchedule,
} from "@vibestudio/automation/cronSchedule";

const WEEKDAYS = [
  { value: 1, short: "Mon", long: "Monday" },
  { value: 2, short: "Tue", long: "Tuesday" },
  { value: 3, short: "Wed", long: "Wednesday" },
  { value: 4, short: "Thu", long: "Thursday" },
  { value: 5, short: "Fri", long: "Friday" },
  { value: 6, short: "Sat", long: "Saturday" },
  { value: 0, short: "Sun", long: "Sunday" },
] as const;

const FALLBACK_TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const;

type VisualMode = CronVisualSchedule["mode"] | "advanced";

export function CronScheduleDisplay({
  expression,
  timezone,
  technical = false,
}: {
  expression: string;
  timezone: string;
  technical?: boolean;
}) {
  let summary: string;
  try {
    summary = describeCronSchedule(expression, timezone);
  } catch {
    summary = "Calendar schedule";
  }
  return (
    <Box>
      <Text as="div" size="2" weight="medium">
        {summary}
      </Text>
      <Text as="div" size="1" color="gray">
        {timezone} · daylight-saving aware
      </Text>
      {technical ? (
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: "pointer", color: "var(--gray-11)", fontSize: 12 }}>
            Cron syntax
          </summary>
          <Code size="1">{expression}</Code>
        </details>
      ) : null}
    </Box>
  );
}

export function CronScheduleEditor({
  expression,
  timezone,
  onExpressionChange,
  onTimezoneChange,
}: {
  expression: string;
  timezone: string;
  onExpressionChange(value: string): void;
  onTimezoneChange(value: string): void;
}) {
  const initialVisual = useMemo(() => safeVisual(expression), []);
  const [mode, setMode] = useState<VisualMode>(initialVisual?.mode ?? "advanced");
  const [visual, setVisual] = useState<CronVisualSchedule>(
    initialVisual ?? { mode: "daily", hour: 9, minute: 0 }
  );
  const timezoneListId = useId().replaceAll(":", "-");
  const timezones = useMemo(supportedTimeZones, []);
  const preview = useMemo(() => {
    try {
      const canonicalExpression = canonicalCronExpression(expression);
      const canonicalTimezone = canonicalCronTimeZone(timezone);
      return {
        canonicalExpression,
        canonicalTimezone,
        summary: describeCronSchedule(canonicalExpression, canonicalTimezone),
        occurrences: cronUpcomingOccurrences(canonicalExpression, canonicalTimezone, Date.now(), 5),
      } as const;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) } as const;
    }
  }, [expression, timezone]);

  const updateVisual = (next: CronVisualSchedule) => {
    setVisual(next);
    onExpressionChange(cronExpressionFromVisual(next));
  };

  const selectMode = (nextMode: VisualMode) => {
    setMode(nextMode);
    if (nextMode === "advanced") return;
    const parsed = safeVisual(expression);
    const next = parsed?.mode === nextMode ? parsed : visualForMode(nextMode, parsed ?? visual);
    updateVisual(next);
  };

  return (
    <Flex direction="column" gap="3">
      <Box style={{ maxWidth: "100%", overflowX: "auto" }}>
        <SegmentedControl.Root
          size="1"
          value={mode}
          onValueChange={(value) => selectMode(value as VisualMode)}
          aria-label="Calendar schedule frequency"
          style={{ minWidth: "max-content" }}
        >
          <SegmentedControl.Item value="hourly">Hourly</SegmentedControl.Item>
          <SegmentedControl.Item value="daily">Daily</SegmentedControl.Item>
          <SegmentedControl.Item value="weekly">Weekly</SegmentedControl.Item>
          <SegmentedControl.Item value="monthly">Monthly</SegmentedControl.Item>
          <SegmentedControl.Item value="advanced">Advanced</SegmentedControl.Item>
        </SegmentedControl.Root>
      </Box>

      {mode === "hourly" ? (
        <Field label="Minute within each hour">
          <TextField.Root
            type="number"
            min={0}
            max={59}
            value={visual.mode === "hourly" ? visual.minute : 0}
            aria-label="Minute within each hour"
            onChange={(event) => {
              const minute = Number(event.currentTarget.value);
              if (Number.isInteger(minute) && minute >= 0 && minute <= 59) {
                updateVisual({ mode: "hourly", minute });
              }
            }}
          />
        </Field>
      ) : null}

      {mode === "daily" && visual.mode === "daily" ? (
        <TimeField
          label="Time each day"
          hour={visual.hour}
          minute={visual.minute}
          onChange={(hour, minute) => updateVisual({ mode: "daily", hour, minute })}
        />
      ) : null}

      {mode === "weekly" && visual.mode === "weekly" ? (
        <Grid columns={{ initial: "1", sm: "2" }} gap="3">
          <TimeField
            label="Time"
            hour={visual.hour}
            minute={visual.minute}
            onChange={(hour, minute) => updateVisual({ ...visual, hour, minute })}
          />
          <Field label="Days of the week">
            <Flex gap="2" wrap="wrap">
              {WEEKDAYS.map((day) => {
                const checked = visual.weekdays.includes(day.value);
                return (
                  <Text as="label" size="2" key={day.value} title={day.long}>
                    <Flex gap="1" align="center">
                      <Checkbox
                        checked={checked}
                        aria-label={day.long}
                        onCheckedChange={(nextChecked) => {
                          const weekdays = nextChecked
                            ? [...visual.weekdays, day.value]
                            : visual.weekdays.filter((value) => value !== day.value);
                          if (weekdays.length > 0) updateVisual({ ...visual, weekdays });
                        }}
                      />
                      {day.short}
                    </Flex>
                  </Text>
                );
              })}
            </Flex>
          </Field>
        </Grid>
      ) : null}

      {mode === "monthly" && visual.mode === "monthly" ? (
        <Grid columns={{ initial: "1", sm: "2" }} gap="3">
          <Field label="Day of the month">
            <Select.Root
              value={String(visual.day)}
              onValueChange={(value) =>
                updateVisual({
                  ...visual,
                  day: value === "last" ? "last" : Number(value),
                })
              }
            >
              <Select.Trigger aria-label="Day of the month" />
              <Select.Content>
                {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                  <Select.Item value={String(day)} key={day}>
                    {ordinal(day)}
                  </Select.Item>
                ))}
                <Select.Item value="last">Last day</Select.Item>
              </Select.Content>
            </Select.Root>
          </Field>
          <TimeField
            label="Time"
            hour={visual.hour}
            minute={visual.minute}
            onChange={(hour, minute) => updateVisual({ ...visual, hour, minute })}
          />
        </Grid>
      ) : null}

      {mode === "advanced" ? (
        <Field label="Cron expression · minute hour day month weekday">
          <TextField.Root
            aria-label="Cron expression"
            value={expression}
            onChange={(event) => onExpressionChange(event.currentTarget.value)}
            placeholder="5 5 * * THU"
            spellCheck={false}
          />
          <Flex gap="1" wrap="wrap" mt="2" aria-label="Cron field order">
            {["minute", "hour", "day of month", "month", "weekday"].map((field, index) => (
              <Badge color="gray" variant="soft" key={field}>
                {index + 1} · {field}
              </Badge>
            ))}
          </Flex>
          <Text as="div" size="1" color="gray" mt="2">
            Supports lists, ranges, steps, names, last day (L), nearest weekday (W), nth weekday
            (#), and explicit day matching (+).
          </Text>
        </Field>
      ) : null}

      <Field label="Timezone">
        <TextField.Root
          aria-label="Cron timezone"
          value={timezone}
          onChange={(event) => onTimezoneChange(event.currentTarget.value)}
          list={timezoneListId}
          placeholder="Search cities, for example America/New_York"
          spellCheck={false}
        />
        <datalist id={timezoneListId}>
          {timezones.map((zone) => (
            <option value={zone} key={zone} />
          ))}
        </datalist>
        <Text as="div" size="1" color="gray" mt="1">
          Search by region or city. Wall-clock time stays correct through daylight-saving changes.
        </Text>
      </Field>

      {"error" in preview ? (
        <Callout.Root color="red" size="1" role="alert">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>{preview.error}</Callout.Text>
        </Callout.Root>
      ) : (
        <Callout.Root color="green" size="1">
          <Callout.Icon>
            <CheckCircledIcon />
          </Callout.Icon>
          <Callout.Text>
            <Text as="span" weight="medium" style={{ display: "block" }}>
              {preview.summary}
            </Text>
            <Text as="span" color="gray" style={{ display: "block" }}>
              Next five runs
            </Text>
            <Text as="span" mt="1" style={{ display: "block" }}>
              {preview.occurrences.map((occurrence, index) => (
                <Text as="span" size="1" style={{ display: "block" }} key={occurrence}>
                  {index + 1}. {formatCronOccurrence(occurrence, preview.canonicalTimezone)}
                </Text>
              ))}
            </Text>
            {mode !== "advanced" ? (
              <Text as="span" color="gray" mt="1" style={{ display: "block" }}>
                Stored as <Code size="1">{preview.canonicalExpression}</Code>
              </Text>
            ) : null}
          </Callout.Text>
        </Callout.Root>
      )}
    </Flex>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Text as="div" size="1" color="gray" mb="1">
        {label}
      </Text>
      {children}
    </Box>
  );
}

function TimeField({
  label,
  hour,
  minute,
  onChange,
}: {
  label: string;
  hour: number;
  minute: number;
  onChange(hour: number, minute: number): void;
}) {
  return (
    <Field label={label}>
      <TextField.Root
        type="time"
        aria-label={label}
        value={`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`}
        onChange={(event) => {
          const [nextHour, nextMinute] = event.currentTarget.value.split(":").map(Number);
          if (Number.isInteger(nextHour) && Number.isInteger(nextMinute)) {
            onChange(nextHour!, nextMinute!);
          }
        }}
      />
    </Field>
  );
}

function safeVisual(expression: string): CronVisualSchedule | null {
  try {
    return cronVisualSchedule(expression);
  } catch {
    return null;
  }
}

function visualForMode(
  mode: Exclude<VisualMode, "advanced">,
  previous: CronVisualSchedule
): CronVisualSchedule {
  const time =
    previous.mode === "hourly"
      ? { hour: 9, minute: previous.minute }
      : { hour: previous.hour, minute: previous.minute };
  if (mode === "hourly") return { mode, minute: time.minute };
  if (mode === "daily") return { mode, ...time };
  if (mode === "weekly") return { mode, ...time, weekdays: [1] };
  return { mode, ...time, day: 1 };
}

function supportedTimeZones(): string[] {
  const supportedValuesOf = (
    Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }
  ).supportedValuesOf;
  const values = supportedValuesOf?.("timeZone") ?? [...FALLBACK_TIMEZONES];
  return [...new Set(["UTC", ...values])];
}

function ordinal(value: number): string {
  const remainder = value % 100;
  if (remainder >= 11 && remainder <= 13) return `${value}th`;
  if (value % 10 === 1) return `${value}st`;
  if (value % 10 === 2) return `${value}nd`;
  if (value % 10 === 3) return `${value}rd`;
  return `${value}th`;
}
