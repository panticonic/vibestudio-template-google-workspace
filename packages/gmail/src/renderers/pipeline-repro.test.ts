// @vitest-environment jsdom
/**
 * Message-type doctor over the real gmail renderer registrations: every type
 * must survive registration → channel reducer → projection → lint →
 * self-contained compile (no build-service imports). The reference usage of
 * `runMessageTypeDoctor` — copy this pattern for any agent that registers
 * custom message renderers.
 */
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assertMessageTypesHealthy, installDoctorHostModules } from "@workspace/agentic-core";
import { GMAIL_MESSAGE_TYPES } from "../../../../workers/gmail-agent/cards/cards.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

const GMAIL_UI_IMPORTS = {
  react: "latest",
  "react/jsx-runtime": "latest",
  "@radix-ui/themes": "npm:^3.2.1",
  "@radix-ui/react-icons": "npm:^1.3.2",
};

describe("gmail card render pipeline", () => {
  it("all gmail message types pass the doctor (registration → compile, build service forbidden)", async () => {
    installDoctorHostModules({
      react: await import("react"),
      "react/jsx-runtime": await import("react/jsx-runtime"),
      "react/jsx-dev-runtime": await import("react/jsx-dev-runtime"),
      "@radix-ui/themes": await import("@radix-ui/themes"),
      "@radix-ui/react-icons": await import("@radix-ui/react-icons"),
    });

    await expect(
      assertMessageTypesHealthy(
        GMAIL_MESSAGE_TYPES.map((spec) => ({
          typeId: spec.typeId,
          displayMode: spec.displayMode,
          source: { type: "file", path: spec.path },
          imports: GMAIL_UI_IMPORTS,
          stateSchema: spec.stateSchema,
          ...(spec.updateSchema ? { updateSchema: spec.updateSchema } : {}),
        })),
        {
          loadSourceFile: (filePath: string) => fs.readFile(path.join(REPO_ROOT, filePath), "utf8"),
        }
      )
    ).resolves.toBeUndefined();
  }, 30_000);
});
