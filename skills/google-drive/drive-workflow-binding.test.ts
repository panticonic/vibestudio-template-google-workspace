import { describe, expect, it } from "vitest";
import { createGoogleWorkflowFixture } from "./drive-workflow-fixture.js";
import eligibleRows from "./driveWorkflow/guideGoogleWorkspace/inspectFolder/eligibleRows.js";
import latestChanges from "./driveWorkflow/guideGoogleWorkspace/continueSync/latestChanges.js";
import {
  googleWorkflowWorlds,
  verifyGoogleWorkflowOutcome,
  type GoogleWorkflowWorld,
} from "./drive-workflow-worlds.js";

describe("Google Workspace workflow worlds", () => {
  it.each<GoogleWorkflowWorld>(googleWorkflowWorlds)(
    "binds $id to an assigned read and verifies exact outcome fields",
    async (world) => {
      const fixture = createGoogleWorkflowFixture(world);
      const { binding, readinessReads, credentialReads } = fixture;
      const request = world.request;
      expect(await binding.readiness()).toEqual({ state: world.state });
      expect(readinessReads).toEqual([{ verify: true }]);
      if (world.state === "ready") {
        expect(credentialReads).toEqual(["caller-owned"]);
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
        expect(credentialReads).toEqual([]);
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

  it("joins concurrent reads for a returned cursor and keeps other resources outside the assignment", async () => {
    const example = googleWorkflowWorlds.find(
      (world) => world.id === "sharing-board-packet",
    )!;
    const { binding, calls } = createGoogleWorkflowFixture(example);
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
      "fulfilled",
    ]);
    expect(calls()).toBe(2);
    await expect(binding.readPermissions("board-packet", "packet-tail")).resolves.toMatchObject({ next: null });
    expect(calls()).toBe(3);
  });
});

it("uses observed dates and source IDs for exact folder eligibility and folds final change state in receipt order", async () => {
  const inventory = googleWorkflowWorlds[0]!;
  const request = inventory.request;
  if (request.kind !== "inventory")
    throw new Error("Expected the inventory source");
  const { binding } = createGoogleWorkflowFixture(inventory);
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
  const feed = createGoogleWorkflowFixture(sync).binding;
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
