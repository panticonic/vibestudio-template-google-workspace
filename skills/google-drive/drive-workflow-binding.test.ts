import { describe, expect, it, vi } from "vitest";
import type { DriveClient } from "@workspace/google-workspace";
import type { GoogleDriveOnboardingStatus } from "./index.js";
import { createGoogleWorkspaceRead } from "./drive-workflow-binding.js";
import eligibleRows from "./driveWorkflow/guideGoogleWorkspace/inspectFolder/eligibleRows.js";
import latestChanges from "./driveWorkflow/guideGoogleWorkspace/continueSync/latestChanges.js";
import {
  googleWorkflowWorlds,
  verifyGoogleWorkflowOutcome,
  type GoogleWorkflowWorld,
} from "./drive-workflow-worlds.js";

function localFixture(world: GoogleWorkflowWorld) {
  const stages = {
    "needs-setup": "needs-setup",
    "needs-consent": "ready-to-connect",
    "needs-verification": "connected",
    "needs-drive-scope": "verified",
    "verification-failed": "verified",
    ready: "verified",
  } as const;
  const state = world.state;
  const verified = state === "ready";
  const fixtureStatus: GoogleDriveOnboardingStatus = {
    stage: verified
      ? "ready"
      : state === "verification-failed"
        ? "error"
        : "needs-google-workspace",
    connected: verified || state === "verification-failed",
    verified,
    credentialId: "caller-owned",
    googleWorkspace: {
      stage: stages[state],
      connected: state !== "needs-setup" && state !== "needs-consent",
      configured: state !== "needs-setup",
      readyToConnect: state !== "needs-setup",
      credentials: [],
      nextActions: [],
      warnings: [],
    },
    credentials: [],
    nextActions: [],
    warnings: [],
  };
  let calls = 0;
  async function page() {
    const body = world.pages[calls++];
    if (!body) throw new Error("Fixture page unavailable");
    return structuredClone(body);
  }
  const client = {
    listFiles: vi.fn(page) as unknown as DriveClient["listFiles"],
    listPermissions: vi.fn(page) as unknown as DriveClient["listPermissions"],
    listChanges: vi.fn(page) as unknown as DriveClient["listChanges"],
  };
  const drive = vi.fn(() => client as DriveClient);
  const inspect = vi.fn(async () => structuredClone(fixtureStatus));
  const binding = createGoogleWorkspaceRead(world.assignment, {
    inspect,
    drive,
  });
  return { binding, inspect, drive, client, calls: () => calls };
}

describe("Google Workspace workflow worlds", () => {
  it.each<GoogleWorkflowWorld>(googleWorkflowWorlds)(
    "binds $id to an assigned read and verifies exact outcome fields",
    async (world) => {
      const fixture = localFixture(world);
      const { binding, inspect, drive } = fixture;
      const request = world.request;
      expect(await binding.readiness()).toEqual({ state: world.state });
      expect(inspect).toHaveBeenCalledWith({ verify: true });
      if (world.state === "ready") {
        expect(drive).toHaveBeenCalledWith({ credentialId: "caller-owned" });
        let token = request.kind === "sync" ? request.cursor : null;
        for (const expectedPage of world.pages) {
          const promise =
            request.kind === "sync" && token !== null
              ? binding.readChanges(token)
              : request.kind === "inventory"
                ? binding.listFolder(request.folderId, token)
                : request.kind === "sharing"
                  ? binding.readPermissions(request.fileId, token)
                  : Promise.reject(new Error("No page read for setup"));
          if (!expectedPage) {
            await expect(promise).rejects.toThrow("Fixture page unavailable");
            continue;
          }
          const page = await promise;
          expect(page.next).toBe(expectedPage["nextPageToken"] ?? null);
          token = page.next;
        }
      } else {
        expect(drive).not.toHaveBeenCalled();
        if (request.kind === "inventory")
          await expect(
            binding.listFolder(request.folderId, null),
          ).rejects.toThrow("Verify");
        if (request.kind === "sharing")
          await expect(
            binding.readPermissions(request.fileId, null),
          ).rejects.toThrow("Verify");
      }
      expect(fixture.calls()).toBe(world.pages.length);
      const reference = {
        ...world.expected,
        findings: ["Independent reference report"],
      };
      expect(verifyGoogleWorkflowOutcome(world, reference)).toBe(true);
      expect(
        verifyGoogleWorkflowOutcome(world, {
          ...reference,
          ids: [...reference.ids, "wrong-audience"],
        }),
      ).toBe(false);
      expect(
        verifyGoogleWorkflowOutcome(world, {
          ...reference,
          checkpoint: "unobserved-cursor",
        }),
      ).toBe(false);
    },
  );

  it("admits one concurrent read for a returned cursor and keeps other resources outside the assignment", async () => {
    const example = googleWorkflowWorlds.find(
      (world) => world.id === "sharing-board-packet",
    )!;
    const { binding, client } = localFixture(example);
    await binding.readiness();
    await expect(binding.readPermissions("other-file", null)).rejects.toThrow(
      "outside",
    );
    await expect(
      binding.readPermissions("board-packet", "forged-token"),
    ).rejects.toThrow("outside");
    expect(await binding.readPermissions("board-packet", null)).toMatchObject({
      next: "packet-tail",
    });
    const attempts = await Promise.allSettled([
      binding.readPermissions("board-packet", "packet-tail"),
      binding.readPermissions("board-packet", "packet-tail"),
    ]);
    expect(attempts.map((attempt) => attempt.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(client.listPermissions).toHaveBeenCalledTimes(2);
  });
});

it("uses observed dates and source IDs for exact folder eligibility and folds final change state in receipt order", async () => {
  const inventory = googleWorkflowWorlds[0]!;
  const request = inventory.request;
  if (request.kind !== "inventory")
    throw new Error("Expected the inventory source");
  const { binding } = localFixture(inventory);
  await binding.readiness();
  const first = await binding.listFolder(request.folderId, null);
  const second = await binding.listFolder(request.folderId, first.next);
  expect(
    eligibleRows(request, [...first.rows, ...second.rows]).map((row) => row.id),
  ).toEqual(["budget-q2", "budget-q3"]);
  const sync = googleWorkflowWorlds.find(
    (world) => world.id === "sync-resolved-moves",
  )!;
  const changeRequest = sync.request;
  if (changeRequest.kind !== "sync")
    throw new Error("Expected the change feed source");
  const feed = localFixture(sync).binding;
  await feed.readiness();
  const earlier = await feed.readChanges(changeRequest.cursor);
  const final = await feed.readChanges(earlier.next!);
  expect(
    latestChanges([...earlier.rows, ...final.rows]).map(
      ({ fileId, removed }) => [fileId, removed],
    ),
  ).toEqual([
    ["manual", true],
    ["old-faq", true],
    ["faq", false],
  ]);
});
