import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCRATCH_TTL_MS, sweepScratch } from "./index.js";

describe("scratch janitor", () => {
  it("removes stale scratch files and preserves fresh files", async () => {
    const scratchDir = join(tmpdir(), `scratch-janitor-${process.pid}-${Date.now()}`);
    await mkdir(scratchDir, { recursive: true });
    const now = Date.now();
    const stale = join(scratchDir, "stale.png");
    const fresh = join(scratchDir, "fresh.png");
    await writeFile(stale, "old");
    await writeFile(fresh, "new");
    const staleTime = new Date(now - SCRATCH_TTL_MS - 1000);
    await utimes(stale, staleTime, staleTime);

    await sweepScratch(scratchDir, now);

    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fresh, "utf8")).resolves.toBe("new");
  });

  it("ignores a missing scratch directory", async () => {
    await expect(sweepScratch(join(tmpdir(), `missing-scratch-${process.pid}-${Date.now()}`))).resolves.toBeUndefined();
  });
});
