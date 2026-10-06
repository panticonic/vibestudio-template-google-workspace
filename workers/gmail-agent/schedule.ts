import type { Context } from "@panticonic/pi-chord";
import {
  defineDoc,
  defineTask,
  type ConversationId,
  type Harness,
  type TaskId,
} from "@panticonic/pi-durable";

const Schedule = defineDoc<{
  conversationId: ConversationId | null;
  taskId: TaskId<null> | null;
}>({
  kind: "gmail.schedule",
  version: 1,
  scope: "session",
  initial: () => ({ conversationId: null, taskId: null }),
  checkpointWhen: () => true,
});

/** Mail deadlines join the native task schedule, including its durable clears. */
export function createGmailSchedule(host: {
  nextWake(): number | null;
  poll(context: Context): Promise<void>;
}) {
  const task = defineTask<
    { until: number },
    { phase: "wait" } | { phase: "poll" },
    null
  >({
    name: "gmail.schedule",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (current, runtime, context) => {
        await runtime.commit(
          () => ({
            status: "waiting",
            checkpoint: { phase: "poll" },
            condition: { kind: "time", until: current.input.until },
          }),
          context,
        );
      },
      poll: async (_current, runtime, context) => {
        await host.poll({ ...context, abortSignal: runtime.signal });
        const until = host.nextWake();
        await runtime.commit(
          () =>
            until === null
              ? {
                  status: "terminal",
                  outcome: { status: "completed", result: null },
                }
              : {
                  status: "waiting",
                  checkpoint: { phase: "poll" },
                  condition: { kind: "time", until },
                },
          context,
        );
      },
    },
    abort: async (_current, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  });

  // Concurrent requests join one scheduling operation. A failed operation
  // propagates to its caller; the next request rereads committed task truth.
  let updating: Promise<void> = Promise.resolve();
  return {
    task,
    update(harness: Harness, context: Context): Promise<void> {
      const operation = updating.then(async () => {
        const schedule = await harness.snapshot(Schedule, context);
        const previous = schedule?.taskId
          ? await harness.getTask(schedule.taskId, context)
          : undefined;
        const until = host.nextWake();
        if (until !== null && previous?.state.status === "terminal") {
          const outcome = previous.state.outcome;
          if (outcome.status === "failed" || outcome.status === "faulted")
            throw new Error(outcome.error.message);
          if (outcome.status === "orphaned")
            throw new Error(
              outcome.reason ??
                "Gmail scheduling task definition is unavailable",
            );
        }
        if (previous && previous.state.status !== "terminal") {
          if (
            until !== null &&
            previous.state.status === "waiting" &&
            previous.state.condition.kind === "failure"
          ) {
            // Only explicit incident repair or withdrawal can settle this debt.
            await harness.waitForTask(previous.id, context);
          }
          const existing =
            previous.state.status === "waiting" &&
            previous.state.condition.kind === "time"
              ? previous.state.condition.until
              : Number((previous.input as { until: number }).until);
          // Ordinary requests must not postpone an already admitted deadline.
          if (until !== null && existing <= until) return;
          await harness.abortTask(previous.id, context);
          await harness.waitForTask(previous.id, context);
        }
        if (until === null) return;
        await harness.commit(async (tx) => {
          const document = await tx.doc(Schedule);
          if (document.conversationId === null) {
            document.conversationId = (
              await tx.createConversation({
                ownership: { kind: "ownerless" },
              })
            ).id;
          }
          document.taskId = await tx.createTask(
            task,
            { until },
            {
              conversationId: document.conversationId,
              ownership: { kind: "conversation" },
              background: true,
            },
          );
        }, context);
        harness.resume();
      });
      updating = operation.catch(() => {});
      return operation;
    },
  };
}
