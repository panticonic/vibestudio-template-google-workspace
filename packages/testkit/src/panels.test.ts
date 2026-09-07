import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtimeOpenPanel: vi.fn(),
}));

vi.mock("@workspace/runtime", () => ({
  openPanel: mocks.runtimeOpenPanel,
  panelTree: {
    self() {
      throw new Error("no self in unit test");
    },
  },
}));
vi.mock("./cdp.js", () => ({
  withCdpSession: vi.fn(),
  _registerDriverRoute: vi.fn(),
}));

describe("testkit panel helpers", () => {
  beforeEach(() => {
    mocks.runtimeOpenPanel.mockReset();
    mocks.runtimeOpenPanel.mockResolvedValue({
      id: "panel:test",
    });
  });

  it("delegates readiness to the runtime's boot-ready open operation", async () => {
    const { openPanel } = await import("./panels.js");

    await openPanel("about/testbench");

    expect(mocks.runtimeOpenPanel).toHaveBeenCalledOnce();
  });

  it("keeps canonical RPC endpoint identity in polling diagnostics", async () => {
    const { waitFor } = await import("./panels.js");
    const error = Object.assign(new Error('Method "_agent.snapshot" is not exposed by this endpoint'), {
      errorData: {
        kind: "rpc-endpoint",
        endpointId: "panel:nav-stale",
        requestedMethod: "_agent.snapshot",
      },
    });

    await expect(
      waitFor(
        () => {
          throw error;
        },
        { timeoutMs: 0, label: "snapshot" }
      )
    ).rejects.toThrow(
      'last error: Method "_agent.snapshot" is not exposed by this endpoint (endpoint=panel:nav-stale, method=_agent.snapshot)'
    );
  });
});

describe("visible panel overflow", () => {
  async function layout(clipped: boolean, scrollWidth = 390) {
    const { PANEL_AUDIT_EXPRESSION } = await import("./panels.js");
    const container = {
      tagName: "SECTION",
      className: "scene",
      parentElement: null,
      getBoundingClientRect: () => ({ left: 0, right: 390, width: 390 }),
    };
    const illustration = {
      tagName: "svg",
      className: "illustration",
      parentElement: container,
      getBoundingClientRect: () => ({ left: -115, right: 505, width: 620 }),
    };
    const document = {
      querySelectorAll: () => [container, illustration],
      documentElement: { scrollWidth, scrollHeight: 844 },
    };
    const evaluate = new Function(
      "window",
      "document",
      "getComputedStyle",
      `return ${PANEL_AUDIT_EXPRESSION}`,
    );
    return JSON.parse(
      evaluate({ innerWidth: 390, innerHeight: 844 }, document, () => ({
        overflowX: clipped ? "hidden" : "visible",
      })),
    );
  }
  it("accepts artwork clipped by its scene", async () => {
    const result = await layout(true);
    expect(result.horizontalOverflow).toBe(false);
    expect(result.overflowElements).toEqual([]);
  });
  it("still catches visible elements and a genuinely scrollable document", async () => {
    expect((await layout(false)).horizontalOverflow).toBe(true);
    expect((await layout(true, 620)).horizontalOverflow).toBe(true);
  });
});
