import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@workspace/pi-core";
import { assertAgentToolParametersSchema, prepareAgentToolArguments } from "./tool-arguments.js";

function tool(): AgentTool {
  return {
    name: "vcs",
    label: "vcs",
    parameters: Type.Object({ operation: Type.Literal("status") }, { additionalProperties: false }),
    execute: vi.fn(),
  } as unknown as AgentTool;
}

describe("prepareAgentToolArguments", () => {
  it("rejects malformed schemas before they reach a model provider", () => {
    expect(() => assertAgentToolParametersSchema("broken", { type: "wat" })).toThrow(
      /invalid JSON Schema/u
    );
    expect(() => assertAgentToolParametersSchema("missing", undefined)).toThrow(
      /JSON Schema object/u
    );
  });

  it("returns arguments that satisfy the advertised schema", () => {
    const input = { operation: "status" };
    expect(prepareAgentToolArguments(tool(), input)).toBe(input);
  });

  it("rejects malformed model arguments before tool execution", () => {
    try {
      prepareAgentToolArguments(tool(), { operation: "listFiles", sourceEventId: "event:1" });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_tool_arguments",
        message: expect.stringMatching(/Invalid arguments for tool vcs/u),
      });
    }
  });

  it("names the allowed operations when a union discriminator is unknown", () => {
    const parameters = Type.Union([
      Type.Object({ operation: Type.Literal("status") }),
      Type.Object({ operation: Type.Literal("push") }),
    ]);
    const selected = { ...tool(), parameters } as AgentTool;
    expect(() => prepareAgentToolArguments(selected, { operation: "commit" })).toThrow(
      '/operation: Expected one of "status", "push"; received "commit"'
    );
  });

  it("reports the selected operation and nested decision branch", () => {
    const parameters = Type.Union([
      Type.Object({ operation: Type.Literal("status") }),
      Type.Object({
        operation: Type.Literal("merge"),
        decision: Type.Union([
          Type.Object({
            kind: Type.Literal("adopted"),
            sourceChangeIds: Type.Array(Type.String()),
          }),
          Type.Object({
            kind: Type.Literal("reconciled"),
            sourceChangeIds: Type.Array(Type.String()),
            evidence: Type.Array(Type.String()),
          }),
        ]),
      }),
    ]);
    const selected = { ...tool(), parameters } as AgentTool;
    expect(() =>
      prepareAgentToolArguments(selected, {
        operation: "merge",
        decision: { kind: "reconciled", sourceChangeIds: ["change:1"] },
      })
    ).toThrow("/decision/evidence: Expected required property");
  });

  it("reports extra fields from the selected branch when it has an optional literal", () => {
    const parameters = Type.Union([
      Type.Object({ operation: Type.Literal("status") }, { additionalProperties: false }),
      Type.Object(
        {
          operation: Type.Literal("compare"),
          sourceEventId: Type.Optional(Type.String()),
          view: Type.Optional(Type.Literal("local")),
          status: Type.Optional(Type.Literal("conflict")),
        },
        { additionalProperties: false }
      ),
    ]);
    const selected = { ...tool(), parameters } as AgentTool;

    expect(() =>
      prepareAgentToolArguments(selected, {
        operation: "compare",
        view: "local",
        intent: "Inspect local work",
      })
    ).toThrow("/intent: Unexpected property");

    expect(() =>
      prepareAgentToolArguments(selected, {
        operation: "compare",
        view: "local",
        status: "working",
      })
    ).toThrow("/status: Expected 'conflict'");
  });

  it("reports the selected union branch for operations nested in an array", () => {
    const parameters = Type.Object({
      operations: Type.Array(
        Type.Union([
          Type.Object(
            {
              kind: Type.Literal("replace"),
              replacements: Type.Array(Type.String()),
            },
            { additionalProperties: false }
          ),
          Type.Object(
            {
              kind: Type.Literal("write_binary"),
              base64: Type.String(),
            },
            { additionalProperties: false }
          ),
        ])
      ),
    });
    const selected = { ...tool(), name: "apply_patch", parameters } as AgentTool;

    expect(() =>
      prepareAgentToolArguments(selected, {
        operations: [
          {
            kind: "write_binary",
            base64: "AP8B/g==",
            intent: "misplaced operation intent",
          },
        ],
      })
    ).toThrow("/operations/0/intent: Unexpected property");

    expect(() =>
      prepareAgentToolArguments(selected, {
        operations: [{ kind: "chmod", mode: 0o644 }],
      })
    ).toThrow('/operations/0/kind: Expected one of "replace", "write_binary"');

    const input = {
      operations: [
        { kind: "replace", replacements: ["old"] },
        { kind: "write_binary", base64: "AP8B/g==" },
      ],
    };
    expect(prepareAgentToolArguments(selected, input)).toBe(input);
  });

  it("validates plain JSON-schema tools at the same execution boundary", () => {
    const plain = {
      ...tool(),
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    } as unknown as AgentTool;
    expect(prepareAgentToolArguments(plain, { query: "history" })).toEqual({ query: "history" });
    expect(() => prepareAgentToolArguments(plain, {})).toThrow(/query/u);
    expect(() => prepareAgentToolArguments(plain, { query: 42 })).toThrow(/string/u);
  });
});
