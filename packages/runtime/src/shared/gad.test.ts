import { describe, expect, it, vi } from "vitest";
import { createGadClient } from "./gad.js";

describe("createGadClient", () => {
  it("routes finite GAD inspection methods through the declared workspace service", async () => {
    const rpc = {
      call: vi.fn(async (target: string, method: string) => {
        if (target === "main" && method === "workers.resolveService") {
          return {
            kind: "durable-object",
            source: "vibestudio/internal",
            className: "GadWorkspaceDO",
            objectKey: "workspace",
            targetId: "do:workers/workspace-source:GadWorkspaceDO:workspace",
          };
        }
        if (
          method === "listTrajectoryBranches" ||
          method === "listTrajectoryInvocations"
        ) {
          return [];
        }
        return undefined;
      }),
      stream: vi.fn(),
    };
    const gad = createGadClient(rpc as never);

    await gad.listTrajectoryBranches({ limit: 10 });
    await gad.listTrajectoryInvocations({ branchId: "branch-1", limit: 20 });

    expect(rpc.call).toHaveBeenNthCalledWith(1, "main", "workers.resolveService", [
      "vibestudio.gad.workspace.v1",
      null,
    ]);
    expect(rpc.call).toHaveBeenNthCalledWith(
      2,
      "do:workers/workspace-source:GadWorkspaceDO:workspace",
      "listTrajectoryBranches",
      [{ limit: 10 }]
    );
    expect(rpc.call).toHaveBeenNthCalledWith(
      3,
      "do:workers/workspace-source:GadWorkspaceDO:workspace",
      "listTrajectoryInvocations",
      [{ branchId: "branch-1", limit: 20 }]
    );
  });

  it("keeps semantic envelope reads hydrated while inspection stays compact", async () => {
    const digest = "a".repeat(64);
    const ref = {
      protocol: "vibestudio.blob-ref.v1",
      digest,
      size: 15,
      encoding: "json",
      originalBytes: 15,
    };
    const rpc = {
      call: vi.fn(async (target: string, method: string) => {
        if (target === "main" && method === "workers.resolveService") {
          return {
            kind: "durable-object",
            source: "vibestudio/internal",
            className: "GadWorkspaceDO",
            objectKey: "workspace",
            targetId: "do:workers/workspace-source:GadWorkspaceDO:workspace",
          };
        }
        if (target === "main" && method === "blobstore.getText") {
          return JSON.stringify({ hydrated: true });
        }
        if (method === "readChannelEnvelopes") {
          return {
            pageInfo: {
              request: { window: { kind: "tail" }, limit: 50 },
              returnedCount: 1,
              totalCount: 1,
              firstSeq: 1,
              lastSeq: 1,
              snapshotLastSeq: 1,
              returnedFromSeq: 1,
              returnedToSeq: 1,
              hasMoreBefore: false,
              hasMoreAfter: false,
            },
            items: [
              {
                envelopeId: "env-1",
                channelId: "channel-1",
                seq: 1,
                from: { kind: "panel", id: "panel:user" },
                payloadKind: "custom.kind",
                contentClass: "internal",
                externalKeys: [],
                payload: ref,
                publishedAt: "2026-05-20T12:00:00.000Z",
              },
            ],
          };
        }
        if (method === "inspectChannelEnvelopes") {
          return {
            pageInfo: {
              request: { window: { kind: "tail" }, limit: 50 },
              returnedCount: 1,
              totalCount: 1,
              firstSeq: 1,
              lastSeq: 1,
              snapshotLastSeq: 1,
              returnedFromSeq: 1,
              returnedToSeq: 1,
              hasMoreBefore: false,
              hasMoreAfter: false,
            },
            items: [
              {
                envelopeId: "env-1",
                channelId: "channel-1",
                seq: 1,
                payloadKind: "custom.kind",
                from: { kind: "panel", id: "panel:user" },
                bytes: { from: 1, to: 0, payload: 1, metadata: 0, attachments: 0 },
                payloadSummary: ref,
                storedRefs: [],
                publishedAt: "2026-05-20T12:00:00.000Z",
              },
            ],
          };
        }
        return { rows: [] };
      }),
      stream: vi.fn(),
    };
    const gad = createGadClient(rpc as never);

    await expect(
      gad.readChannelEnvelopes({ channelId: "channel-1", window: { kind: "tail" } })
    ).resolves.toMatchObject({ items: [{ payload: { hydrated: true } }] });
    await expect(gad.inspectChannelEnvelopes({ channelId: "channel-1" })).resolves.toMatchObject({
      items: [{ envelopeId: "env-1", payloadSummary: ref }],
    });
  });

  it("exposes typed durable user-notification consumer and producer calls", async () => {
    const targetId = "do:workers/workspace-source:GadWorkspaceDO:workspace";
    const rpc = {
      call: vi.fn(async (target: string, method: string, args: unknown[]) => {
        if (target === "main" && method === "workers.resolveService") {
          return {
            kind: "durable-object",
            source: "vibestudio/internal",
            className: "GadWorkspaceDO",
            objectKey: "workspace",
            targetId,
          };
        }
        if (method === "listUserNotificationsForMe") {
          return {
            notifications: [
              {
                id: "channel.invite:channel-1",
                userId: "usr_bob",
                kind: "channel.invite",
                title: "Channel invitation",
                createdAt: 1,
                revision: 1,
              },
            ],
          };
        }
        if (method === "acknowledgeUserNotification") return { acknowledged: true };
        if (method === "putUserNotification") return args[0];
        if (method === "deleteUserNotification") return { deleted: true };
        throw new Error(`unexpected call ${target}.${method}`);
      }),
      stream: vi.fn(),
    };
    const gad = createGadClient(rpc as never);

    await expect(gad.listUserNotificationsForMe()).resolves.toMatchObject([
      { id: "channel.invite:channel-1", userId: "usr_bob" },
    ]);
    await expect(gad.acknowledgeUserNotification("channel.invite:channel-1")).resolves.toBe(true);
    const generic = {
      id: "build:42",
      userId: "usr_bob",
      kind: "build.completed",
      title: "Build complete",
      createdAt: 42,
      revision: 1,
    };
    await expect(gad.putUserNotification(generic)).resolves.toEqual(generic);
    await expect(gad.deleteUserNotification("usr_bob", "build:42")).resolves.toBe(true);
    expect(rpc.call).toHaveBeenCalledWith(targetId, "listUserNotificationsForMe", []);
    expect(rpc.call).toHaveBeenCalledWith(targetId, "acknowledgeUserNotification", [
      { id: "channel.invite:channel-1" },
    ]);
    expect(rpc.call).toHaveBeenCalledWith(targetId, "putUserNotification", [generic]);
    expect(rpc.call).toHaveBeenCalledWith(targetId, "deleteUserNotification", [
      { userId: "usr_bob", id: "build:42" },
    ]);
  });
});
