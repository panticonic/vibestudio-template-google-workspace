import { fileURLToPath } from "node:url";
import { workspaceProgramFailures } from "@workspace/natlang/testing";
import { expect, it } from "vitest";

it("compiles the Google Workspace workflow with caller-bound setup observations", async () => {
  expect(
    await workspaceProgramFailures(
      fileURLToPath(new URL("../..", import.meta.url)),
    ),
  ).toEqual([]);
});
