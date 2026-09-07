import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runExec } from "./exec.js";

describe("runExec", () => {
  it.runIf(process.platform !== "win32")(
    "terminates the complete POSIX process group within the timeout contract",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "vibestudio-shell-exec-"));
      const survivedMarker = join(root, "descendant-survived");
      const script = [
        "trap '' TERM",
        `(trap '' TERM; sleep 0.4; printf survived > ${JSON.stringify(survivedMarker)}) &`,
        "while :; do sleep 1; done",
      ].join("\n");

      const result = await runExec(
        {
          intent: { kind: "script", script },
          timeoutMs: 30,
          maxOutputBytes: 1024,
          cwd: root,
          env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        },
        {
          termGraceMs: 50,
          killGraceMs: 1_000,
          closeGraceMs: 250,
        }
      );

      expect(result).toMatchObject({ exitCode: null, timedOut: true });
      expect(result.durationMs).toBeLessThan(1_500);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await expect(stat(survivedMarker)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );
});
