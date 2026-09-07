// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import type {
  MissionRecord,
  MissionRunRecord,
} from "@vibestudio/automation/mission";
import {
  AutomationActivity,
  createAutomationUiClient,
  type AutomationUiClient,
} from "./AutomationActivity.js";

const automation: MissionRecord = {
  schemaVersion: 3,
  missionId: "mission-daily",
  name: "Daily check",
  revision: 2,
  charter: {
    summary: "Check the project every morning.",
    execution: {
      kind: "agent",
      image: {
        source: "workers/agent-worker",
        ref: `state:${"d".repeat(64)}`,
        effectiveVersion: "a".repeat(64),
        className: "AiChatWorker",
        objectKey: "daily-check",
      },
      action: { kind: "prompt", text: "Check the project." },
      conversation: { mode: "fresh" },
      operations: [],
    },
    trigger: { kind: "schedule", everyMs: 86_400_000 },
  },
  owner: { userId: "alice" },
  state: "active",
  revisionDigest: "b".repeat(64),
  authorityPlan: {
    schemaVersion: 1,
    digest: "e".repeat(64),
    artifactRef: `authority-plan:${"e".repeat(64)}`,
    compilerVersion: "test",
    catalogDigest: "f".repeat(64),
  },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  activatedAt: 1_700_000_000_000,
  runCount: 1,
  authority: { requestIds: [], grantIds: [], denialIds: [] },
};

const run: MissionRunRecord = {
  runId: "run-42",
  missionId: automation.missionId,
  missionSubject: `mission:${automation.missionId}@${automation.revisionDigest}`,
  revision: 2,
  trigger: "scheduled",
  phase: "terminal",
  outcome: "succeeded",
  startedAt: 1_700_100_000_000,
  runNumber: 1,
  finishedAt: 1_700_100_002_000,
  finalMessage: "Everything looks good.",
};

function client(): AutomationUiClient & {
  inspect: ReturnType<typeof vi.fn>;
  getRun: ReturnType<typeof vi.fn>;
  edit: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
} {
  return {
    inspect: vi.fn(async () => ({
      automation,
      recentRuns: [run],
      totalRuns: 1,
      activeRuns: 0,
      issueRunsSince: 0,
    })),
    getRun: vi.fn(async () => run),
    edit: vi.fn(async () => automation),
    pause: vi.fn(async () => ({ ...automation, state: "paused" as const })),
    resume: vi.fn(async () => automation),
    runNow: vi.fn(async () => run),
  };
}

describe("AutomationActivity", () => {
  it("shares service resolution and its client cache across history pills", async () => {
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "workers.resolveService") {
        return { kind: "durable-object", targetId: "do:missions" };
      }
      if (method === "overview") {
        return {
          items: [
            {
              automation,
              recentRuns: [run],
              totalRuns: 1,
              activeRuns: 0,
              issueRunsSince: 0,
            },
          ],
        };
      }
      if (method === "getRun") return run;
      throw new Error(`Unexpected method ${method}`);
    });
    const rpc = { call };
    const first = createAutomationUiClient(rpc);
    const second = createAutomationUiClient(rpc);

    expect(second).toBe(first);
    await Promise.all([
      first.inspect(automation.missionId),
      second.getRun(run.runId),
    ]);
    expect(
      call.mock.calls.filter(
        ([, method]) => method === "workers.resolveService",
      ),
    ).toHaveLength(1);
  });

  it("keeps history pills zero-fetch, then lazily loads exact tick controls", async () => {
    const api = client();
    render(
      <Theme>
        <AutomationActivity
          activity={{
            snapshot: {
              missionId: automation.missionId,
              runId: run.runId,
              name: automation.name,
              revision: automation.revision,
              action: "prompt",
              trigger: "scheduled",
              startedAt: run.startedAt,
              createdAt: automation.createdAt,
              activatedAt: automation.activatedAt,
              schedule: { kind: "interval", everyMs: 86_400_000 },
            },
            status: "succeeded",
            openedAt: new Date(run.startedAt).toISOString(),
            closedAt: new Date(run.finishedAt!).toISOString(),
          }}
          client={api}
        />
      </Theme>,
    );

    expect(screen.getByText(/Every 1 day/)).toBeTruthy();
    expect(api.inspect).not.toHaveBeenCalled();
    expect(api.getRun).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Inspect automation tick Daily check/,
      }),
    );
    await screen.findByText("Everything looks good.");
    expect(api.inspect).toHaveBeenCalledWith(automation.missionId);
    expect(api.getRun).toHaveBeenCalledWith(run.runId);
    expect(screen.queryByText("Additional provider token cost")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Stop recurring calls" }),
    );
    await waitFor(() =>
      expect(api.pause).toHaveBeenCalledWith(automation.missionId),
    );
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("renders a launched automation immediately and opens controls without fetching a run", async () => {
    const launched = {
      ...automation,
      revision: 1,
      state: "active" as const,
      runCount: 0,
    };
    const api = client();
    const failedRun: MissionRunRecord = {
      ...run,
      runId: "run-live-failure",
      runNumber: 2,
      outcome: "completed-with-errors",
      finalMessage: undefined,
      effectFailures: [
        {
          invocationId: "notify-call",
          name: "notify",
          outcome: "tool_error",
          code: "ENOTIFY",
          message: "Notification delivery failed",
        },
      ],
    };
    api.inspect.mockResolvedValue({
      automation: { ...launched, runCount: 2 },
      recentRuns: [failedRun],
      totalRuns: 2,
      activeRuns: 0,
      issueRunsSince: 1,
    });
    render(
      <Theme>
        <AutomationActivity
          definition={{
            snapshot: {
              missionId: launched.missionId,
              name: launched.name,
              summary: launched.charter.summary,
              revision: launched.revision,
              action: "prompt",
              state: "active",
              createdAt: launched.createdAt,
              schedule: { kind: "interval", everyMs: 86_400_000 },
            },
            institutedAt: new Date(launched.createdAt).toISOString(),
          }}
          client={api}
        />
      </Theme>,
    );

    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText(/Every 1 day · created/)).toBeTruthy();
    expect(api.inspect).not.toHaveBeenCalled();
    expect(api.getRun).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Inspect automation Daily check" }),
    );
    await screen.findByText(/Started here/);
    expect(api.inspect).toHaveBeenCalledWith(launched.missionId);
    expect(api.getRun).not.toHaveBeenCalled();
    expect(screen.queryByText("This tick")).toBeNull();
    expect(screen.getByText("Exact action")).toBeTruthy();
    expect(screen.getByText("Check the project.")).toBeTruthy();
    expect(screen.getByText("Launch-time authority planning")).toBeTruthy();
    expect(
      screen.getByText(
        "No pre-acquisition hints. Runtime calls still use ordinary approval.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Standing authority")).toBeTruthy();
    expect(screen.getByText("2 runs")).toBeTruthy();
    expect(screen.getByText("Recent runs")).toBeTruthy();
    expect(screen.getByText("Completed with errors")).toBeTruthy();
    expect(screen.getByText(/Notification delivery failed/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Edit parameters" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Stop recurring calls" }),
    ).toBeTruthy();
  });

  it.each([
    [
      "two-hour interval",
      { kind: "schedule" as const, everyMs: 7_200_000 },
      true,
    ],
    [
      "one-hour interval",
      { kind: "schedule" as const, everyMs: 3_600_000 },
      false,
    ],
    [
      "weekly calendar schedule",
      {
        kind: "cron" as const,
        expression: "5 5 * * THU",
        timezone: "America/New_York",
      },
      true,
    ],
    [
      "hourly calendar schedule",
      {
        kind: "cron" as const,
        expression: "5 * * * *",
        timezone: "America/New_York",
      },
      false,
    ],
  ])("%s provider-cache warning: %s", async (_label, trigger, expected) => {
    const agentExecution = automation.charter.execution;
    if (agentExecution.kind !== "agent")
      throw new Error("Expected an agent automation fixture");
    const continuedAutomation: MissionRecord = {
      ...automation,
      charter: {
        ...automation.charter,
        trigger,
        execution: {
          ...agentExecution,
          conversation: {
            mode: "continue",
            channelId: "project-research",
            contextId: "ctx-project-research",
            executorId: "do:workers/agent-worker:AiChatWorker:project-research",
          },
        },
      },
    };
    const api = client();
    api.inspect.mockResolvedValue({
      automation: continuedAutomation,
      recentRuns: [run],
      totalRuns: 1,
      activeRuns: 0,
      issueRunsSince: 0,
    });
    render(
      <Theme>
        <AutomationActivity
          activity={{
            snapshot: {
              missionId: continuedAutomation.missionId,
              runId: run.runId,
              name: continuedAutomation.name,
              revision: continuedAutomation.revision,
              action: "prompt",
              trigger: "scheduled",
              startedAt: run.startedAt,
              createdAt: continuedAutomation.createdAt,
              activatedAt: continuedAutomation.activatedAt,
              schedule:
                trigger.kind === "cron"
                  ? {
                      kind: "cron",
                      expression: trigger.expression,
                      timezone: trigger.timezone,
                    }
                  : { kind: "interval", everyMs: trigger.everyMs },
            },
            status: "succeeded",
            openedAt: new Date(run.startedAt).toISOString(),
            closedAt: new Date(run.finishedAt!).toISOString(),
          }}
          automation={continuedAutomation}
          run={run}
          client={api}
        />
      </Theme>,
    );

    expect(screen.queryByText("Additional provider token cost")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Inspect automation tick Daily check/,
      }),
    );
    if (expected) {
      expect(
        await screen.findByText("Additional provider token cost"),
      ).toBeTruthy();
      expect(
        screen.getByText(/API-provider context caches may expire/),
      ).toBeTruthy();
      expect(screen.getByText(/consumes additional input tokens/)).toBeTruthy();
    } else {
      expect(screen.queryByText("Additional provider token cost")).toBeNull();
    }
  });

  it("edits the exact action parameters and applies the active revision", async () => {
    const api = client();
    render(
      <Theme>
        <AutomationActivity
          activity={{
            snapshot: {
              missionId: automation.missionId,
              runId: run.runId,
              name: automation.name,
              revision: automation.revision,
              action: "prompt",
              trigger: "scheduled",
              startedAt: run.startedAt,
              createdAt: automation.createdAt,
              activatedAt: automation.activatedAt,
              schedule: { kind: "interval", everyMs: 86_400_000 },
            },
            status: "succeeded",
            openedAt: new Date(run.startedAt).toISOString(),
            closedAt: new Date(run.finishedAt!).toISOString(),
          }}
          automation={automation}
          run={run}
          client={api}
        />
      </Theme>,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Inspect automation tick Daily check/,
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit parameters" }),
    );
    fireEvent.change(screen.getByLabelText("Prompt text"), {
      target: { value: "Check the project and summarize blockers." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and apply" }));

    await waitFor(() =>
      expect(api.edit).toHaveBeenCalledWith(
        automation.missionId,
        expect.objectContaining({
          charter: expect.objectContaining({
            execution: expect.objectContaining({
              action: {
                kind: "prompt",
                text: "Check the project and summarize blockers.",
              },
            }),
          }),
        }),
      ),
    );
  });

  it("displays and edits calendar cadence, timezone, and finite-run controls together", async () => {
    const calendarAutomation: MissionRecord = {
      ...automation,
      runCount: 4,
      charter: {
        ...automation.charter,
        trigger: {
          kind: "cron",
          expression: "5 5 * * THU",
          timezone: "America/New_York",
          untilAt: Date.parse("2099-10-01T00:00:00.000Z"),
          maxRuns: 8,
        },
      },
    };
    const api = client();
    api.inspect.mockResolvedValue({
      automation: calendarAutomation,
      recentRuns: [{ ...run, runNumber: 4 }],
      totalRuns: 4,
      activeRuns: 0,
      issueRunsSince: 0,
    });
    render(
      <Theme>
        <AutomationActivity
          activity={{
            snapshot: {
              missionId: calendarAutomation.missionId,
              runId: run.runId,
              name: calendarAutomation.name,
              revision: calendarAutomation.revision,
              action: "prompt",
              trigger: "scheduled",
              startedAt: run.startedAt,
              createdAt: calendarAutomation.createdAt,
              activatedAt: calendarAutomation.activatedAt,
              runNumber: 4,
              schedule: {
                kind: "cron",
                expression: "5 5 * * THU",
                timezone: "America/New_York",
                untilAt: Date.parse("2099-10-01T00:00:00.000Z"),
                maxRuns: 8,
              },
            },
            status: "succeeded",
            openedAt: new Date(run.startedAt).toISOString(),
            closedAt: new Date(run.finishedAt!).toISOString(),
          }}
          automation={calendarAutomation}
          run={{ ...run, runNumber: 4 }}
          client={api}
        />
      </Theme>,
    );

    expect(
      screen.getByText(/Every Thursday at 5:05.*New York time/),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Inspect automation tick Daily check/,
      }),
    );
    expect(await screen.findByText("4 runs of 8")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit parameters" }));
    expect(screen.queryByLabelText("Cron expression")).toBeNull();
    expect((screen.getByLabelText("Time") as HTMLInputElement).value).toBe(
      "05:05",
    );
    expect(
      (screen.getByLabelText("Thursday") as HTMLButtonElement).dataset["state"],
    ).toBe("checked");
    expect(
      (screen.getByLabelText("Cron timezone") as HTMLInputElement).value,
    ).toBe("America/New_York");
    expect(screen.getByText("Next five runs")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Advanced" }));
    fireEvent.change(screen.getByLabelText("Cron expression"), {
      target: { value: "35 7 * * MON-FRI" },
    });
    expect(
      await screen.findByText(/Every Monday through Friday at 7:35/),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Maximum runs"), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and apply" }));

    await waitFor(() =>
      expect(api.edit).toHaveBeenCalledWith(
        calendarAutomation.missionId,
        expect.objectContaining({
          charter: expect.objectContaining({
            trigger: expect.objectContaining({
              kind: "cron",
              expression: "35 7 * * MON-FRI",
              timezone: "America/New_York",
              maxRuns: 12,
              untilAt: expect.any(Number),
            }),
          }),
        }),
      ),
    );
  });

  it("highlights the natural completion response in the automation and tick history", async () => {
    const completed: MissionRecord = {
      ...automation,
      state: "completed",
      completedAt: 1_700_100_002_000,
      completionReason: "response",
      completionResponse: "The monitored rollout is healthy everywhere.",
    };
    const completedRun: MissionRunRecord = {
      ...run,
      completionResponse: "The monitored rollout is healthy everywhere.",
    };
    const api = client();
    api.inspect.mockResolvedValue({
      automation: completed,
      recentRuns: [completedRun],
      totalRuns: 1,
      activeRuns: 0,
      issueRunsSince: 0,
    });
    api.getRun.mockResolvedValue(completedRun);
    render(
      <Theme>
        <AutomationActivity
          activity={{
            snapshot: {
              missionId: completed.missionId,
              runId: completedRun.runId,
              name: completed.name,
              revision: completed.revision,
              action: "prompt",
              trigger: "scheduled",
              startedAt: completedRun.startedAt,
              createdAt: completed.createdAt,
              activatedAt: completed.activatedAt,
              runNumber: 1,
              schedule: { kind: "interval", everyMs: 86_400_000 },
            },
            status: "succeeded",
            openedAt: new Date(completedRun.startedAt).toISOString(),
            closedAt: new Date(completedRun.finishedAt!).toISOString(),
          }}
          automation={completed}
          run={completedRun}
          client={api}
        />
      </Theme>,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Inspect automation tick Daily check/,
      }),
    );
    expect(
      await screen.findByText("Automation completed", { exact: false }),
    ).toBeTruthy();
    expect(screen.getByText("Natural completion response")).toBeTruthy();
    expect(
      screen.getByText("The monitored rollout is healthy everywhere."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
  });
});
