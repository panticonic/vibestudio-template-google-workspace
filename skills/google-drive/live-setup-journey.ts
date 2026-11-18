import { buildPanelLink, type PanelHandle } from "@workspace/runtime";
import { audit, evalInPanel, setViewport, waitFor } from "@workspace/testkit";
import { createGoogleWorkspaceRead } from "./drive-workflow-binding.js";
import type {
  GoogleReadiness,
  GoogleSetupFinding,
  GoogleSetupJourneyRequest,
  GoogleSetupReceipt,
  GoogleWorkflowReport,
} from "./driveWorkflow/types.js";

type LaunchView = {
  accountLink: string | null;
  permissionsLink: string | null;
  gmailEnabled: boolean;
  stage: "needs-setup" | "needs-consent" | "other";
};
type SetupWorld = {
  id: string;
  goal: string;
  checks: GoogleSetupJourneyRequest["checks"];
  codes: GoogleSetupFinding["code"][];
};

const readSetup = `(() => {
  const text = document.body.innerText;
  if (!text.includes("Your Gmail assistant") || text.includes("Checking your Google connection…")) return null;
  const links = Array.from(document.querySelectorAll("a"));
  const route = (label) => links.find(a => a.textContent.trim() === label)?.getAttribute("href") ?? null;
  const launch = Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "Open Gmail");
  const gmail = route("Open Gmail");
  if (!gmail && (!launch || !launch.disabled)) return null;
  return {
    accountLink: route("Manage connected accounts"),
    permissionsLink: route("Review saved permissions"),
    gmailEnabled: Boolean(gmail),
    stage: text.includes("Google Cloud setup needed") ? "needs-setup" : text.includes("App details saved") ? "needs-consent" : "other",
  };
})()`;

export function prepareGoogleSetupJourney(
  panel: PanelHandle,
  contextId: string,
  world: SetupWorld,
) {
  const { checks, goal } = world;
  const request: GoogleSetupJourneyRequest = {
    kind: "setup-journey",
    goal,
    checks,
  };
  const drive = createGoogleWorkspaceRead({});
  const receipts: GoogleSetupReceipt[] = [];
  let readiness: GoogleReadiness | undefined;
  let opened = false;

  async function readPanel() {
    return await waitFor(
      async () =>
        (await evalInPanel<LaunchView | null>(panel, readSetup)) ?? undefined,
      { label: "Google setup and Gmail gate settle" },
    );
  }

  async function readReadiness() {
    if (readiness) throw new Error("Read the assigned Google readiness once");
    readiness = await drive.readiness();
    return readiness;
  }

  async function observe() {
    if (opened) throw new Error("Read the assigned Google panel once");
    if (!readiness) throw new Error("Observe Google account readiness first");
    opened = true;
    const account = buildPanelLink("about/credentials", {
      workspace: { role: "personal" },
    });
    const permission = buildPanelLink("about/permissions", {
      workspace: { role: "system" },
    });
    for (const [index, check] of checks.entries()) {
      let inheritedLaunch: boolean | null = null;
      if (check.kind === "viewport") {
        await setViewport(panel, { width: check.width, height: 844 });
      } else if (check.kind === "launch-gate" && check.afterReload) {
        inheritedLaunch = (await readPanel()).gmailEnabled;
        await panel.reload();
      }
      const view = await readPanel();
      const layout = check.kind === "viewport" ? await audit(panel) : null;
      receipts.push({
        id: `${contextId}:google-setup:${index + 1}`,
        check,
        stage: view.stage,
        accountOwner: view.accountLink === account,
        permissionsOwner: view.permissionsLink === permission,
        gmailEnabled: view.gmailEnabled,
        inheritedLaunch,
        overflow: layout?.horizontalOverflow ?? false,
        viewportWidth: layout?.viewport.width ?? null,
      });
    }
    return structuredClone(receipts);
  }

  function reference(): GoogleWorkflowReport {
    return {
      status: "action-needed",
      action: "open-setup",
      ids: [],
      findings: ["The Google Cloud Desktop app still needs setup."],
      checkpoint: null,
      panelFindings: receipts.map(({ id, check }, index) => ({
        check,
        code: world.codes[index]!,
        evidenceId: id,
      })),
    };
  }

  function verify(report: GoogleWorkflowReport | null) {
    const expected = reference();
    const matched = {
      driveNeedsSetup: readiness?.state === "needs-setup",
      browserAgrees:
        receipts.length === checks.length &&
        receipts.every((row) => {
          if (row.stage !== readiness?.state || row.gmailEnabled) return false;
          switch (row.check.kind) {
            case "owners":
              return row.accountOwner && row.permissionsOwner;
            case "launch-gate":
              return (
                row.inheritedLaunch === (row.check.afterReload ? false : null)
              );
            case "viewport":
              return row.viewportWidth === row.check.width && !row.overflow;
          }
        }),
      reportMatches:
        report?.status === expected.status &&
        report.action === expected.action &&
        report.ids?.length === 0 &&
        report.checkpoint === null &&
        report.panelFindings?.length === checks.length &&
        expected.panelFindings?.every((row, index) => {
          const result = report.panelFindings?.[index];
          return (
            result?.code === row.code &&
            result.evidenceId === row.evidenceId &&
            JSON.stringify(result.check) === JSON.stringify(row.check)
          );
        }) === true,
    };
    return {
      caseId: world.id,
      contextId,
      panelId: panel.id,
      readiness,
      receipts,
      checks: matched,
      passed: Object.values(matched).every(Boolean),
    };
  }

  return {
    request,
    reference,
    verify,
    services: {
      googleWorkspaceRead: { ...drive, readiness: readReadiness },
      googleSetupPanel: { observe },
    },
  };
}
