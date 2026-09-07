/**
 * Supervisor — watch panels, workers/DOs and ad-hoc health probes during a
 * test (or any eval block) and collect a compact report of what went wrong.
 *
 * Panels and units are sampled at collect() time against their existing
 * server-side history buffers (panel console history, RuntimeDiagnosticsStore),
 * filtered to the watch window — deterministic and poll-free. Health probes
 * run on an interval until stop().
 */
import type { PanelHandle } from "@workspace/runtime";
import { TestAssertionError } from "./expect.js";

// Lazy: keeps run.ts/supervise.ts importable outside a live runtime (vitest).
async function getRuntime() {
  const runtime = await import("@workspace/runtime");
  return runtime.runtime;
}

export interface SupervisionFinding {
  target: string;
  kind: "console-error" | "console-warn" | "lifecycle" | "unit-error" | "probe-failed";
  message: string;
  timestamp: number;
}

export interface SupervisionReport {
  findings: SupervisionFinding[];
  errors: number;
  warnings: number;
  watched: { panels: string[]; units: string[]; probes: string[] };
}

interface PanelWatch {
  handle: PanelHandle;
  since: number;
  levels: Set<"error" | "warn">;
}

interface UnitWatch {
  name: string;
  since: number;
  levels: Set<"error" | "warn">;
}

interface ProbeWatch {
  name: string;
  failures: SupervisionFinding[];
  timer: ReturnType<typeof setInterval>;
}

const WARN_KIND = new Set(["console-warn"]);

export class Supervisor {
  private readonly panels = new Map<string, PanelWatch>();
  private readonly archivedPanelFindings: SupervisionFinding[] = [];
  private readonly units = new Map<string, UnitWatch>();
  private readonly probes: ProbeWatch[] = [];
  private stopped = false;

  /** Watch a panel's console + lifecycle records from now on. */
  watchPanel(handle: PanelHandle, opts?: { levels?: ("error" | "warn")[] }): void {
    if (this.panels.has(handle.id)) return;
    this.panels.set(handle.id, {
      handle,
      since: Date.now(),
      levels: new Set(opts?.levels ?? ["error"]),
    });
  }

  unwatchPanel(panelId: string): void {
    this.panels.delete(panelId);
  }

  /** Capture a test-owned panel's diagnostics before its lifecycle helper
   * closes it, then retain those findings for the final suite report. */
  async capturePanel(panelId: string): Promise<void> {
    const watch = this.panels.get(panelId);
    if (!watch) return;
    this.archivedPanelFindings.push(...(await this.collectPanel(watch)));
    this.panels.delete(panelId);
  }

  /** Watch a worker/DO unit's diagnostics from now on. */
  watchUnit(name: string, opts?: { levels?: ("error" | "warn")[] }): void {
    if (this.units.has(name)) return;
    this.units.set(name, {
      name,
      since: Date.now(),
      levels: new Set(opts?.levels ?? ["error"]),
    });
  }

  /** Run `fn` on an interval; a false return or a throw records a finding. */
  healthProbe(
    name: string,
    fn: () => Promise<boolean> | boolean,
    opts?: { intervalMs?: number }
  ): void {
    const failures: SupervisionFinding[] = [];
    const timer = setInterval(
      () => {
        void (async () => {
          try {
            if (!(await fn())) {
              failures.push({
                target: name,
                kind: "probe-failed",
                message: `health probe "${name}" returned false`,
                timestamp: Date.now(),
              });
            }
          } catch (error) {
            failures.push({
              target: name,
              kind: "probe-failed",
              message: `health probe "${name}" threw: ${error instanceof Error ? error.message : String(error)}`,
              timestamp: Date.now(),
            });
          }
        })();
      },
      opts?.intervalMs ?? 1000
    );
    this.probes.push({ name, failures, timer });
  }

  /** Sample all watched targets and return everything observed in the window. */
  async collect(): Promise<SupervisionReport> {
    const findings: SupervisionFinding[] = [...this.archivedPanelFindings];

    for (const watch of this.panels.values()) {
      findings.push(...(await this.collectPanel(watch)));
    }

    for (const watch of this.units.values()) {
      try {
        const runtime = await getRuntime();
        const matches = (await runtime.supervision.list()).filter(
          (unit) => unit.identity.entityId === watch.name || unit.source === watch.name
        );
        if (matches.length !== 1) {
          throw new Error(`Expected one running executable entity for ${watch.name}`);
        }
        const diagnostics = await runtime.supervision.health(matches[0]!.identity, {
          since: watch.since,
        });
        const records = [...diagnostics.errors];
        if (watch.levels.has("warn")) {
          records.push(...diagnostics.logs.filter((record) => record.level === "warn"));
        }
        for (const record of records) {
          if (record.timestamp < watch.since) continue;
          findings.push({
            target: watch.name,
            kind: record.level === "warn" ? "console-warn" : "unit-error",
            message: record.message,
            timestamp: record.timestamp,
          });
        }
      } catch (error) {
        findings.push({
          target: watch.name,
          kind: "unit-error",
          message: `unit diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: Date.now(),
        });
      }
    }

    for (const probe of this.probes) findings.push(...probe.failures);

    // Deduplicate identical messages per target (e.g. repeated console spam).
    const seen = new Set<string>();
    const unique = findings.filter((finding) => {
      const key = `${finding.target}\\0${finding.kind}\\0${finding.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    unique.sort((a, b) => a.timestamp - b.timestamp);

    return {
      findings: unique,
      errors: unique.filter((finding) => !WARN_KIND.has(finding.kind)).length,
      warnings: unique.filter((finding) => WARN_KIND.has(finding.kind)).length,
      watched: {
        panels: [...this.panels.keys()],
        units: [...this.units.keys()],
        probes: this.probes.map((probe) => probe.name),
      },
    };
  }

  private async collectPanel(watch: PanelWatch): Promise<SupervisionFinding[]> {
    const findings: SupervisionFinding[] = [];
    try {
      const history = await watch.handle.cdp.consoleHistory();
      for (const entry of [...history.entries, ...history.errors]) {
        if (entry.timestamp < watch.since) continue;
        if (entry.source === "lifecycle") {
          findings.push({
            target: watch.handle.id,
            kind: "lifecycle",
            message: entry.message,
            timestamp: entry.timestamp,
          });
        } else if (entry.level === "error" && watch.levels.has("error")) {
          findings.push({
            target: watch.handle.id,
            kind: "console-error",
            message: entry.message,
            timestamp: entry.timestamp,
          });
        } else if (entry.level === "warning" && watch.levels.has("warn")) {
          findings.push({
            target: watch.handle.id,
            kind: "console-warn",
            message: entry.message,
            timestamp: entry.timestamp,
          });
        }
      }
    } catch (error) {
      findings.push({
        target: watch.handle.id,
        kind: "lifecycle",
        message: `console history unavailable: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: Date.now(),
      });
    }
    return findings;
  }

  /** Throw a serializable assertion error if any error-level finding exists. */
  async assertClean(opts?: { allow?: RegExp[] }): Promise<SupervisionReport> {
    const report = await this.collect();
    const blocking = report.findings.filter(
      (finding) =>
        !WARN_KIND.has(finding.kind) &&
        !(opts?.allow ?? []).some((pattern) => pattern.test(finding.message))
    );
    if (blocking.length > 0) {
      const evidence = blocking
        .slice(0, 5)
        .map((finding) => `[${finding.kind}] ${finding.target}: ${finding.message.slice(0, 200)}`)
        .join("\n");
      throw new TestAssertionError(
        `supervision found ${blocking.length} error finding(s):\n${evidence}`,
        { actual: blocking.slice(0, 5) }
      );
    }
    return report;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const probe of this.probes) clearInterval(probe.timer);
  }
}

/** One-liner: watch a mix of panel handles and unit names. */
export function supervise(targets: Array<PanelHandle | string>): Supervisor {
  const supervisor = new Supervisor();
  for (const target of targets) {
    if (typeof target === "string") supervisor.watchUnit(target);
    else supervisor.watchPanel(target);
  }
  return supervisor;
}
