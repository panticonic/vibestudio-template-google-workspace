import { describe, expect, it, vi } from "vitest";
import {
  createPanelCdpEndpointTool,
  createPanelConsoleTool,
  createPanelEvalTool,
  createPanelScreenshotTool,
} from "./panel-debug-tools.js";

const BOUND = "slot-a";

function calls(result: unknown) {
  const callMain = vi.fn(async () => result) as unknown as <T>(
    method: string,
    args: unknown[],
  ) => Promise<T>;
  return callMain as typeof callMain & {
    mock: { calls: [string, unknown[]][] };
  };
}

describe("panel_screenshot", () => {
  it("returns the image alongside a line naming the panel it came from", async () => {
    const callMain = calls({
      data: "aGk=",
      mimeType: "image/png",
      width: 800,
      height: 600,
    });
    const tool = createPanelScreenshotTool(callMain, BOUND);

    const result = await tool.execute("t1", { format: "jpeg" });
    expect(callMain.mock.calls[0]).toEqual([
      "panelCdp.screenshot",
      ["slot-a", { format: "jpeg" }],
    ]);
    expect(result.content[0]).toMatchObject({ type: "image", data: "aGk=" });
    expect(result.content[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining("800"),
    });
  });

  it("acts on an explicitly named panel when given one", async () => {
    const callMain = calls({
      data: "aGk=",
      mimeType: "image/png",
      width: 1,
      height: 1,
    });
    await createPanelScreenshotTool(callMain, BOUND).execute("t1", {
      panelId: "slot-other",
    });
    expect(callMain.mock.calls[0]?.[1]?.[0]).toBe("slot-other");
  });
});
describe("panel_console", () => {
  const history = {
    entries: [
      {
        timestamp: 1,
        level: "info",
        message: "booted",
        line: 1,
        sourceId: "s",
        url: "app.js",
      },
    ],
    errors: [
      {
        timestamp: 2,
        level: "error",
        message: "boom",
        line: 9,
        sourceId: "s",
        url: "app.js",
      },
    ],
    page: { nextBeforeSeq: 7, hasOlder: true },
    dropped: { entries: 4, errors: 1 },
    capacity: { entries: 1000, errors: 500 },
  };

  it("renders bodies, not counts, and says when history was dropped", async () => {
    const callMain = calls(history);
    const result = await createPanelConsoleTool(callMain, BOUND).execute(
      "t1",
      {},
    );
    const text = result.content
      .map((part) => ("text" in part ? part.text : ""))
      .join("");
    expect(text).toContain("[error] boom");
    expect(text).toContain("[info] booted");
    // The history is bounded, and an agent that does not know that will
    // confidently report "no earlier errors".
    expect(text).toContain("4 entries and 1 errors were dropped");
  });

  it("passes search, filters, and the stable paging cursor to the host", async () => {
    const callMain = calls(history);
    await createPanelConsoleTool(callMain, BOUND).execute("t1", {
      levels: ["warning", "error"],
      sources: ["console"],
      contains: "render failed",
      beforeSeq: 42,
      limit: 5,
    });
    expect(callMain.mock.calls[0]).toEqual([
      "panelCdp.consoleHistory",
      [
        "slot-a",
        {
          limit: 5,
          errorLimit: 25,
          levels: ["warning", "error"],
          sources: ["console"],
          contains: "render failed",
          beforeSeq: 42,
        },
      ],
    ]);
  });

  it("says (none) rather than rendering an empty section", async () => {
    const callMain = calls({
      entries: [],
      errors: [],
      page: { nextBeforeSeq: null, hasOlder: false },
      dropped: { entries: 0, errors: 0 },
      capacity: { entries: 1000, errors: 500 },
    });
    const result = await createPanelConsoleTool(callMain, BOUND).execute(
      "t1",
      {},
    );
    const text = result.content
      .map((part) => ("text" in part ? part.text : ""))
      .join("");
    expect(text).toContain("console: (none)");
    expect(text).not.toContain("were dropped");
  });
});

describe("panel_eval", () => {
  it("reports a value with its type", async () => {
    const callMain = calls({
      ok: true,
      type: "number",
      value: "720",
      error: null,
      truncated: false,
    });
    const result = await createPanelEvalTool(callMain, BOUND).execute("t1", {
      expression: "innerWidth",
    });
    expect(callMain.mock.calls[0]).toEqual([
      "panelCdp.evaluate",
      ["slot-a", "innerWidth", {}],
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ text: "number: 720" });
  });

  it("surfaces a thrown expression as a tool error the model can read", async () => {
    const callMain = calls({
      ok: false,
      type: "error",
      value: null,
      error: "TypeError: x is not a function",
      truncated: false,
    });
    const result = await createPanelEvalTool(callMain, BOUND).execute("t1", {
      expression: "x()",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("not a function"),
    });
  });

  it("says when a value was cut instead of presenting a partial value as whole", async () => {
    const callMain = calls({
      ok: true,
      type: "string",
      value: "xxx",
      error: null,
      truncated: true,
    });
    const result = await createPanelEvalTool(callMain, BOUND).execute("t1", {
      expression: "big",
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("truncated"),
    });
  });

  it("refuses an empty expression without calling the host", async () => {
    const callMain = calls(null);
    const result = await createPanelEvalTool(callMain, BOUND).execute("t1", {});
    expect(result.isError).toBe(true);
    expect(callMain.mock.calls).toHaveLength(0);
  });
});

describe("panel_cdp_endpoint", () => {
  it("returns the endpoint and points the model at the cheaper tools", async () => {
    const callMain = calls({
      wsEndpoint: "ws://server/cdp/slot-a",
      token: "t",
    });
    const tool = createPanelCdpEndpointTool(callMain, BOUND);
    const result = await tool.execute("t1", {});
    expect(callMain.mock.calls[0]).toEqual([
      "panelCdp.getCdpEndpoint",
      ["slot-a"],
    ]);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("ws://server/cdp/slot-a"),
    });
    expect(tool.description).toContain("panel_eval");
  });
});
