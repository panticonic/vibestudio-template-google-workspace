import { describe, expect, it } from "vitest";
import {
  agentToolFailureFromUnknown,
  agentToolFailureSchema,
  renderAgentToolFailure
} from "./tool-failure.js";

describe("agent tool failure contract", () => {
  it("preserves primary and cleanup errors with exact causal identities", () => {
    const failure = agentToolFailureFromUnknown(
      Object.assign(new Error("push failed"), {
        errorData: {
          code: "ExternalEffectFailed",
          effectId: "effect:1",
          cleanupFailure: { code: "EACCES", message: "cleanup denied" },
          retry: {
            commandIdPolicy: "reuse-identical-only-if-outcome-uncertain"
          }
        }
      }),
      {
        operation: "vcs.push",
        stage: "publish",
        causal: { invocationId: "inv:1", commandId: "cmd:1" }
      }
    );

    expect(agentToolFailureSchema.parse(failure)).toEqual(failure);
    expect(failure).toMatchObject({
      code: "ExternalEffectFailed",
      kind: "external-effect",
      retry: { policy: "retry-identical", commandIdPolicy: "reuse-identical" },
      recovery: { action: "retry-identical" },
      causal: { invocationId: "inv:1", commandId: "cmd:1" },
      causes: [
        { role: "primary", code: "ExternalEffectFailed" },
        { role: "cleanup", code: "EACCES" }
      ]
    });
    expect(renderAgentToolFailure(failure)).toContain("cleanup denied");
  });

  it("normalizes authoritative tool-result failures and explicit recovery actions", () => {
    const failure = agentToolFailureFromUnknown(
      {
        protocolContent: [{ type: "text", text: "panel generation is stale" }],
        details: {
          errorData: {
            code: "stale_panel_generation",
            recovery: {
              action: "reacquire-handle",
              instruction: "Acquire a fresh page from the rebuilt panel generation."
            }
          }
        }
      },
      { operation: "tool.eval", stage: "execute" }
    );

    expect(failure).toMatchObject({
      code: "stale_panel_generation",
      recovery: {
        action: "reacquire-handle",
        instruction: "Acquire a fresh page from the rebuilt panel generation."
      }
    });
  });

  it("maps CDP recovery codes to portable handle recovery", () => {
    const failure = agentToolFailureFromUnknown(
      Object.assign(new Error("target connection closed"), {
        code: "cdp_target_closed",
        errorData: {
          code: "cdp_target_closed",
          failureKind: "infrastructure",
          recovery: "reacquire-page"
        }
      }),
      { operation: "tool.eval", stage: "execute" }
    );

    expect(failure.recovery).toEqual({
      action: "reacquire-handle",
      instruction:
        "Refresh or reacquire the panel's generation-fenced CDP session. Do not reuse the cached page."
    });
  });

  it("maps committed panel recovery into a non-terminal agent action", () => {
    const failure = agentToolFailureFromUnknown(
      Object.assign(new Error("panel presentation failed after commit"), {
        code: "PANEL_OPERATION_FAILED",
        errorData: {
          code: "unknown_failure",
          failureKind: "infrastructure",
          recovery: {
            sameInputRetry: "reobserve-first",
            nextAction: "observe-and-reacquire"
          }
        }
      }),
      { operation: "tool.eval", stage: "execute", kind: "infrastructure" }
    );

    expect(failure.recovery).toEqual({
      action: "reacquire-handle",
      instruction:
        "Observe the committed panel, then reacquire its current handle before continuing."
    });
  });

  it("rebinds an existing envelope to the current operation without losing details", () => {
    const original = agentToolFailureFromUnknown(
      Object.assign(new Error("bad input"), { code: "InvalidReference" }),
      { operation: "vcs.read", stage: "resolve" }
    );
    const rebound = agentToolFailureFromUnknown(
      { failure: original },
      {
        operation: "tool.read",
        stage: "execute",
        causal: { invocationId: "inv:2" }
      }
    );
    expect(rebound).toMatchObject({
      code: original.code,
      operation: "tool.read",
      stage: "execute",
      causal: { invocationId: "inv:2" },
      causes: original.causes
    });
  });

  it("keeps a nested operation failure primary and configuration rollback secondary", () => {
    const failure = agentToolFailureFromUnknown(
      Object.assign(new Error("import wrapper"), {
        errorData: {
          operation: "git.importProject",
          stage: "clone",
          primary: { code: "ENETDOWN", message: "network unavailable" },
          config: {
            rollbackFailure: {
              code: "EACCES",
              message: "rollback cleanup failed"
            }
          }
        }
      }),
      { operation: "git.importProject", stage: "clone" }
    );

    expect(failure).toMatchObject({
      code: "ENETDOWN",
      message: "network unavailable",
      causes: [
        { role: "primary", code: "ENETDOWN", message: "network unavailable" },
        {
          role: "rollback",
          code: "EACCES",
          message: "rollback cleanup failed"
        }
      ]
    });
  });

  it("bounds durable failure data without discarding typed control fields", () => {
    const failure = agentToolFailureFromUnknown(
      Object.assign(new Error("too much detail"), {
        errorData: {
          code: "ExternalEffectFailed",
          effectId: "effect:large",
          body: "x".repeat(40_000)
        }
      }),
      { operation: "network.response.read", stage: "response" }
    );

    expect(failure).toMatchObject({
      code: "ExternalEffectFailed",
      kind: "external-effect",
      data: {
        protocol: "agent-tool-failure-data-summary.v1",
        truncated: true,
        originalBytes: expect.any(Number)
      }
    });
    expect(JSON.stringify(failure).length).toBeLessThan(20_000);
  });

  it("classifies invalid read paths as correctable input, not missing authority", () => {
    const failure = agentToolFailureFromUnknown(
      new Error('[fs.access] Invalid workspace repo path: "packages/maybe?"'),
      { operation: "tool.read", stage: "execute" }
    );
    expect(failure).toMatchObject({
      kind: "invalid-input",
      retry: { policy: "correct-input" }
    });
    expect(renderAgentToolFailure(failure)).toContain("Correct the request");
  });

  it("keeps eval TypeErrors correctable instead of terminal and unknown", () => {
    const failure = agentToolFailureFromUnknown(
      {
        details: {
          error: "scope.panel.cdp.evaluate is not a function",
          failureKind: "user-code",
          failureCode: "guest_type_error"
        }
      },
      { operation: "tool.eval", stage: "execute" }
    );

    expect(failure).toMatchObject({
      code: "guest_type_error",
      kind: "invalid-input",
      retry: { policy: "correct-input" },
      recovery: { action: "correct-request" }
    });
  });

  it("preserves actionable recovery for Durable Object schema shape drift", () => {
    const failure = agentToolFailureFromUnknown(
      {
        details: {
          error: "TaskBoardStore cannot open persisted schema v1 with build schema v1",
          failureKind: "infrastructure",
          failureCode: "DO_SCHEMA_INCOMPATIBLE",
          errorData: {
            reason: "shape-drift",
            persistedVersion: 1,
            targetVersion: 1,
            safeActions: ["deploy-current-build", "reset-storage"]
          }
        }
      },
      { operation: "tool.eval", stage: "execute" }
    );

    expect(failure).toMatchObject({
      code: "DO_SCHEMA_INCOMPATIBLE",
      kind: "infrastructure",
      retry: { policy: "none" },
      recovery: {
        action: "repair-source",
        instruction: expect.stringContaining("schema changed")
      }
    });
  });

  it("keeps generic infrastructure failures available for in-turn diagnosis", () => {
    const failure = agentToolFailureFromUnknown(
      {
        message: "package linker unavailable",
        code: "package_load_failed"
      },
      { operation: "tool.eval", stage: "execute", kind: "infrastructure" }
    );

    expect(failure).toMatchObject({
      kind: "infrastructure",
      retry: { policy: "none", commandIdPolicy: "not-applicable" },
      recovery: {
        action: "reobserve",
        instruction: expect.stringContaining("Do not retry")
      }
    });
  });

  it("turns read-only authority containment into a new writable eval request", () => {
    const failure = agentToolFailureFromUnknown(
      Object.assign(new Error("read-only eval cannot call a write method"), {
        code: "EVAL_READ_ONLY",
        errorData: {
          authorityFailure: {
            reasonCode: "eval-read-only",
            reason: "The current eval is read-only.",
            remediation: {
              kind: "use-writable-session",
              message: 'Issue a new eval with authority.effects set to "read-write".'
            }
          }
        }
      }),
      { operation: "tool.eval", stage: "execute" }
    );

    expect(failure).toMatchObject({
      code: "EVAL_READ_ONLY",
      kind: "authority",
      retry: { policy: "correct-input", commandIdPolicy: "not-applicable" },
      recovery: {
        action: "correct-request",
        instruction: 'Issue a new eval with authority.effects set to "read-write".'
      }
    });
  });

  it("continues in-turn after eval admission loss by reobserving before a fresh cell", () => {
    const failure = agentToolFailureFromUnknown(
      Object.assign(new Error("Evaluated execution session is not active"), {
        code: "eval_execution_admission_lost",
        errorData: {
          failureKind: "infrastructure",
          retry: {
            policy: "reobserve",
            commandIdPolicy: "use-new-after-reobserve"
          },
          recovery: {
            action: "reobserve",
            instruction: "Inspect current state, then issue a new eval for only unfinished work."
          }
        }
      }),
      { operation: "tool.eval", stage: "execute" }
    );

    expect(failure).toMatchObject({
      code: "eval_execution_admission_lost",
      kind: "infrastructure",
      retry: {
        policy: "reobserve",
        commandIdPolicy: "use-new-after-reobserve"
      },
      recovery: {
        action: "reobserve",
        instruction: "Inspect current state, then issue a new eval for only unfinished work."
      }
    });
  });

  it("preserves build-gate source repair semantics instead of inferring a push retry", () => {
    const failure = agentToolFailureFromUnknown(
      Object.assign(new Error("Protected main push rejected"), {
        errorData: {
          code: "BuildGateFailed",
          failureKind: "domain",
          retry: { policy: "none", commandIdPolicy: "not-applicable" },
          recovery: {
            action: "repair-source",
            instruction: "Repair diagnostics and build a new candidate."
          }
        }
      }),
      { operation: "tool.vcs", stage: "execute" }
    );

    expect(failure).toMatchObject({
      kind: "domain",
      retry: { policy: "none", commandIdPolicy: "not-applicable" },
      recovery: {
        action: "repair-source",
        instruction: "Repair diagnostics and build a new candidate."
      }
    });
  });

  it("classifies messaging refusals: unresolved addressees are correctable, closed channels are not", () => {
    const unresolved = agentToolFailureFromUnknown(
      Object.assign(new Error('no participant "@scrib" on this channel.'), {
        code: "unknown-handle",
        errorData: {
          code: "unknown-handle",
          suggestions: ["@scribe"],
          recovery: {
            action: "correct-request",
            instruction: "Did you mean @scribe?"
          }
        }
      }),
      { operation: "notify", stage: "resolve" }
    );
    expect(unresolved).toMatchObject({
      kind: "not-found",
      retry: { policy: "correct-input" },
      recovery: {
        action: "correct-request",
        instruction: "Did you mean @scribe?"
      }
    });

    const ambiguous = agentToolFailureFromUnknown(
      Object.assign(new Error("runs in 2 channels"), {
        code: "ambiguous-agent"
      }),
      { operation: "notify", stage: "resolve" }
    );
    expect(ambiguous.kind).toBe("invalid-input");

    const closed = agentToolFailureFromUnknown(
      Object.assign(new Error("locked membership"), {
        code: "ClosedChannel",
        errorData: {
          code: "ClosedChannel",
          recovery: { action: "stop", instruction: "Do not retry." }
        }
      }),
      { operation: "notify", stage: "deliver" }
    );
    expect(closed).toMatchObject({
      kind: "domain",
      retry: { policy: "none" },
      recovery: { action: "stop" }
    });
  });
});
