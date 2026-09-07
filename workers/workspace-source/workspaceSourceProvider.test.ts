// Builtin semantic-authority tests.
import { describe, expect, it } from "vitest";
import {
  buildWorktreeManifest,
  canonicalSnapshotDigest,
  sha256Hex,
} from "@vibestudio/content-addressing";
import { createTestDO } from "@vibestudio/durable/test-utils";
import type {
  InitializeExactWorkspaceSnapshotInput,
  WorkspaceSourceInitializationInspection,
} from "@vibestudio/workspace-contracts/workspaceSource";
import { GadWorkspaceDO } from "./index.js";

function effectReceipt(
  inspection: Extract<
    WorkspaceSourceInitializationInspection,
    { state: "initializing" }
  >,
  bytes: Uint8Array,
): Record<string, unknown> {
  const effect = inspection.pendingEffect;
  if (!effect) throw new Error("fixture expected a pending effect");
  if (effect.kind === "observe-content") {
    return {
      files: (effect.payload["files"] as Array<{ contentHash: string }>).map(
        (file) => ({
          contentHash: file.contentHash,
          contentKind: "text",
          byteLength: bytes.byteLength,
          coordinateExtent: new TextDecoder().decode(bytes).length,
        }),
      ),
    };
  }
  if (effect.kind === "materialize-context") {
    const repositories = effect.payload["repositories"] as Array<{
      repositoryId: string;
      repoPath: string;
      presence: "present" | "deleted";
    }>;
    return {
      materializationId: effect.effectId,
      contextId: effect.payload["contextId"],
      targetState: effect.payload["targetState"],
      repositories: repositories
        .filter((repository) => repository.presence === "present")
        .map((repository) => ({
          repositoryId: repository.repositoryId,
          repoPath: repository.repoPath,
          contentRoot: `state:${"0".repeat(64)}`,
        })),
      payloadDigest: effect.payload["payloadDigest"],
    };
  }
  return { applied: true, appliedAt: "2026-07-29T00:00:00.000Z" };
}

describe("WorkspaceSourceProviderV1", () => {
  it("initializes one exact snapshot idempotently through the finite effect protocol", async () => {
    const { instance } = await createTestDO(GadWorkspaceDO, {
      __objectKey: "workspace-one",
      WORKSPACE_ID: "workspace-one",
    });
    const bytes = new TextEncoder().encode("systemEpoch: 59\n");
    const contentHash = sha256Hex(bytes);
    const repositorySnapshot = canonicalSnapshotDigest([
      {
        path: "vibestudio.yml",
        contentHash,
        size: bytes.byteLength,
        mode: 0o100644,
      },
    ]);
    const contentRoot = buildWorktreeManifest([
      { path: "vibestudio.yml", contentHash, mode: 0o100644 },
    ]).stateHash as `state:${string}`;
    const input: InitializeExactWorkspaceSnapshotInput = {
      commandId: "initialize:one",
      pin: {
        url: "git+https://example.test/base.git",
        ref: "refs/tags/v1",
        commit: "1".repeat(40),
        snapshot: `v1-sha256:${"2".repeat(64)}`,
      },
      repositories: [
        {
          repoPath: "meta",
          subdir: "meta",
          snapshot: repositorySnapshot,
          contentRoot,
          files: [{ path: "vibestudio.yml", contentHash, mode: 0o644 }],
        },
        {
          repoPath: "panels/example",
          subdir: "panels/example",
          snapshot: canonicalSnapshotDigest([
            {
              path: "index.tsx",
              contentHash,
              size: bytes.byteLength,
              mode: 0o100644,
            },
          ]),
          contentRoot: buildWorktreeManifest([
            { path: "index.tsx", contentHash, mode: 0o100644 },
          ]).stateHash as `state:${string}`,
          files: [{ path: "index.tsx", contentHash, mode: 0o644 }],
        },
      ],
    };

    let inspection =
      await instance.workspaceSourceInitializeExactSnapshot(input);
    const effectKinds: string[] = [];
    for (
      let step = 0;
      inspection.state === "initializing" && step < 10;
      step += 1
    ) {
      if (!inspection.pendingEffect) {
        inspection =
          await instance.workspaceSourceInitializeExactSnapshot(input);
        continue;
      }
      const effect = inspection.pendingEffect;
      effectKinds.push(effect.kind);
      inspection = await instance.workspaceSourceInitializeExactSnapshot({
        ...input,
        acknowledgement: {
          effectId: effect.effectId,
          payloadDigest: effect.payloadDigest,
          receipt: effectReceipt(
            {
              state: "initializing",
              commandId: input.commandId,
              pendingEffect: effect,
            },
            bytes,
          ),
        },
      });
    }

    expect(inspection).toMatchObject({
      state: "ready",
      commandId: input.commandId,
      receipt: {
        commandId: input.commandId,
        pin: input.pin,
        initializedEventId: expect.any(String),
        initializedStateHash: expect.stringMatching(/^state:[0-9a-f]{64}$/u),
      },
    });
    expect(effectKinds).toEqual(["observe-content", "publish-main"]);
    await expect(
      instance.workspaceSourceInitializeExactSnapshot(input),
    ).resolves.toEqual(inspection);
    expect(instance.workspaceSourceInspectInitialization()).toEqual(inspection);
    expect(instance.workspaceSourceCurrent()).toEqual({
      stateHash:
        inspection.state === "ready"
          ? inspection.receipt.initializedStateHash
          : "unreachable",
    });
    expect(instance.workspaceSourceHealth()).toEqual({
      ok: true,
      protocol: "vibestudio.workspace-source.v1",
    });

    const ensured = (await instance.vcsEnsureContext({
      contextId: "context-after-initialization",
      commandId: "ensure:after-initialization",
      ingress: {
        causalParent: null,
        contextIntegrity: { class: "internal", externalKeys: [] },
      },
    })) as {
      kind: string;
      effects?: Array<{
        payload: { repositories?: Array<{ source?: unknown }> };
      }>;
    };
    expect(ensured.kind).toBe("effects-pending");
    expect(ensured.effects?.[0]?.payload.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: { kind: "content-root", contentRoot },
        }),
        expect.objectContaining({
          source: {
            kind: "content-root",
            contentRoot: buildWorktreeManifest([
              { path: "index.tsx", contentHash, mode: 0o100644 },
            ]).stateHash,
          },
        }),
      ]),
    );
  });

  it("rejects divergent command reuse before changing semantic state", async () => {
    const { instance } = await createTestDO(GadWorkspaceDO, {
      __objectKey: "workspace-two",
      WORKSPACE_ID: "workspace-two",
    });
    const base: InitializeExactWorkspaceSnapshotInput = {
      commandId: "initialize:two",
      pin: {
        url: "git+https://example.test/base.git",
        ref: "refs/tags/v1",
        commit: "4".repeat(40),
        snapshot: `v1-sha256:${"5".repeat(64)}`,
      },
      repositories: [
        {
          repoPath: "meta",
          subdir: "meta",
          snapshot: `v1-sha256:${"6".repeat(64)}`,
          contentRoot: buildWorktreeManifest([]).stateHash as `state:${string}`,
          files: [],
        },
      ],
    };
    await instance.workspaceSourceInitializeExactSnapshot(base);
    await expect(
      instance.workspaceSourceInitializeExactSnapshot({
        ...base,
        pin: { ...base.pin, commit: "7".repeat(40) },
      }),
    ).rejects.toThrow(/command initialize:two was reused/u);
  });
});
