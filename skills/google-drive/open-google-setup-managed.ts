import { isDeepStrictEqual } from "node:util";
import { buildPanelLink, type PanelHandle } from "@workspace/runtime";
import { gmailChatStateArgs } from "@workspace/gmail/chat-state";
import { audit, evalInPanel, setViewport, waitFor } from "@workspace/testkit";
import { readGoogleWelcome } from "./live-setup-journey.js";
import {
  setupCredentialId,
  type OwnedSetupProfile,
} from "./open-setup-profile.js";
import type {
  OpenGoogleSetupReport,
  SetupAction,
  SetupCheckpoint,
  SetupDecision,
  SetupHandoff,
  SetupObservation,
  SetupRoute,
  SetupScope,
} from "./setupGoal/types.js";

export type OpenGoogleSetupWorld = {
  kind: "googleSetup";
  workspace: "google-workspace";
  id: string;
  goal: string;
  sourceGroup: string;
  split?: "test";
  profile: OwnedSetupProfile;
  next?: SetupCheckpoint;
  allowed: SetupAction["kind"][];
  expected: {
    actions: SetupAction[];
    route: SetupRoute;
    requestedScope: SetupScope;
    history: string[];
    stage: boolean;
    marker: string;
    launch: boolean;
    scope: SetupScope;
    opening: SetupObservation["opening"];
    width: number;
  };
};

type SetupSlotState = { setup: OwnedSetupProfile };
type Journal = {
  method: keyof typeof methodNames;
  args: unknown[];
  result: unknown;
};
const methodNames = { observe: true, apply: true, stage: true };
const accountLink = () =>
  buildPanelLink("about/credentials", { workspace: { role: "personal" } });
const permissionLink = () =>
  buildPanelLink("about/permissions", { workspace: { role: "system" } });

export async function prepareOpenGoogleSetup(
  panel: PanelHandle,
  contextId: string,
  source: string,
  world: OpenGoogleSetupWorld,
) {
  const original = await panel.observe();
  if (
    original.source !== source ||
    original.contextId !== contextId ||
    original.requestedRef !== `ctx:${contextId}` ||
    original.kind !== "workspace"
  )
    throw new Error("The setup view is outside the rehearsal context");

  async function ownedProfile() {
    const { setup } = await panel.stateArgs.get<SetupSlotState>();
    if (
      !setup ||
      setup.profileId !== world.profile.profileId ||
      setup.current.profileId !== setup.profileId
    )
      throw new Error("The welcome profile belongs to a different owner");
    return setup;
  }

  const baseline = await ownedProfile();
  const history = (profile: OwnedSetupProfile) =>
    profile.history.filter(({ profileId }) => profileId === profile.profileId);
  const captureHost = async () =>
    waitFor(
      async () =>
        evalInPanel<{ instance: string; profile: string } | null>(
          panel,
          `(() => {const node=document.querySelector("[data-google-setup]"); return node?.dataset.instance && node.dataset.profile ? {instance:node.dataset.instance,profile:node.dataset.profile}:null;})()`,
        ).then((value) => value ?? undefined),
      { label: "owned welcome view mounted" },
    );

  let selectedInstance: string | undefined;
  async function frame() {
    const [owned, host, dom, layout] = await Promise.all([
      ownedProfile(),
      captureHost(),
      readGoogleWelcome(panel),
      audit(panel),
    ]);
    if (host.profile !== owned.profileId || !dom.scope)
      throw new Error("The rendered setup differs from the owned profile");
    const gmail = buildPanelLink("panels/chat", {
      stateArgs: gmailChatStateArgs(
        `google-mail-${panel.id}`,
        setupCredentialId(owned.profileId),
      ),
    });
    if (dom.gmailLink && dom.gmailLink !== gmail)
      throw new Error("The Gmail launch belongs to a different profile");
    selectedInstance = host.instance;
    return {
      profile: owned.label,
      current: owned.current,
      history: history(owned),
      scope: dom.scope,
      opening: dom.opening,
      guidance: dom.controls?.guidance ?? "unknown",
      marker: dom.marker,
      warningVisible: dom.warning,
      launchEnabled: dom.gmailEnabled,
      accountOwner: dom.accountLink === accountLink(),
      permissionsOwner: dom.permissionsLink === permissionLink(),
      enabledControls: dom.accountActions,
      width: layout.viewport.width,
      overflow: layout.horizontalOverflow,
    } satisfies Omit<SetupObservation, "id">;
  }

  type Wrapper = {
    status: string;
    skill: string;
    outcome?: OpenGoogleSetupReport;
  };
  const journal: Journal[] = [];
  const record = <T>(method: Journal["method"], args: unknown[], result: T) => {
    journal.push(structuredClone({ method, args, result }));
    return structuredClone(result);
  };
  let first: SetupObservation | undefined;
  let current: SetupObservation | undefined;
  let ownerAdvanced = false;
  let working = false;

  async function observe() {
    const evidence = await frame();
    current = { ...evidence, id: crypto.randomUUID() };
    first ??= current;
    return current;
  }

  async function act(action: SetupAction) {
    switch (action.kind) {
      case "viewport":
        if (![320, 390, 1280].includes(action.width)) return false;
        await setViewport(panel, { width: action.width, height: 844 });
        return true;
      case "reload": {
        if (world.next && !ownerAdvanced) {
          const existing = await ownedProfile();
          await panel.stateArgs.patch({
            setup: {
              current: world.next,
              history: [...existing.history, existing.current],
            },
          });
          ownerAdvanced = true;
        }
        const before = selectedInstance;
        const width = current!.width;
        await panel.reload();
        await waitFor(
          async () => {
            const live = await captureHost();
            return live.instance !== before ? true : undefined;
          },
          { label: "a new welcome renderer" },
        );
        if ((await audit(panel)).viewport.width !== width) {
          await setViewport(panel, { width, height: 844 });
        }
        return true;
      }
      case "scope":
      case "browser": {
        const session = await panel.cdp.session();
        try {
          if (
            action.kind === "scope" &&
            ["gmail", "workspace"].includes(action.scope)
          ) {
            if (current?.scope !== action.scope) {
              await session.page.locator("#google-workflow").click();
              await session.page
                .getByRole("option", {
                  name:
                    action.scope === "gmail" ? "Gmail" : "All Workspace apps",
                  exact: true,
                })
                .click();
            }
            return true;
          }
          if (
            action.kind === "browser" &&
            ["here", "external"].includes(action.opening) &&
            current?.opening
          ) {
            if (current.opening !== action.opening) {
              await session.page
                .getByRole("button", {
                  name: action.opening === "here" ? "Here" : "My browser",
                  exact: true,
                })
                .click();
            }
            return true;
          }
          return false;
        } finally {
          await session.close();
        }
      }
    }
  }

  const openGoogleSetup = {
    async observe() {
      if (working)
        throw new Error("The setup renderer has an operation in progress");
      return record("observe", [], await observe());
    },
    async apply(revision: string, action: SetupAction) {
      if (
        !current ||
        revision !== current.id ||
        working ||
        !world.allowed.includes(action?.kind)
      )
        return record("apply", [revision, action], null);
      working = true;
      try {
        const { id: _id, ...basis } = current;
        if (!isDeepStrictEqual(await frame(), basis) || !(await act(action)))
          return record("apply", [revision, action], null);
        return record("apply", [revision, action], await observe());
      } finally {
        working = false;
      }
    },
    async stage(revision: string, decision: SetupDecision) {
      if (
        !current ||
        revision !== current.id ||
        working ||
        decision?.currentId !== current.current.id ||
        decision.launchEnabled !== current.launchEnabled ||
        !decision.note?.trim() ||
        !Array.isArray(decision.priorIds) ||
        new Set(decision.priorIds).size !== decision.priorIds.length ||
        !decision.priorIds.every((id) =>
          current!.history.some((row) => row.id === id),
        )
      ) {
        return record("stage", [revision, decision], null);
      }
      working = true;
      try {
        const { id: _id, ...basis } = current;
        const profile = await ownedProfile();
        if (!isDeepStrictEqual(await frame(), basis) || profile.handoff)
          return record("stage", [revision, decision], null);
        const handoff: SetupHandoff = { decision, observation: revision };
        await panel.stateArgs.patch({ setup: { handoff } });
        const saved = (await ownedProfile()).handoff;
        return record(
          "stage",
          [revision, decision],
          isDeepStrictEqual(saved, handoff) ? saved! : null,
        );
      } finally {
        working = false;
      }
    },
  };

  async function verify(wrapper: Wrapper | null) {
    const report =
      wrapper?.status === "workspace-skill-reviewed" &&
      wrapper.skill === world.kind
        ? wrapper.outcome
        : null;
    const expected = world.expected;
    const fresh = await frame();
    const owned = await ownedProfile();
    const { id, ...basis } = current ?? {};
    const { handoff, ...final } = owned;
    const actions = journal
      .filter(({ method, result }) => method === "apply" && result)
      .map(({ args }) => args[1]);
    const expectedProfile =
      expected.actions.some(({ kind }) => kind === "reload") && world.next
        ? {
            ...baseline,
            current: world.next,
            history: [...baseline.history, baseline.current],
          }
        : baseline;
    const expectedHistory = expected.history;
    const hasSetupGuide = expected.opening !== null;
    const controlNames = {
      unconfigured: ["Save Desktop app details"],
      configured: ["Change Desktop app details", "Connect Google"],
      unverified: ["Change Desktop app details", "Verify connection"],
      "coverage-gap": ["Change Desktop app details"],
      connected: ["Check connection"],
      attention: ["Change Desktop app details"],
      unavailable: ["Save Desktop app details", "Check connection"],
    }[expected.marker];
    const warning = expectedProfile.current.warning !== "none";
    const checks = {
      boundOwnedSetupView:
        first !== undefined &&
        isDeepStrictEqual(report?.initial, first) &&
        isDeepStrictEqual(report?.latest, current) &&
        isDeepStrictEqual(fresh, basis) &&
        fresh.accountOwner &&
        fresh.permissionsOwner,
      resolvedReversibleView:
        fresh.scope === expected.scope &&
        fresh.opening === expected.opening &&
        fresh.width === expected.width &&
        !fresh.overflow &&
        fresh.marker === expected.marker &&
        fresh.launchEnabled === expected.launch &&
        fresh.guidance === (hasSetupGuide ? expected.scope : "unknown") &&
        fresh.warningVisible === warning &&
        isDeepStrictEqual(fresh.enabledControls, controlNames),
      preservedOwnedSetupHistory:
        isDeepStrictEqual(final, expectedProfile) &&
        isDeepStrictEqual(report?.decision.priorIds, expectedHistory),
      matchedSetupRoute:
        report?.decision.route === expected.route &&
        report.decision.requestedScope === expected.requestedScope &&
        report.decision.currentId === fresh.current.id &&
        report.decision.launchEnabled === fresh.launchEnabled,
      verifiedStagedSetupHandoff: expected.stage
        ? Boolean(
            handoff &&
            handoff.observation === id &&
            isDeepStrictEqual(handoff, report?.handoff) &&
            isDeepStrictEqual(handoff.decision, report?.decision),
          )
        : !handoff && report?.handoff === null,
    };
    return {
      caseId: world.id,
      goal: world.goal,
      contextId,
      panelId: panel.id,
      source,
      checks,
      journal,
      fresh,
      profile: final,
      handoff: handoff ?? null,
      passed: Object.values(checks).every(Boolean),
    };
  }

  async function qualify() {
    const initial = await openGoogleSetup.observe();
    const rejectsRevision =
      (await openGoogleSetup.apply("different-panel", { kind: "reload" })) ===
      null;
    let latest = initial;
    for (const action of world.expected.actions) {
      const result = await openGoogleSetup.apply(latest.id, action);
      if (!result) throw new Error("Reference setup view action failed");
      latest = result;
    }
    const { route, history: priorIds, requestedScope, stage } = world.expected;
    const decision: SetupDecision = {
      route,
      requestedScope,
      priorIds,
      currentId: latest.current.id,
      launchEnabled: latest.launchEnabled,
      note: "Continue from the verified owned setup evidence.",
    };
    const rejectsAlias =
      (await openGoogleSetup.stage(latest.id, {
        ...decision,
        currentId: "foreign-profile",
      })) === null;
    const handoff = stage
      ? await openGoogleSetup.stage(latest.id, decision)
      : null;
    const outcome = { initial, latest, decision, handoff };
    const report = {
      status: "workspace-skill-reviewed",
      skill: world.kind,
      outcome,
    };
    const result = await verify(report);
    const rejectsRoute = !(
      await verify({
        ...report,
        outcome: {
          ...outcome,
          decision: {
            ...decision,
            route: route === "gmail-ready" ? "account-owner" : "gmail-ready",
          },
        },
      })
    ).passed;
    return {
      ...result,
      checks: { ...result.checks, rejectsRevision, rejectsAlias, rejectsRoute },
      passed: result.passed && rejectsRevision && rejectsAlias && rejectsRoute,
    };
  }

  return { services: { openGoogleSetup }, verify, qualify };
}
