import { describe, expect, it } from "vitest";
import {
  cpuProfileRef,
  flameTreeFromProfile,
  persistProfile,
  profilePath,
  topFunctions,
  type ProfileRef,
  type V8Profile,
} from "./profile-core.js";

// 1s wall time, 10 hits total: root(0) -> a(6 hits), b(4 hits)
const PROFILE: V8Profile = {
  startTime: 0,
  endTime: 1_000_000,
  samples: [2, 2, 2, 2, 2, 2, 3, 3, 3, 3],
  nodes: [
    { id: 1, callFrame: { functionName: "(root)" }, hitCount: 0, children: [2, 3] },
    { id: 2, callFrame: { functionName: "alpha", url: "file:///a.ts" }, hitCount: 6 },
    { id: 3, callFrame: { functionName: "" }, hitCount: 4 },
  ],
};

describe("profile-core", () => {
  it("ranks top functions by self time", () => {
    expect(topFunctions(PROFILE)).toEqual([
      { name: "alpha", selfMs: 600 },
      { name: "(anonymous)", selfMs: 400 },
    ]);
  });

  it("builds a flame tree with self and total times", () => {
    const flame = flameTreeFromProfile(PROFILE);
    expect(flame.totalMs).toBeCloseTo(1000, 3);
    expect(flame.children).toHaveLength(1);
    const root = flame.children[0]!;
    expect(root.name).toBe("(root)");
    expect(root.selfMs).toBe(0);
    expect(root.totalMs).toBeCloseTo(1000, 3);
    expect(root.children.map((child) => child.name)).toEqual(["alpha", "(anonymous)"]);
    expect(root.children[0]!.selfMs).toBeCloseTo(600, 3);
  });

  it("creates refs with stable artifact paths and summaries", () => {
    const ref = cpuProfileRef("panel:demo", 1_700_000_000_000, PROFILE);
    expect(ref.path).toBe(profilePath("panel:demo", "cpuprofile", 1_700_000_000_000));
    expect(ref.path).toMatch(/^\/\.testkit\/profiles\/.*panel_demo\.cpuprofile$/);
    expect(ref.summary.totalSamples).toBe(10);
    expect(ref.summary.topFunctions?.[0]?.name).toBe("alpha");
  });

  it("persists artifacts and maintains index.json via the fs shim", async () => {
    const files = new Map<string, string>();
    const fakeFs = {
      mkdir: async () => undefined,
      readFile: async (path: string) => {
        const data = files.get(path);
        if (data === undefined) throw new Error("ENOENT");
        return data;
      },
      writeFile: async (path: string, data: string | Uint8Array) => {
        files.set(path, String(data));
      },
    };
    const ref = cpuProfileRef("panel:demo", 1_700_000_000_000, PROFILE);
    const saved = await persistProfile(fakeFs, ref, JSON.stringify(PROFILE));
    expect(saved.summary.sizeBytes).toBeGreaterThan(0);
    expect(files.has(ref.path)).toBe(true);
    const index = JSON.parse(files.get("/.testkit/profiles/index.json")!) as ProfileRef[];
    expect(index).toHaveLength(1);
    const again = await persistProfile(fakeFs, { ...ref, startedAt: ref.startedAt + 1 }, "{}");
    expect(again).toBeTruthy();
    const index2 = JSON.parse(files.get("/.testkit/profiles/index.json")!) as ProfileRef[];
    expect(index2).toHaveLength(2);
  });
});
