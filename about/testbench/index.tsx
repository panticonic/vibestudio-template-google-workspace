/**
 * Testbench — in-system test runner, supervision and profiling UI.
 *
 * Tabs:
 *  - Suites: browse @workspace/testkit suites, run with live per-test status
 *  - History: saved runs from /.testkit/runs/ with pass/fail comparison
 *  - Profiles: artifacts from /.testkit/profiles/ with an inline flamegraph
 *
 * Also exposes RPC methods (runSuites/lastRun) so agents can drive the panel
 * itself via panelTree handles.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  Flex,
  Heading,
  ScrollArea,
  Switch,
  Tabs,
  Text,
  Theme,
} from "@radix-ui/themes";
import { PlayIcon, ReloadIcon } from "@radix-ui/react-icons";
import { rpc } from "@workspace/runtime";

// Top-level `expose` was removed from @workspace/runtime; this is the same
// arg-spreading wrapper over the portable `rpc.expose`, kept local to the panel.
const expose = (method: string, handler: (...args: any[]) => unknown | Promise<unknown>) =>
  rpc.expose(method, (request) => handler(...request.args));
import { useHostCommands, usePanelTheme, usePanelThemeConfig } from "@workspace/react";
import { PanelChrome, Stack } from "@workspace/ui/layout";
import "@workspace/ui/foundation.css";
import "@workspace/ui/themes/vibestudio.css";
import {
  flameTreeFromProfile,
  listProfiles,
  listRuns,
  readProfile,
  runSuites,
  saveRun,
  summarize,
  type FlameNode,
  type ProfileRef,
  type RunSummary,
  type SavedRunRef,
  type SuiteRunResult,
  type TestCaseResult,
  type V8Profile,
} from "@workspace/testkit";
import { allSuites } from "@workspace/testkit/suites";
import { Flamegraph } from "./Flamegraph.js";
import type { TestExecutionResultV1 } from "@vibestudio/service-schemas/build";

type RunPhase = "idle" | "running" | "done";

const STATUS_COLOR: Record<TestCaseResult["status"], "green" | "red" | "orange" | "gray"> = {
  passed: "green",
  failed: "red",
  timeout: "red",
  errored: "orange",
  skipped: "gray",
};

let lastRunResult: SuiteRunResult | null = null;
type WorkspaceRunView = {
  phase: "running" | "done" | "error";
  target: string;
  suite: string;
  artifactKey: string;
  runtime: "browser" | "workerd";
  selectedFiles: string[];
  runtimeEntityId?: string;
  result?: TestExecutionResultV1;
  error?: string;
};

let lastWorkspaceRun: WorkspaceRunView | null = null;
const WORKSPACE_RUN_EVENT = "testbench:workspace-run";

function useWorkspaceRun(): WorkspaceRunView | null {
  const [run, setRun] = useState(lastWorkspaceRun);
  useEffect(() => {
    const update = (event: Event) => setRun((event as CustomEvent<WorkspaceRunView>).detail);
    window.addEventListener(WORKSPACE_RUN_EVENT, update);
    return () => window.removeEventListener(WORKSPACE_RUN_EVENT, update);
  }, []);
  return run;
}

function WorkspaceRunCard() {
  const run = useWorkspaceRun();
  if (!run) return null;
  if (run.phase === "running") {
    return (
      <Callout.Root color="blue" size="1">
        <Callout.Text>
          Running workspace suite {run.target} › {run.suite}…
        </Callout.Text>
      </Callout.Root>
    );
  }
  if (run.phase === "error") {
    return (
      <Callout.Root color="red" size="1" role="alert">
        <Callout.Text>{run.error}</Callout.Text>
      </Callout.Root>
    );
  }
  const result = run.result!;
  return (
    <Callout.Root color={result.status === "passed" ? "green" : "red"} size="1">
      <Callout.Text>
        {run.target} › {run.suite}: {result.passed} passed · {result.failed} failed ·{" "}
        {result.skipped} skipped · {Math.round(result.durationMs)}ms
      </Callout.Text>
    </Callout.Root>
  );
}

function WorkspaceTab() {
  const run = useWorkspaceRun();
  if (!run) {
    return (
      <Text size="2" color="gray">
        Run a declared panel or worker suite with Verify to inspect its results here.
      </Text>
    );
  }
  return (
    <Stack gap="3">
      <WorkspaceRunCard />
      <Card size="1">
        <Flex direction="column" gap="1">
          <Text size="2" weight="bold">{run.target} › {run.suite}</Text>
          <Text size="1" color="gray">
            Complete {run.runtime === "browser" ? "panel" : "worker"} runtime · artifact{" "}
            <Code>{run.artifactKey.slice(0, 16)}</Code>
          </Text>
        </Flex>
      </Card>
      {run.runtimeEntityId ? (
        <Text size="1" color="gray">
          Runtime <Code>{run.runtimeEntityId}</Code>
          {run.runtime === "browser" ? " is a visible child panel of Testbench." : " ran in workerd."}
        </Text>
      ) : null}
      {run.phase === "done" ? (
        <Flex direction="column" gap="2">
          {run.result!.files.map((file) => (
            <Card key={file.file} size="1">
              <Flex justify="between" align="center" gap="2">
                <Text size="2" truncate>{file.file}</Text>
                <Badge color={file.status === "pass" ? "green" : file.status === "fail" ? "red" : "gray"}>
                  {file.status}
                </Badge>
              </Flex>
              {file.duration !== undefined ? (
                <Text size="1" color="gray" as="div">{Math.round(file.duration)}ms</Text>
              ) : null}
              {file.errors?.map((error, index) => (
                <Callout.Root key={index} color="red" size="1" mt="2">
                  <Callout.Text style={{ whiteSpace: "pre-wrap", fontFamily: "monospace" }}>
                    {error}
                  </Callout.Text>
                </Callout.Root>
              ))}
            </Card>
          ))}
        </Flex>
      ) : (
        <Text size="2" color="gray">
          {run.selectedFiles.length} file{run.selectedFiles.length === 1 ? "" : "s"} selected.
        </Text>
      )}
    </Stack>
  );
}

function TestRow({ result }: { result: TestCaseResult }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(result.error) || result.logs.length > 0 || result.supervision;
  return (
    <Card
      size="1"
      style={{ cursor: hasDetail ? "pointer" : "default" }}
      onClick={() => setOpen(!open)}
    >
      <Flex justify="between" align="center" gap="2">
        <Text size="2" truncate>
          {result.suite} › {result.name}
        </Text>
        <Flex gap="2" align="center" flexShrink="0">
          <Text size="1" color="gray">
            {result.durationMs}ms
          </Text>
          <Badge color={STATUS_COLOR[result.status]}>{result.status}</Badge>
        </Flex>
      </Flex>
      {open && hasDetail && (
        <Box mt="2">
          {result.error && (
            <Callout.Root color="red" size="1">
              <Callout.Text style={{ whiteSpace: "pre-wrap", fontFamily: "monospace" }}>
                {result.error.message}
              </Callout.Text>
            </Callout.Root>
          )}
          {result.logs.length > 0 && (
            <Code size="1" style={{ display: "block", whiteSpace: "pre-wrap", marginTop: 6 }}>
              {result.logs.join("\n")}
            </Code>
          )}
          {result.supervision && result.supervision.findings.length > 0 && (
            <Box mt="2">
              <Text size="1" weight="bold">
                Supervision findings
              </Text>
              {result.supervision.findings.slice(0, 10).map((finding, index) => (
                <Text
                  key={index}
                  size="1"
                  as="div"
                  color={finding.kind === "console-warn" ? "orange" : "red"}
                >
                  [{finding.kind}] {finding.target}: {finding.message.slice(0, 200)}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )}
    </Card>
  );
}

function SuitesTab({ runAllNonce = 0 }: { runAllNonce?: number }) {
  const suites = useMemo(() => allSuites(), []);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(suites.map((s) => s.name)));
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [results, setResults] = useState<TestCaseResult[]>([]);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setPhase("running");
    setResults([]);
    setSummary(null);
    setRunError(null);
    const chosen = suites.filter((s) => selected.has(s.name));
    try {
      const result = await runSuites(chosen, {
        onTestEnd: (r) => setResults((prev) => [...prev, r]),
      });
      lastRunResult = result;
      setSummary(summarize(result));
      await saveRun(result, { label: "testbench" }).catch(() => undefined);
    } catch (err) {
      setRunError(`Test run failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPhase("done");
    }
  }, [suites, selected]);

  useEffect(() => {
    if (runAllNonce === 0) return;
    setSelected(new Set(suites.map((suite) => suite.name)));
    void (async () => {
      setPhase("running");
      setResults([]);
      setSummary(null);
      setRunError(null);
      try {
        const result = await runSuites(suites, {
          onTestEnd: (item) => setResults((prev) => [...prev, item]),
        });
        lastRunResult = result;
        setSummary(summarize(result));
        await saveRun(result, { label: "palette" }).catch(() => undefined);
      } catch (err) {
        setRunError(`Test run failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setPhase("done");
      }
    })();
  }, [runAllNonce, suites]);

  return (
    <Stack gap="3">
      <WorkspaceRunCard />
      <Card>
        <Flex direction="column" gap="2">
          {suites.map((s) => (
            <Flex key={s.name} align="center" gap="2">
              <Switch
                size="1"
                checked={selected.has(s.name)}
                onCheckedChange={(checked) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (checked) next.add(s.name);
                    else next.delete(s.name);
                    return next;
                  })
                }
              />
              <Text size="2">{s.name}</Text>
              <Text size="1" color="gray">
                {s.tests.length} tests
              </Text>
            </Flex>
          ))}
          <Button onClick={() => void run()} disabled={phase === "running" || selected.size === 0}>
            <PlayIcon /> {phase === "running" ? "Running…" : "Run selected"}
          </Button>
        </Flex>
      </Card>
      {summary && (
        <Callout.Root color={summary.failed + summary.errored > 0 ? "red" : "green"} size="1">
          <Callout.Text>
            {summary.passed}/{summary.total} passed · {summary.failed} failed · {summary.errored}{" "}
            errored · {summary.skipped} skipped · {(summary.duration / 1000).toFixed(1)}s
          </Callout.Text>
        </Callout.Root>
      )}
      {runError ? (
        <Callout.Root color="red" size="1" role="alert">
          <Callout.Text>{runError}</Callout.Text>
        </Callout.Root>
      ) : null}
      <Flex direction="column" gap="1">
        {results.map((r, index) => (
          <TestRow key={`${r.suite}-${r.name}-${index}`} result={r} />
        ))}
      </Flex>
    </Stack>
  );
}

function HistoryTab() {
  const [runs, setRuns] = useState<SavedRunRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    void listRuns()
      .then(setRuns)
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(refresh, [refresh]);
  return (
    <Stack gap="2">
      <Button variant="soft" onClick={refresh}>
        <ReloadIcon /> Refresh
      </Button>
      {loadError ? (
        <Callout.Root color="red" size="1" role="alert">
          <Callout.Text>Couldn't load saved runs: {loadError}</Callout.Text>
        </Callout.Root>
      ) : null}
      {!loading && !loadError && runs.length === 0 && (
        <Text size="2" color="gray">
          No saved runs yet.
        </Text>
      )}
      {runs.map((run) => (
        <Card key={run.path} size="1">
          <Flex justify="between" align="center">
            <Text size="2">
              {new Date(run.savedAt).toLocaleString()} {run.label ? `· ${run.label}` : ""}
            </Text>
            <Badge color={run.summary.failed + run.summary.errored > 0 ? "red" : "green"}>
              {run.summary.passed}/{run.summary.total}
            </Badge>
          </Flex>
          {run.summary.failures.length > 0 && (
            <Box mt="1">
              {run.summary.failures.map((failure, index) => (
                <Text key={index} size="1" as="div" color="red" truncate>
                  {failure.suite} › {failure.name}: {failure.error ?? failure.status}
                </Text>
              ))}
            </Box>
          )}
        </Card>
      ))}
    </Stack>
  );
}

function ProfilesTab() {
  const [profiles, setProfiles] = useState<ProfileRef[]>([]);
  const [flame, setFlame] = useState<{ ref: ProfileRef; root: FlameNode } | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    setLoading(true);
    setProfileError(null);
    void listProfiles()
      .then(setProfiles)
      .catch((err) => setProfileError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(refresh, [refresh]);

  const openProfile = useCallback(async (ref: ProfileRef) => {
    if (ref.kind !== "cpuprofile") return;
    setProfileError(null);
    try {
      const raw = await readProfile(ref.path);
      setFlame({ ref, root: flameTreeFromProfile(JSON.parse(raw) as V8Profile) });
    } catch (err) {
      setProfileError(
        `Couldn't open this profile: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, []);

  return (
    <Stack gap="2">
      <Button variant="soft" onClick={refresh}>
        <ReloadIcon /> Refresh
      </Button>
      {profileError ? (
        <Callout.Root color="red" size="1" role="alert">
          <Callout.Text>{profileError}</Callout.Text>
        </Callout.Root>
      ) : null}
      {!loading && !profileError && profiles.length === 0 && (
        <Text size="2" color="gray">
          No profiles yet. Capture one with profilePanel()/profileWorkerd() from eval.
        </Text>
      )}
      {profiles.map((ref) => (
        <Card
          key={ref.path}
          size="1"
          style={{ cursor: ref.kind === "cpuprofile" ? "pointer" : "default" }}
          onClick={() => void openProfile(ref)}
        >
          <Flex justify="between" align="center">
            <Text size="2" truncate>
              {ref.target}
            </Text>
            <Flex gap="2" align="center" flexShrink="0">
              <Text size="1" color="gray">
                {new Date(ref.startedAt).toLocaleTimeString()} · {ref.durationMs}ms
                {ref.summary.sizeBytes ? ` · ${Math.round(ref.summary.sizeBytes / 1024)}KB` : ""}
              </Text>
              <Badge>{ref.kind}</Badge>
            </Flex>
          </Flex>
          {ref.summary.topFunctions && ref.summary.topFunctions.length > 0 && (
            <Text size="1" color="gray" as="div">
              top: {ref.summary.topFunctions.map((fn) => `${fn.name} ${fn.selfMs}ms`).join(", ")}
            </Text>
          )}
          {ref.kind !== "cpuprofile" ? (
            <Flex direction="column" gap="1">
              <Text size="1" color="gray" as="div">
                Open this artifact in DevTools or speedscope; inline viewing is available for CPU
                profiles.
              </Text>
              <Text size="1" color="gray" as="div">
                Artifact: <Code>{ref.path}</Code>
              </Text>
            </Flex>
          ) : null}
        </Card>
      ))}
      {flame && (
        <Card>
          <Heading size="2" mb="2">
            {flame.ref.target} — {flame.ref.durationMs}ms
          </Heading>
          <Text size="1" color="gray" as="div" mb="2">
            Artifact at <Code>{flame.ref.path}</Code> (speedscope/DevTools-compatible)
          </Text>
          <Flamegraph root={flame.root} />
        </Card>
      )}
    </Stack>
  );
}

function App() {
  const theme = usePanelTheme();
  const appTheme = usePanelThemeConfig();
  const [activeTab, setActiveTab] = useState("suites");
  const [runAllNonce, setRunAllNonce] = useState(0);

  // Contribute testbench actions to the app command palette (Cmd/Ctrl+K).
  // Controlled tabs make tab-switching reachable; "Run all" mirrors the RPC
  // path and jumps to History, which refetches on mount so the run shows up.
  const hostCommands = useMemo(
    () => [
      { id: "tb-suites", label: "Show test suites", group: "Testbench" },
      { id: "tb-history", label: "Show run history", group: "Testbench" },
      { id: "tb-profiles", label: "Show profiles", group: "Testbench" },
      { id: "tb-run-all", label: "Run all test suites", group: "Testbench" },
    ],
    []
  );
  useHostCommands(hostCommands, (id) => {
    if (id === "tb-suites") setActiveTab("suites");
    else if (id === "tb-history") setActiveTab("history");
    else if (id === "tb-profiles") setActiveTab("profiles");
    else if (id === "tb-run-all") {
      setActiveTab("suites");
      setRunAllNonce((value) => value + 1);
    }
  });
  useEffect(() => {
    const showWorkspaceRun = () => setActiveTab("workspace");
    window.addEventListener(WORKSPACE_RUN_EVENT, showWorkspaceRun);
    return () => window.removeEventListener(WORKSPACE_RUN_EVENT, showWorkspaceRun);
  }, []);

  return (
    <Theme appearance={theme} {...appTheme}>
      <Box style={{ height: "100dvh", boxSizing: "border-box", background: "var(--surface-panel)" }}>
        <PanelChrome
          header={
            <Heading size="4" truncate>
              Testbench
            </Heading>
          }
        >
          <Tabs.Root
            value={activeTab}
            onValueChange={setActiveTab}
            style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
          >
            <Tabs.List style={{ paddingInline: "var(--space-3)", flexShrink: 0 }}>
              <Tabs.Trigger value="suites">Suites</Tabs.Trigger>
              <Tabs.Trigger value="workspace">Workspace</Tabs.Trigger>
              <Tabs.Trigger value="history">History</Tabs.Trigger>
              <Tabs.Trigger value="profiles">Profiles</Tabs.Trigger>
            </Tabs.List>
            <ScrollArea style={{ flex: 1, minHeight: 0 }}>
              <Box p="3">
                <Tabs.Content value="suites">
                  <SuitesTab runAllNonce={runAllNonce} />
                </Tabs.Content>
                <Tabs.Content value="history">
                  <HistoryTab />
                </Tabs.Content>
                <Tabs.Content value="workspace">
                  <WorkspaceTab />
                </Tabs.Content>
                <Tabs.Content value="profiles">
                  <ProfilesTab />
                </Tabs.Content>
              </Box>
            </ScrollArea>
          </Tabs.Root>
        </PanelChrome>
      </Box>
    </Theme>
  );
}

// Agent-facing RPC surface: drive the testbench via panel handles.
expose("runSuites", async (filter?: { suite?: string; test?: string }) => {
  const result = await runSuites(allSuites(), { filter });
  lastRunResult = result;
  await saveRun(result, { label: "rpc" }).catch(() => undefined);
  return summarize(result);
});
expose("lastRun", () => (lastRunResult ? summarize(lastRunResult) : null));
expose("tests.record", (run: WorkspaceRunView) => {
  lastWorkspaceRun = run;
  window.dispatchEvent(new CustomEvent(WORKSPACE_RUN_EVENT, { detail: run }));
});

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
