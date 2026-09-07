// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  installDoctorHostModules,
  runMessageTypeDoctor,
  type MessageTypeDoctorSpec,
} from "./message-type-doctor.js";

function spec(overrides: Partial<MessageTypeDoctorSpec> & { typeId: string }): MessageTypeDoctorSpec {
  return {
    displayMode: "row",
    source: { type: "code", code: "export default function Card() { return null; }" },
    ...overrides,
  };
}

describe("runMessageTypeDoctor", () => {
  it("passes a self-contained type and pinpoints broken ones by stage", async () => {
    installDoctorHostModules({});
    const issues = await runMessageTypeDoctor(
      [
        spec({ typeId: "healthy" }),
        spec({
          typeId: "needs-build",
          source: {
            type: "code",
            // The import must be USED — sucrase elides unused imports, which
            // would make the compile stage legitimately pass.
            code: 'import { x } from "@workspace/somewhere";\nexport default function C() { return x; }',
          },
        }),
        spec({
          typeId: "no-default",
          source: { type: "code", code: "export const Pill = 1;" },
        }),
      ],
      { loadSourceFile: async () => "" }
    );

    expect(issues.filter((issue) => issue.typeId === "healthy")).toEqual([]);
    const buildIssues = issues.filter((issue) => issue.typeId === "needs-build");
    expect(buildIssues.some((issue) => issue.stage === "lint")).toBe(true);
    expect(buildIssues.some((issue) => issue.stage === "compile")).toBe(true);
    expect(
      issues.some(
        (issue) => issue.typeId === "no-default" && issue.message.includes("default component")
      )
    ).toBe(true);
  });
});
