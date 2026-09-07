/**
 * Pure profiling helpers shared by the panel-side SDK (profile.ts) and the
 * testkit-driver DO. No runtime imports — safe in any environment.
 */

export interface ProfileRef {
  path: string;
  kind: "cpuprofile" | "heapsnapshot";
  target: string;
  startedAt: number;
  durationMs: number;
  summary: {
    totalSamples?: number;
    sizeBytes?: number;
    topFunctions?: Array<{ name: string; selfMs: number }>;
  };
}

export interface V8ProfileNode {
  id: number;
  callFrame: { functionName: string; url?: string };
  hitCount?: number;
  children?: number[];
}

export interface V8Profile {
  nodes: V8ProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

export const PROFILES_DIR = "/.testkit/profiles";
export const PROFILES_INDEX_PATH = `${PROFILES_DIR}/index.json`;

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
}

export function profilePath(target: string, kind: ProfileRef["kind"], startedAt: number): string {
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  const ext = kind === "cpuprofile" ? "cpuprofile" : "heapsnapshot";
  return `${PROFILES_DIR}/${stamp}-${sanitize(target)}.${ext}`;
}

/** Self-time leaders from a V8 profile, for compact summaries. */
export function topFunctions(
  profile: V8Profile,
  limit = 5
): Array<{ name: string; selfMs: number }> {
  const totalHits = profile.nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0);
  if (totalHits === 0) return [];
  const totalMs = (profile.endTime - profile.startTime) / 1000;
  return profile.nodes
    .filter((node) => (node.hitCount ?? 0) > 0)
    .sort((a, b) => (b.hitCount ?? 0) - (a.hitCount ?? 0))
    .slice(0, limit)
    .map((node) => ({
      name: node.callFrame.functionName || "(anonymous)",
      selfMs: Math.round(((node.hitCount ?? 0) / totalHits) * totalMs),
    }));
}

export function cpuProfileRef(target: string, startedAt: number, profile: V8Profile): ProfileRef {
  return {
    path: profilePath(target, "cpuprofile", startedAt),
    kind: "cpuprofile",
    target,
    startedAt,
    durationMs: Date.now() - startedAt,
    summary: {
      totalSamples: profile.samples?.length ?? 0,
      topFunctions: topFunctions(profile),
    },
  };
}

export interface FlameNode {
  name: string;
  url?: string;
  /** Self time in ms (sample-attributed). */
  selfMs: number;
  /** Total time in ms (self + descendants). */
  totalMs: number;
  children: FlameNode[];
}

/**
 * Build a flamegraph tree from a V8 .cpuprofile: hitCount-weighted self time
 * distributed over the recorded wall time, totals aggregated bottom-up.
 */
export function flameTreeFromProfile(profile: V8Profile): FlameNode {
  const totalHits = profile.nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0);
  const totalMs = Math.max(0, (profile.endTime - profile.startTime) / 1000);
  const msPerHit = totalHits > 0 ? totalMs / totalHits : 0;
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const childIds = new Set(profile.nodes.flatMap((node) => node.children ?? []));
  const roots = profile.nodes.filter((node) => !childIds.has(node.id));

  const build = (node: V8ProfileNode): FlameNode => {
    const children = (node.children ?? [])
      .map((id) => byId.get(id))
      .filter((child): child is V8ProfileNode => Boolean(child))
      .map(build)
      .sort((a, b) => b.totalMs - a.totalMs);
    const selfMs = (node.hitCount ?? 0) * msPerHit;
    return {
      name: node.callFrame.functionName || "(anonymous)",
      url: node.callFrame.url || undefined,
      selfMs,
      totalMs: selfMs + children.reduce((sum, child) => sum + child.totalMs, 0),
      children,
    };
  };

  const rootChildren = roots.map(build).sort((a, b) => b.totalMs - a.totalMs);
  return {
    name: "(profile)",
    selfMs: 0,
    totalMs: rootChildren.reduce((sum, child) => sum + child.totalMs, 0),
    children: rootChildren,
  };
}

/** Minimal fs surface needed to persist profiles (matches RuntimeFs subset). */
export interface ProfileFsLike {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  readFile(path: string, encoding?: string): Promise<string | Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
}

/** Persist a profile artifact + maintain the shared index.json. */
export async function persistProfile(
  fs: ProfileFsLike,
  ref: ProfileRef,
  data: string
): Promise<ProfileRef> {
  await fs.mkdir(PROFILES_DIR, { recursive: true });
  await fs.writeFile(ref.path, data);
  const withSize: ProfileRef = { ...ref, summary: { ...ref.summary, sizeBytes: data.length } };
  let index: ProfileRef[] = [];
  try {
    index = JSON.parse((await fs.readFile(PROFILES_INDEX_PATH, "utf8")) as string) as ProfileRef[];
  } catch {
    // First profile — no index yet.
  }
  index.unshift(withSize);
  await fs.writeFile(PROFILES_INDEX_PATH, JSON.stringify(index, null, 2));
  return withSize;
}
