// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it } from "vitest";
import {
  FileMutationResultView,
  renderFileMutationArguments,
  type FileMutationDetails,
} from "./FileMutationResult";
import { toolPresentation } from "../ActionMessage";

function renderThemed(node: ReactNode) {
  return render(<Theme>{node}</Theme>);
}

describe("file mutation invocation presentation", () => {
  it("summarizes file tools by path and gives recoverable conflicts an amber pill", () => {
    const presentation = toolPresentation({
      id: "call:edit",
      name: "edit",
      arguments: { path: "packages/demo/index.ts", oldText: "old title", newText: "new title" },
      execution: {
        status: "complete",
        description: "",
        result: {
          details: {
            protocol: "file-mutation.v1",
            status: "conflict",
            storage: "vcs",
            operations: [],
            conflicts: [],
          },
        },
      },
    });

    expect(presentation).toMatchObject({
      displayName: "Edit",
      color: "amber",
      preview: expect.stringContaining("packages/demo/index.ts"),
    });
  });

  it("renders write arguments as a file operation instead of a raw JSON dump", () => {
    renderThemed(
      renderFileMutationArguments("write", {
        path: "packages/demo/index.ts",
        content: "export const answer = 42;\n",
        intent: "Expose the computed answer",
        createOnly: true,
      })
    );

    expect(screen.getByTestId("file-mutation-arguments")).toBeTruthy();
    expect(screen.getByText("packages/demo/index.ts")).toBeTruthy();
    expect(screen.getByText("Expose the computed answer")).toBeTruthy();
    expect(screen.getByText("create only")).toBeTruthy();
    expect(screen.getByText("Complete file content")).toBeTruthy();
    expect(document.body.textContent).toContain("export const answer = 42");
  });

  it("renders normalized-match evidence and semantic provenance", () => {
    const details: FileMutationDetails = {
      protocol: "file-mutation.v1",
      status: "applied",
      storage: "vcs",
      intent: "Update the visible title",
      operations: [
        {
          operation: 0,
          path: "packages/demo/index.ts",
          kind: "replace",
          status: "changed",
          firstChangedLine: 8,
          diff: '-8 const title = “Old”;\n+8 const title = "New";',
          matches: [{ replacement: 0, mode: "normalized", line: 8 }],
        },
      ],
      conflicts: [],
      vcsResult: {
        workUnitId: "work:1",
        applicationId: "application:1",
        changeIds: ["change:1"],
        workingHead: { kind: "application", applicationId: "application:1" },
      },
    };

    renderThemed(<FileMutationResultView details={details} />);

    expect(screen.getByText("semantic VCS")).toBeTruthy();
    expect(screen.getByText(/normalized match at line 8/)).toBeTruthy();
    expect(screen.getByText("Diff · first change line 8")).toBeTruthy();
    expect(screen.getByText("Semantic VCS evidence")).toBeTruthy();
  });

  it("renders recoverable conflicts as amber evidence rather than opaque errors", () => {
    const details: FileMutationDetails = {
      protocol: "file-mutation.v1",
      status: "conflict",
      storage: "vcs",
      operations: [],
      conflicts: [
        {
          operation: 0,
          path: "packages/demo/index.ts",
          reason: "ambiguous",
          message: "The requested text occurs 2 times.",
          matchMode: "normalized",
          matchCount: 2,
          candidateLines: [8, 19],
          recovery: {
            action: "reobserve",
            instruction: "Include enough surrounding text to identify one occurrence.",
          },
          closestCurrentExcerpts: [{ startLine: 7, endLine: 9, text: "const title = old;" }],
        },
      ],
    };

    renderThemed(<FileMutationResultView details={details} />);

    expect(screen.getByText("conflict")).toBeTruthy();
    expect(screen.getByText("ambiguous")).toBeTruthy();
    expect(screen.getByText("Candidate lines: 8, 19")).toBeTruthy();
    expect(screen.getByText("Current lines 7–9")).toBeTruthy();
    expect(document.body.textContent).toContain("Include enough surrounding text");
  });

  it("explains that a bounded diff preview did not truncate the mutation", () => {
    const details: FileMutationDetails = {
      protocol: "file-mutation.v1",
      status: "applied",
      storage: "scratch",
      operations: [
        {
          operation: 0,
          path: ".tmp/large.txt",
          kind: "write",
          status: "changed",
          diff: "-old\n+new\n…",
          diffTruncated: true,
          diffOriginalChars: 80_000,
        },
      ],
      conflicts: [],
    };

    renderThemed(<FileMutationResultView details={details} />);

    expect(document.body.textContent).toContain("Diff preview truncated from 80,000 characters");
    expect(document.body.textContent).toContain("mutation itself was applied in full");
  });
});
