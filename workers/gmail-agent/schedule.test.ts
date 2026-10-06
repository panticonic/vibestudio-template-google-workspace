import { afterEach, describe, expect, it } from "vitest";
import { createModels } from "@panticonic/pi-ai";
import { BACKGROUND_CONTEXT } from "@panticonic/pi-chord/context";
import type { Context } from "@panticonic/pi-chord";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@panticonic/pi-durable/storage/sqlite/node";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  MemoryStorage,
  type Storage,
} from "@panticonic/pi-durable";
import { createGmailSchedule } from "./schedule.js";

const context = BACKGROUND_CONTEXT;
const sessions: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    sessions.splice(0).map((session) => session.close(context)),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(
  storage: Storage = new MemoryStorage(),
  poll?: (context: Context) => Promise<void>,
) {
  let now = 0;
  let next: number | null = 100;
  const polls: number[] = [];
  const gmail = createGmailSchedule({
    nextWake: () => next,
    poll: async (context) => {
      await poll?.(context);
      polls.push(now);
      next = now + 100;
    },
  });
  const other = defineTask<null, { phase: "wait" } | { phase: "done" }, null>({
    name: "other",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (_current, runtime, context) => {
        await runtime.commit(
          () => ({
            status: "waiting",
            checkpoint: { phase: "done" },
            condition: { kind: "time", until: 50 },
          }),
          context,
        );
      },
      done: async (_current, runtime, context) => {
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
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
  const registry = createRegistry();
  registry.install(
    defineExtension({ name: "timers", tasks: [gmail.task, other] }),
  );
  const harness = await Harness.open(
    storage,
    {
      models: createModels(),
      registry,
      now: () => now,
      publishWake: async () => {},
    },
    context,
  );
  sessions.push(harness);
  return {
    harness,
    gmail,
    other,
    polls,
    now(value: number) {
      now = value;
    },
    next(value: number | null) {
      next = value;
    },
  };
}

describe("native Gmail scheduling", () => {
  it("retains a failed poll and reports it to the next scheduling caller", async () => {
    const original = new Error("mail authority disconnected");
    const f = await fixture(new MemoryStorage(), async () => {
      throw original;
    });
    await f.gmail.update(f.harness, context);
    await f.harness.runPass(context);
    f.now(100);
    await f.harness.runPass(context);
    await expect(f.gmail.update(f.harness, context)).rejects.toThrow(
      original.message,
    );
    expect(f.polls).toEqual([]);
  });

  it("restores the exact mail deadline after SQLite storage reopens", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gmail-schedule-"));
    directories.push(directory);
    const file = join(directory, "agent.db");
    const original = await fixture(await openNodeSqliteStorage(file));
    await original.gmail.update(original.harness, context);
    expect((await original.harness.runPass(context)).wakeAt).toBe(100);
    await original.harness.close(context);
    const replacement = await fixture(await openNodeSqliteStorage(file));
    replacement.next(300);
    await replacement.gmail.update(replacement.harness, context);
    expect((await replacement.harness.runPass(context)).wakeAt).toBe(100);
    replacement.now(100);
    expect((await replacement.harness.runPass(context)).wakeAt).toBe(200);
    expect(replacement.polls).toEqual([100]);
  });

  it("joins active mail work when its schedule is withdrawn", async () => {
    let started!: () => void;
    const admitted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let released = false;
    const f = await fixture(new MemoryStorage(), async (context) => {
      started();
      try {
        await new Promise<void>((_resolve, reject) => {
          context.abortSignal!.addEventListener(
            "abort",
            () => reject(context.abortSignal!.reason),
            { once: true },
          );
        });
      } finally {
        released = true;
      }
    });
    await f.gmail.update(f.harness, context);
    await f.harness.runPass(context);
    f.now(100);
    const pass = f.harness.runPass(context);
    await admitted;
    f.next(null);
    await f.gmail.update(f.harness, context);
    await pass;
    expect(released).toBe(true);
    expect(f.polls).toEqual([]);
    expect((await f.harness.flushWake(context)).wakeAt).toBeNull();
  });

  it("keeps other agent deadlines when mail scheduling clears", async () => {
    const f = await fixture();
    const conversation = await f.harness.createConversation(
      { ownership: { kind: "ownerless" } },
      context,
    );
    await conversation.commit(async (tx) => {
      await tx.createTask(f.other, null, {
        ownership: { kind: "conversation" },
        background: true,
      });
    }, context);
    await f.gmail.update(f.harness, context);
    expect((await f.harness.runPass(context)).wakeAt).toBe(50);
    f.next(null);
    await f.gmail.update(f.harness, context);
    expect((await f.harness.runPass(context)).wakeAt).toBe(50);
    expect(f.polls).toEqual([]);
  });

  it("advances a mail deadline without postponing it on later requests", async () => {
    const f = await fixture();
    await f.gmail.update(f.harness, context);
    expect((await f.harness.runPass(context)).wakeAt).toBe(100);
    f.next(200);
    await f.gmail.update(f.harness, context);
    expect((await f.harness.runPass(context)).wakeAt).toBe(100);
    f.next(25);
    await f.gmail.update(f.harness, context);
    expect((await f.harness.runPass(context)).wakeAt).toBe(25);
    f.now(25);
    expect((await f.harness.runPass(context)).wakeAt).toBe(125);
    expect(f.polls).toEqual([25]);
  });
});
