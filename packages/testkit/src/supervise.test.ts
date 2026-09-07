import { describe, expect, it, vi } from "vitest";
import { Supervisor } from "./supervise.js";

describe("Supervisor panel lifecycle", () => {
  it("captures console history before a test-owned panel is archived", async () => {
    const consoleHistory = vi.fn(async () => ({
      entries: [
        {
          timestamp: Date.now() + 1,
          source: "console",
          level: "error",
          message: "render failed",
        },
      ],
      errors: [],
    }));
    const handle = {
      id: "panel:test",
      cdp: { consoleHistory },
    };
    const supervisor = new Supervisor();

    supervisor.watchPanel(handle as never);
    await supervisor.capturePanel(handle.id);
    const report = await supervisor.collect();

    expect(consoleHistory).toHaveBeenCalledOnce();
    expect(report.errors).toBe(1);
    expect(report.findings[0]).toMatchObject({
      target: "panel:test",
      kind: "console-error",
      message: "render failed",
    });
  });
});
