import {
  describe as vitestDescribe,
  expect as vitestExpect,
  it as vitestIt,
} from "vitest";
import {
  describe,
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
});
