import { describe, expect, it } from "vitest";
import { settingsToastMessage } from "./settingsFeedback.js";

describe("settings feedback", () => {
  it("describes terminal setting changes for pane-local toasts", () => {
    expect(settingsToastMessage({ fontSize: 15 })).toBe("Font 15px");
    expect(settingsToastMessage({ scrollbackBytes: 256 * 1024 })).toBe("Scrollback 256 KB");
    expect(settingsToastMessage({ scrollbackBytes: 4 * 1024 * 1024 })).toBe("Scrollback 4 MB");
    expect(settingsToastMessage({ themeOverride: "dark" })).toBe("Theme dark");
    expect(settingsToastMessage({ pasteMode: "dataUri" })).toBe("Paste files as data URI");
    expect(settingsToastMessage({ pasteMode: "both" })).toBe("Paste files as path and data URI");
    expect(settingsToastMessage({ imagePasteRelative: true })).toBe("Relative file paths on");
    expect(settingsToastMessage({ imagePasteRelative: false })).toBe("Relative file paths off");
  });

  it("does not toast changes that would be noisy while typing", () => {
    expect(settingsToastMessage({})).toBeUndefined();
  });
});
