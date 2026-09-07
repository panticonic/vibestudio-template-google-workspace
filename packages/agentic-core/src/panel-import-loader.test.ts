import { describe, expect, it, vi } from "vitest";
import { createPanelImportLoader } from "./panel-import-loader.js";

describe("createPanelImportLoader", () => {
  it("binds automatic workspace imports to the panel's semantic context", async () => {
    const call = vi.fn(async () => ({ bundle: "panel-bundle", format: "cjs" as const }));
    const loadImport = createPanelImportLoader(
      { call },
      { defaultWorkspaceRef: () => "ctx:panel-context" }
    );

    await expect(loadImport("@workspace/example", "workspace:*", [])).resolves.toEqual({
      bundle: "panel-bundle",
      format: "cjs",
    });
    expect(call).toHaveBeenCalledWith("main", "build.getBuild", [
      "@workspace/example",
      "ctx:panel-context",
      { library: true, externals: [], libraryTarget: "panel" },
    ]);
  });
});
