import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openPort, openUrl } from "./portClick.js";
import { notifications, openExternal, openPanel } from "@workspace/runtime";

vi.mock("@workspace/runtime", () => ({
  openPanel: vi.fn(),
  openExternal: vi.fn(),
  notifications: { show: vi.fn() },
}));

describe("terminal port/url opening", () => {
  beforeEach(() => {
    vi.mocked(openPanel).mockReset();
    vi.mocked(openExternal).mockReset();
    vi.mocked(notifications.show).mockReset();
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn() } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens detected URLs with the exact matching port in a browser panel", async () => {
    vi.mocked(openPanel).mockResolvedValue({ id: "browser", title: "Browser" } as never);

    await openPort(5173, ["http://localhost:3000/path/5173", "http://127.0.0.1:5173"]);

    expect(openPanel).toHaveBeenCalledWith("http://127.0.0.1:5173", { focus: true });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("falls back to localhost when no detected URL has the requested port", async () => {
    vi.mocked(openPanel).mockResolvedValue({ id: "browser", title: "Browser" } as never);

    await openPort(8080, ["http://localhost:3000/path/8080"]);

    expect(openPanel).toHaveBeenCalledWith("http://localhost:8080", { focus: true });
  });

  it("normalizes wildcard bind hosts to localhost before opening", async () => {
    vi.mocked(openPanel).mockResolvedValue({ id: "browser", title: "Browser" } as never);

    await openPort(5173, ["http://0.0.0.0:5173/app"]);

    expect(openPanel).toHaveBeenCalledWith("http://localhost:5173/app", { focus: true });
  });

  it("falls back from panel open to external browser", async () => {
    vi.mocked(openPanel).mockRejectedValue(new Error("no generic panel"));
    vi.mocked(openExternal).mockResolvedValue({ opened: true } as never);

    await openUrl("https://example.test");

    expect(openPanel).toHaveBeenCalledWith("https://example.test", { focus: true });
    expect(openExternal).toHaveBeenCalledWith("https://example.test");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("copies the URL and notifies when all open paths fail", async () => {
    vi.mocked(openPanel).mockRejectedValue(new Error("no generic panel"));
    vi.mocked(openExternal).mockRejectedValue(new Error("no external"));

    await openUrl("https://example.test");

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://example.test");
    expect(notifications.show).toHaveBeenCalledWith({
      type: "warning",
      title: "URL copied",
      message: "No browser panel was available.",
      ttl: 2500,
    });
  });
});
