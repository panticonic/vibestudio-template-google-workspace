import { buildPanelLink, type PanelHandle } from "@workspace/runtime";
import { audit, evalInPanel, setViewport, waitFor } from "@workspace/testkit";
import { createGoogleWorkspaceRead } from "./drive-workflow-binding.js";
import type {
  GoogleReadiness,
  GoogleSetupCheck,
  GoogleSetupControls,
  GoogleSetupFinding,
  GoogleSetupJourneyRequest,
  GoogleSetupReceipt,
  GoogleWorkflowReport,
} from "./driveWorkflow/types.js";

export type GoogleWelcomeView = {
  accountLink: string | null;
  permissionsLink: string | null;
  gmailEnabled: boolean;
  gmailLink: string | null;
  scope: "gmail" | "workspace" | null;
  opening: "here" | "external" | null;
  accountActions: string[];
  marker:
    | "unconfigured"
    | "configured"
    | "unverified"
    | "coverage-gap"
    | "connected"
    | "attention"
    | "unavailable";
  warning: boolean;
  controls: GoogleSetupControls | null;
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
  const buttons = Array.from(document.querySelectorAll("button"));
  const button = (label) => buttons.find(b => b.textContent.trim() === label);
  const launch = button("Open Gmail");
  const gmail = route("Open Gmail");
  if (!gmail && (!launch || !launch.disabled)) return null;
  const scopeLabel = document.querySelector("#google-workflow")?.textContent?.trim();
  const scope = scopeLabel === "Gmail" ? "gmail" : scopeLabel === "All Workspace apps" ? "workspace" : null;
  const opening = button("Here")?.getAttribute("aria-pressed") === "true" ? "here"
    : button("My browser")?.getAttribute("aria-pressed") === "true" ? "external" : null;
  const guidance = text.includes("Enable the Gmail API. You can enable other APIs later.") ? "gmail"
    : text.includes("Turn on Gmail, Calendar, Drive, Docs, Sheets, Slides, and People.") ? "workspace" : "unknown";
  const connect = button("Connect Google");
  return {
    controls: scope && opening && connect
      ? { scope, opening, guidance, connectEnabled: !connect.disabled, gmailEnabled: Boolean(gmail) }
      : null,
    accountLink: route("Manage connected accounts"),
    permissionsLink: route("Review saved permissions"),
    gmailEnabled: Boolean(gmail),
    gmailLink: gmail,
    scope,
    opening,
    accountActions: ["Save Desktop app details","Change Desktop app details","Connect Google","Check connection","Verify connection"]
      .filter(name => button(name) && !button(name).disabled),
    marker: text.includes("Google Cloud setup needed") ? "unconfigured"
      : text.includes("App details saved") ? "configured"
      : text.includes("Connected, verification needed") ? "unverified"
      : text.includes("More permissions needed") ? "coverage-gap"
      : links.some(link => link.textContent.trim() === "Open Gmail") || text.includes("Connected as ") ? "connected"
      : text.includes("Needs attention") ? "attention" : "unavailable",
    warning: Boolean(document.querySelector('[role="alert"]')) ||
      ["no stored refresh token", "last consent attempt was declined"].some(message => text.includes(message)),
    stage: text.includes("Google Cloud setup needed") ? "needs-setup" : text.includes("App details saved") ? "needs-consent" : "other",
  };
})()`;

export function readGoogleWelcome(
  panel: PanelHandle,
): Promise<GoogleWelcomeView> {
  return waitFor(
    async () =>
      (await evalInPanel<GoogleWelcomeView | null>(panel, readSetup)) ??
      undefined,
    { label: "Google setup and Gmail gate settle" },
  );
}

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

  const readPanel = () => readGoogleWelcome(panel);

  async function readReadiness() {
    if (readiness) throw new Error("Read the assigned Google readiness once");
    readiness = await drive.readiness();
    return readiness;
  }

  async function observeChoice(
    check: Extract<
      GoogleSetupCheck,
      { kind: "scope-choice" | "browser-choice" | "choice-reload" }
    >,
  ) {
    const { controls: before } = await readPanel();
    if (!before) throw new Error("Google setup controls are unavailable");
    if (check.kind === "choice-reload") {
      await panel.reload();
    } else if (
      check.kind === "scope-choice"
        ? before.scope !== check.scope
        : before.opening !== check.opening
    ) {
      const session = await panel.cdp.session();
      try {
        if (check.kind === "scope-choice") {
          await session.page.locator("#google-workflow").click();
          await session.page
            .getByRole("option", {
              name: check.scope === "gmail" ? "Gmail" : "All Workspace apps",
              exact: true,
            })
            .click();
        } else {
          await session.page
            .getByRole("button", {
              name: check.opening === "here" ? "Here" : "My browser",
              exact: true,
            })
            .click();
        }
      } finally {
        await session.close();
      }
    }
    const view = await readPanel();
    if (!view.controls)
      throw new Error("Google setup choices could not be read back");
    return { view, controls: { before, after: view.controls } };
  }

  function matchesChoices(
    row: GoogleSetupReceipt,
    previous: GoogleSetupControls | undefined,
  ) {
    const { controls, check } = row;
    if (!controls) return false;
    const { before, after } = controls;
    if (
      before.scope !== (previous?.scope ?? "gmail") ||
      before.opening !== (previous?.opening ?? "external")
    )
      return false;
    if (
      [before, after].some(
        (value) =>
          value.connectEnabled ||
          value.gmailEnabled ||
          value.guidance !== value.scope,
      )
    )
      return false;
    switch (check.kind) {
      case "scope-choice":
        return after.scope === check.scope && after.opening === before.opening;
      case "browser-choice":
        return after.opening === check.opening && after.scope === before.scope;
      case "choice-reload":
        return after.scope === "gmail" && after.opening === "external";
      default:
        return false;
    }
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
      const choice =
        check.kind === "scope-choice" ||
        check.kind === "browser-choice" ||
        check.kind === "choice-reload"
          ? await observeChoice(check)
          : null;
      const view = choice?.view ?? (await readPanel());
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
        ...(choice ? { controls: choice.controls } : {}),
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
        receipts.every((row, index) => {
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
            default:
              return matchesChoices(
                row,
                receipts
                  .slice(0, index)
                  .reverse()
                  .find(
                    (receipt) =>
                      receipt.controls ||
                      (receipt.check.kind === "launch-gate" &&
                        receipt.check.afterReload),
                  )?.controls?.after,
              );
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
