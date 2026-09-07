/**
 * Copy-paste eval snippets for the testkit skill. Each export is a runnable
 * helper that agents can adapt in eval or local test code.
 */
import {
  expect,
  heapSnapshot,
  listProfiles,
  listUnits,
  openPanel,
  panelText,
  profileBuild,
  profileHost,
  profilePanel,
  profilePanelInteraction,
  profilePanelReload,
  profileWorkerd,
  readStartupProfile,
  listWorkerdTargets,
  runSuites,
  summarize,
  supervise,
  suite,
  waitForText,
  type RunSummary,
  type ProfileRef,
} from "@workspace/testkit";
import { allSuites } from "@workspace/testkit/suites";

/** Run all built-in suites (or a filtered subset) and return a compact summary. */
export async function runBuiltinSuites(filter?: {
  suite?: string;
  test?: string;
}): Promise<{ summary: RunSummary; full: unknown }> {
  const result = await runSuites(allSuites(), { filter });
  return { summary: summarize(result), full: result };
}

/** Smoke-test a single panel: opens, renders text, no console errors. */
export async function smokePanel(
  source: string,
  expectedText?: string | RegExp
): Promise<RunSummary> {
  const s = suite(`smoke:${source}`).test("opens cleanly", async (t) => {
    const handle = await openPanel(source);
    t.defer(() => handle.archive().then(() => undefined));
    if (expectedText) await waitForText(handle, expectedText);
    expect((await panelText(handle)).length, "rendered text").toBeGreaterThan(0);
  });
  return summarize(await runSuites(s));
}

/** Watch a set of worker/DO units while running a workload; throw on errors. */
export async function superviseUnits<T>(
  unitNames: string[],
  workload: () => Promise<T>,
  opts?: { allow?: RegExp[] }
): Promise<T> {
  const supervisor = supervise(unitNames);
  try {
    const value = await workload();
    await supervisor.assertClean(opts);
    return value;
  } finally {
    supervisor.stop();
  }
}

/** Profile a panel around a workload and return only the compact ref. */
export async function profilePanelWorkload(
  source: string,
  workload: (handle: Awaited<ReturnType<typeof openPanel>>) => Promise<void>
): Promise<ProfileRef> {
  const handle = await openPanel(source);
  try {
    return await profilePanel(handle, () => workload(handle));
  } finally {
    await handle.archive().catch(() => undefined);
  }
}

/** Browser-native interaction report with automatic CDP-page cleanup. */
export async function profilePanelInteractionWorkload(
  handle: Awaited<ReturnType<typeof openPanel>>,
  workload: Parameters<typeof profilePanelInteraction>[1]
) {
  return profilePanelInteraction(handle, workload, { label: "panel interaction" });
}

/** Profile a real panel lifecycle reload without replacing its handle. */
export async function profilePanelReloadWorkload(handle: Awaited<ReturnType<typeof openPanel>>) {
  return profilePanelReload(handle, { label: "panel reload", disableCache: true });
}

/** Exact build attribution plus a verified-cache repeat. */
export async function profileWorkspaceBuild(source: string, contextId: string) {
  return profileBuild(source, { ref: `ctx:${contextId}`, verifyCache: true });
}

/** Correlate one canonical workload with host/workerd resource movement. */
export async function profileHostWorkload<T>(workload: () => Promise<T>) {
  return profileHost(workload, { label: "userland workload" });
}

/** Current-boot semantic activation/reconciliation/build-discovery phases. */
export async function startupProfile() {
  return readStartupProfile();
}

/** One-line system overview: units + inspector targets + stored profiles. */
export async function observabilityOverview(): Promise<{
  units: Awaited<ReturnType<typeof listUnits>>;
  workerdTargets: Awaited<ReturnType<typeof listWorkerdTargets>>;
  profiles: ProfileRef[];
}> {
  const [units, workerdTargets, profiles] = await Promise.all([
    listUnits(),
    listWorkerdTargets().catch(() => []),
    listProfiles(),
  ]);
  return { units, workerdTargets, profiles };
}

export { heapSnapshot, profileWorkerd };
