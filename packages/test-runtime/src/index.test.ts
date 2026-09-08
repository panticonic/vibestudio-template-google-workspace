import {
  describe as vitestDescribe,
  expect as vitestExpect,
  it as vitestIt,
} from "vitest";
import type {
  RpcClient,
  RpcContextHandler,
  WebsiteMethodPolicy,
} from "@vibestudio/rpc";
import {
  describe,
  exposeTestRunner,
  expect,
  it,
  runTests,
  setCurrentTestFile,
  vi,
} from "./index.js";

vitestDescribe("portable test runtime", () => {
  vitestIt(
    "collects async tests with their build-assigned file identity",
    async () => {
      setCurrentTestFile("example.test.ts");
      describe("example", () => {
        it("passes", async () => {
          await Promise.resolve();
          expect({ value: 1 }).toEqual({ value: 1 });
          await expect(Promise.reject(new Error("expected"))).rejects.toThrow(
            "expected",
          );
          const observer = vi.fn();
          observer("event", 1);
          expect(observer).toHaveBeenCalledWith("event", 1);
        });
      });
      const result = await runTests(
        {
          protocol: "workspace-test-execution-request.v1",
          artifactKey: "artifact",
          executionDigest: "a".repeat(64),
          limits: { timeoutMs: 1_000, memoryMb: 64 },
        },
        "workerd",
      );
      vitestExpect(result).toMatchObject({
        status: "passed",
        passed: 1,
        failed: 0,
        files: [{ file: "example.test.ts", status: "pass" }],
      });
    },
  );

  vitestIt("registers the sealed runner with an explicit closed website policy", async () => {
    let exposure:
      | { method: string; handler: RpcContextHandler; website: WebsiteMethodPolicy }
      | undefined;
    const rpc: Pick<RpcClient, "expose"> = {
      expose(method, handler, website) {
        exposure = { method, handler: handler as RpcContextHandler, website };
      },
    };
    exposeTestRunner(rpc, "workerd");

    vitestExpect(exposure).toMatchObject({
      method: "tests.run",
      handler: vitestExpect.any(Function),
      website: {
        kind: "closed",
        reason: "Workspace test execution is private to the owning test runner.",
      },
    });
    setCurrentTestFile("exposed.test.ts");
    it("runs through the exposed handler", () => {});
    const observations: Array<unknown> = [];
    exposeTestRunner(rpc, "workerd", (result) => observations.push(result));
    const result = await exposure!.handler({
      args: [
        {
          protocol: "workspace-test-execution-request.v1",
          artifactKey: "exposed-artifact",
          executionDigest: "b".repeat(64),
          testName: "runs through the exposed handler",
          limits: { timeoutMs: 1_000, memoryMb: 64 },
        },
      ],
    } as never);
    vitestExpect(result).toMatchObject({
      status: "passed",
      passed: 1,
      runtime: "workerd",
    });
    vitestExpect(observations).toEqual([undefined, result]);
  });
});
